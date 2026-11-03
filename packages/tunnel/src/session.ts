import { CLOSE_PROTOCOL, TunnelClosedError, TunnelError } from './errors.js';
import {
  FLAG_END,
  FLAG_TEXT,
  FrameError,
  FrameType,
  MAX_BODY_BYTES,
  decodeFrame,
  encodeFrame,
  frameTypeName,
  type Frame,
  type FrameHeader,
  type FrameInit,
} from './frames.js';
import { NoiseNonceExhaustedError, type TransportCiphers } from './noise.js';
import type { ByteTransport } from './transport.js';

// The multiplexer both ends of a tunnel share once the handshake is done
// (RELAY_PROTOCOL.md sections 5.2 and 5.3). A TunnelSession owns the
// transport and the two transport CipherStates: it encrypts and decrypts
// frames, answers pings, handles the stream-level `error` on id 0, keeps the
// flow control window of every open id, and routes the rest to a Channel's
// handler. What a frame means for a request or a socket is up to the client
// (client.ts) and the server (server.ts).
//
// Flow control: each open id has a window per direction, 1 MiB at open,
// counting body bytes only. A sender waits in `Channel.acquire` until the
// peer's `credit` frames reopen it. A receiver counts what it has received and
// what its consumer has taken, and sends `credit` once a quarter of the window
// has been consumed (and when a body completes). A peer that sends past the
// window is a protocol error.
//
// Late frames are expected: after one side cancels an id, frames the other
// sent before it heard are still in flight. Frames for an id that was opened
// and has since closed are dropped; frames for an id that was never opened are
// a protocol error.
//
// Keepalive (spec 5.3): each side sends a `ping` on id 0 once it has sent
// nothing for 25 seconds, and closes the stream 1000 once it has received no
// frame at all for 60 seconds. Both are options (`KeepaliveOptions`).

export interface TunnelLimits {
  /** The flow control window per id per direction, in body bytes. */
  windowBytes: number;
  /** Open requests and sockets per stream. */
  maxOpenIds: number;
  /** The largest request body; more is refused with `too_large`. */
  maxRequestBodyBytes: number;
  /** The largest WebSocket message, after reassembly. */
  maxMessageBytes: number;
  /** Transport messages per direction before the stream closes 4400. */
  maxMessages: number;
  /**
   * WebSocket bytes one socket may queue behind a shut window, beyond the
   * message being sent; past it the socket is closed 1008 (spec 5.3).
   */
  maxQueuedBytes: number;
}

/** When a side pings an idle stream, and when it gives up on one (spec 5.3). 0 turns either off. */
export interface KeepaliveOptions {
  /** A `ping` goes out once nothing has been sent for this long. */
  pingIntervalMs: number;
  /** The stream is closed 1000 once nothing at all has been received for this long. */
  idleTimeoutMs: number;
}

export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** The close code and reason of a stream that went quiet. */
export const CLOSE_IDLE = 1000;
export const IDLE_REASON = 'idle';
/** The close code of a WebSocket whose send queue passed `maxQueuedBytes`. */
export const CLOSE_QUEUE_FULL = 1008;

/** What the Headers constructor takes (the DOM's HeadersInit, which a Node-only lib does not name). */
export type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
/** What fetch takes as a body. */
export type BodyInit = NonNullable<RequestInit['body']>;

/** The one route an unknown device may call (spec 5.1). */
export const PAIR_PATH = '/api/v1/devices/pair';

export const DEFAULT_LIMITS: Readonly<TunnelLimits> = Object.freeze({
  windowBytes: 1_048_576,
  maxOpenIds: 64,
  maxRequestBodyBytes: 16 * 1024 * 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxMessages: 2 ** 32,
  maxQueuedBytes: 8 * 1024 * 1024,
});

/** A frame that is well formed but wrong for the id's state. Answered with a stream-level `protocol` error. */
export class ProtocolViolation extends FrameError {
  override name = 'ProtocolViolation';
}

/** What a client or server does with the frames of one id. */
export interface ChannelHandler {
  onFrame(frame: Frame): void;
  /** The id is gone: the peer sent `error` on it, or the whole stream failed or closed. */
  onError(error: Error): void;
}

const BODY_TYPES = new Set<number>([
  FrameType.HttpReq,
  FrameType.HttpBody,
  FrameType.HttpRes,
  FrameType.WsMsg,
]);

/** One open id. */
export class Channel {
  readonly id: number;
  handler: ChannelHandler;
  /** False once the id is released; nothing more is sent for it. */
  open = true;
  /** Bytes this side may still send before the peer credits more. */
  #available: number;
  readonly #windowBytes: number;
  #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  #failure: Error | null = null;
  /** Body bytes received and not yet credited back. */
  received = 0;
  /** Body bytes the consumer has taken and that have not been credited yet. */
  consumedPending = 0;
  /** Serialises sends on this id (WebSocket messages, then the close). */
  sendChain: Promise<void> = Promise.resolve();

  constructor(id: number, windowBytes: number, handler: ChannelHandler) {
    this.id = id;
    this.#available = windowBytes;
    this.#windowBytes = windowBytes;
    this.handler = handler;
  }

  /** Waits for window and takes up to `max` bytes of it (at least 1). */
  async acquire(max: number): Promise<number> {
    while (this.#available === 0) {
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }
    if (this.#failure) throw this.#failure;
    const granted = Math.min(max, this.#available);
    this.#available -= granted;
    return granted;
  }

  credit(bytes: number): void {
    if (this.#available + bytes > this.#windowBytes) {
      throw new ProtocolViolation(
        `credit of ${bytes} bytes on id ${this.id} opens the window past its size`,
      );
    }
    this.#available += bytes;
    this.#wake();
  }

  fail(error: Error): void {
    this.#failure ??= error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }
}

export interface SessionOptions {
  /** The client opens odd ids; the server accepts them. */
  role: 'client' | 'server';
  transport: ByteTransport;
  ciphers: TransportCiphers;
  limits: TunnelLimits;
  /** Server only: a frame that opens a new id. Returns the handler for the id. */
  accept?: (frame: Frame, channel: Channel) => ChannelHandler;
  /** Called each time an id is released. */
  onRelease?: (channel: Channel) => void;
  keepalive?: Partial<KeepaliveOptions>;
}

interface PendingPing {
  ts: number;
  sent: number;
  resolve: (rtt: number) => void;
  reject: (error: Error) => void;
}

export class TunnelSession {
  readonly role: 'client' | 'server';
  readonly limits: TunnelLimits;
  readonly #transport: ByteTransport;
  readonly #ciphers: TransportCiphers;
  readonly #accept: SessionOptions['accept'];
  readonly #channels = new Map<number, Channel>();
  #highestPeerId = 0;
  #nextLocalId = 1;
  #closed: { code: number; reason: string } | null = null;
  #closeHandlers = new Set<(code: number, reason: string) => void>();
  #pings: PendingPing[] = [];
  readonly #onRelease: SessionOptions['onRelease'];
  readonly #keepalive: KeepaliveOptions;
  #lastSent = Date.now();
  #lastReceived = Date.now();
  #keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SessionOptions) {
    this.role = options.role;
    this.limits = options.limits;
    this.#transport = options.transport;
    this.#ciphers = options.ciphers;
    this.#accept = options.accept;
    this.#onRelease = options.onRelease;
    this.#keepalive = {
      pingIntervalMs: options.keepalive?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      idleTimeoutMs: options.keepalive?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    const periods = [this.#keepalive.pingIntervalMs, this.#keepalive.idleTimeoutMs].filter(
      (ms) => ms > 0,
    );
    if (periods.length) {
      // A fifth of the shorter period: a ping or an idle close is at most that late.
      const tick = Math.max(1, Math.floor(Math.min(...periods) / 5));
      this.#keepaliveTimer = setInterval(() => this.#tick(), tick);
      (this.#keepaliveTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Pings a stream this side has been quiet on, and closes one the peer has been quiet on. */
  #tick(): void {
    if (this.#closed) return;
    const now = Date.now();
    const { pingIntervalMs, idleTimeoutMs } = this.#keepalive;
    if (idleTimeoutMs > 0 && now - this.#lastReceived >= idleTimeoutMs) {
      this.close(CLOSE_IDLE, IDLE_REASON);
      return;
    }
    if (pingIntervalMs > 0 && now - this.#lastSent >= pingIntervalMs) {
      try {
        // Not one of `ping()`'s: the pong only counts as a frame received.
        this.send({ type: FrameType.Ping, id: 0, header: { ts: now } });
      } catch {
        // The stream closed meanwhile.
      }
    }
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** The close code and reason, once closed. */
  get closeInfo(): { code: number; reason: string } | null {
    return this.#closed;
  }

  get openCount(): number {
    return this.#channels.size;
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    if (this.#closed) {
      const { code, reason } = this.#closed;
      queueMicrotask(() => handler(code, reason));
      return () => {};
    }
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  /** Client only: opens the next odd id. Throws `too_many_requests` when the stream is full. */
  openLocal(handler: ChannelHandler): Channel {
    if (this.#closed) throw new TunnelClosedError(this.#closed.code, this.#closed.reason);
    if (this.#channels.size >= this.limits.maxOpenIds) {
      throw new TunnelError(
        'too_many_requests',
        `this stream already has ${this.limits.maxOpenIds} open requests`,
      );
    }
    const id = this.#nextLocalId;
    this.#nextLocalId += 2;
    const channel = new Channel(id, this.limits.windowBytes, handler);
    this.#channels.set(id, channel);
    return channel;
  }

  /** Encrypts and sends one frame. Throws once the stream is closed. */
  send(init: FrameInit): void {
    if (this.#closed) throw new TunnelClosedError(this.#closed.code, this.#closed.reason);
    const plaintext = encodeFrame(init);
    let message: Uint8Array;
    try {
      message = this.#ciphers.send.encrypt(plaintext);
    } catch (error) {
      if (error instanceof NoiseNonceExhaustedError) {
        this.#shutdown(
          new TunnelClosedError(CLOSE_PROTOCOL, 'noise counter exhausted'),
          CLOSE_PROTOCOL,
          'noise counter exhausted',
        );
        throw new TunnelClosedError(CLOSE_PROTOCOL, 'noise counter exhausted');
      }
      throw error;
    }
    this.#lastSent = Date.now();
    this.#transport.send(message);
  }

  /**
   * Sends body bytes on an id as frames of `type`, as large as a frame allows
   * and the window permits, waiting for credit as needed. END (when `end`)
   * goes on the last frame; TEXT (when `text`) on every one.
   */
  async sendData(
    channel: Channel,
    type: FrameType,
    data: Uint8Array,
    { end, text = false }: { end: boolean; text?: boolean },
  ): Promise<void> {
    const textFlag = text ? FLAG_TEXT : 0;
    if (data.length === 0) {
      if (end) this.#sendOn(channel, { type, id: channel.id, flags: FLAG_END | textFlag });
      return;
    }
    let offset = 0;
    while (offset < data.length) {
      const granted = await channel.acquire(Math.min(MAX_BODY_BYTES, data.length - offset));
      const chunk = data.subarray(offset, offset + granted);
      offset += granted;
      const last = offset === data.length;
      this.#sendOn(channel, {
        type,
        id: channel.id,
        flags: (last && end ? FLAG_END : 0) | textFlag,
        body: chunk,
      });
    }
  }

  /** Sends a frame on an id that is still open. */
  #sendOn(channel: Channel, init: FrameInit): void {
    if (!channel.open) throw new TunnelError('cancelled', `id ${channel.id} is closed`);
    this.send(init);
  }

  /** Sends a frame on an open id; a no-op once the id or the stream is gone. */
  sendIfOpen(channel: Channel, init: FrameInit): boolean {
    if (!channel.open || this.#closed) return false;
    this.send(init);
    return true;
  }

  /** The consumer took `bytes` of body received on this id. */
  consumed(channel: Channel, bytes: number): void {
    if (!channel.open || bytes <= 0) return;
    channel.consumedPending += bytes;
    if (channel.consumedPending >= this.limits.windowBytes / 4) this.flushCredit(channel);
  }

  /** Credits everything consumed so far on this id. */
  flushCredit(channel: Channel): void {
    if (!channel.open || this.#closed || channel.consumedPending === 0) return;
    const bytes = channel.consumedPending;
    channel.consumedPending = 0;
    channel.received -= bytes;
    this.send({ type: FrameType.Credit, id: channel.id, header: { bytes } });
  }

  /** Forgets an id: nothing more is sent for it and late frames for it are dropped. */
  release(
    channel: Channel,
    error: Error = new TunnelError('cancelled', `id ${channel.id} is closed`),
  ): void {
    if (!channel.open) return;
    channel.open = false;
    this.#channels.delete(channel.id);
    channel.fail(error);
    this.#onRelease?.(channel);
  }

  /** Sends `error` on an id and releases it. */
  sendError(channel: Channel, code: string, message: string): void {
    if (!channel.open) return;
    if (!this.#closed)
      this.send({ type: FrameType.Error, id: channel.id, header: { code, message } });
    this.release(channel, new TunnelError(code, message));
  }

  /** Answers a broken frame: a stream-level `protocol` error, then a close with 4400. */
  protocolError(message: string): void {
    this.#fatal('protocol', message);
  }

  #fatal(code: string, message: string): void {
    if (this.#closed) return;
    try {
      this.send({ type: FrameType.Error, id: 0, header: { code, message } });
    } catch {
      // The stream is already unusable; closing it is all that is left.
    }
    this.#shutdown(new TunnelError(code, message), CLOSE_PROTOCOL, code);
  }

  /** Round trip time in milliseconds of a `ping` on id 0. */
  ping(): Promise<number> {
    return new Promise((resolve, reject) => {
      const ts = Date.now();
      try {
        this.send({ type: FrameType.Ping, id: 0, header: { ts } });
      } catch (error) {
        reject(error as Error);
        return;
      }
      this.#pings.push({ ts, sent: Date.now(), resolve, reject });
    });
  }

  close(code = 1000, reason = ''): void {
    this.#shutdown(new TunnelClosedError(code, reason), code, reason);
  }

  /** The transport closed under the session. */
  transportClosed(code: number, reason: string): void {
    if (this.#closed) return;
    this.#finish(new TunnelClosedError(code, reason), code, reason);
  }

  #shutdown(error: Error, code: number, reason: string): void {
    if (this.#closed) return;
    this.#finish(error, code, reason);
    this.#transport.close(code, reason);
  }

  #finish(error: Error, code: number, reason: string): void {
    this.#closed = { code, reason };
    clearInterval(this.#keepaliveTimer);
    const channels = [...this.#channels.values()];
    for (const channel of channels) {
      this.release(channel, error);
      channel.handler.onError(error);
    }
    const pings = this.#pings;
    this.#pings = [];
    for (const ping of pings) ping.reject(error);
    const handlers = [...this.#closeHandlers];
    this.#closeHandlers.clear();
    for (const handler of handlers) handler(code, reason);
  }

  /** One transport message from the peer. */
  receive(message: Uint8Array): void {
    if (this.#closed) return;
    this.#lastReceived = Date.now();
    let plaintext: Uint8Array;
    try {
      plaintext = this.#ciphers.receive.decrypt(message);
    } catch (error) {
      const reason =
        error instanceof NoiseNonceExhaustedError ? 'noise counter exhausted' : 'decryption failed';
      this.#shutdown(new TunnelClosedError(CLOSE_PROTOCOL, reason), CLOSE_PROTOCOL, reason);
      return;
    }
    try {
      this.#dispatch(decodeFrame(plaintext));
    } catch (error) {
      if (error instanceof FrameError) this.protocolError(error.message);
      else this.#fatal('internal', (error as Error).message ?? 'internal error');
    }
  }

  #dispatch(frame: Frame): void {
    if (frame.id === 0) {
      this.#streamFrame(frame);
      return;
    }
    if (frame.id % 2 === 0)
      throw new ProtocolViolation(`id ${frame.id} is even; version 1 opens odd ids only`);
    const channel = this.#channels.get(frame.id);
    if (frame.type === FrameType.Credit) {
      const bytes = frame.header?.bytes;
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new ProtocolViolation('credit needs a positive integer `bytes`');
      }
      channel?.credit(bytes);
      return;
    }
    if (!channel) {
      this.#orphan(frame);
      return;
    }
    if (frame.type === FrameType.Error) {
      const error = peerError(frame.header);
      this.release(channel, error);
      channel.handler.onError(error);
      return;
    }
    if (BODY_TYPES.has(frame.type)) this.#countReceived(channel, frame.body.length);
    channel.handler.onFrame(frame);
  }

  #countReceived(channel: Channel, bytes: number): void {
    channel.received += bytes;
    if (channel.received > this.limits.windowBytes) {
      throw new ProtocolViolation(`id ${channel.id} sent past its flow control window`);
    }
  }

  /** A frame for an id with no open channel. */
  #orphan(frame: Frame): void {
    const opens = frame.type === FrameType.HttpReq || frame.type === FrameType.WsOpen;
    if (this.role === 'server' && opens) {
      if (frame.id <= this.#highestPeerId)
        throw new ProtocolViolation(`id ${frame.id} was already used`);
      this.#highestPeerId = frame.id;
      if (this.#channels.size >= this.limits.maxOpenIds) {
        this.send({
          type: FrameType.Error,
          id: frame.id,
          header: {
            code: 'too_many_requests',
            message: `at most ${this.limits.maxOpenIds} open requests per stream`,
          },
        });
        return;
      }
      const channel = new Channel(frame.id, this.limits.windowBytes, IGNORE);
      this.#channels.set(frame.id, channel);
      this.#countReceived(channel, frame.body.length);
      channel.handler = this.#accept!(frame, channel);
      return;
    }
    const retired =
      this.role === 'server' ? frame.id <= this.#highestPeerId : frame.id < this.#nextLocalId;
    if (retired || frame.type === FrameType.Error) return;
    throw new ProtocolViolation(
      `${frameTypeName(frame.type)} for id ${frame.id}, which was never opened`,
    );
  }

  #streamFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameType.Ping: {
        if (typeof frame.header?.ts !== 'number')
          throw new ProtocolViolation('ping needs a numeric `ts`');
        this.send({ type: FrameType.Pong, id: 0, header: frame.header });
        return;
      }
      case FrameType.Pong: {
        const ts = frame.header?.ts;
        const index = this.#pings.findIndex((ping) => ping.ts === ts);
        if (index >= 0) {
          const [ping] = this.#pings.splice(index, 1);
          ping!.resolve(Date.now() - ping!.sent);
        }
        return;
      }
      case FrameType.Error: {
        const error = peerError(frame.header);
        this.#shutdown(error, CLOSE_PROTOCOL, String(error.code));
        return;
      }
      default:
        throw new ProtocolViolation(`${frameTypeName(frame.type)} is not allowed on id 0`);
    }
  }
}

const IGNORE: ChannelHandler = { onFrame() {}, onError() {} };

function peerError(header: FrameHeader | null): TunnelError {
  const code = typeof header?.code === 'string' ? header.code : 'protocol';
  const message = typeof header?.message === 'string' ? header.message : '';
  return new TunnelError(code, message);
}

// Header helpers shared by the client and the server.

/** Reads a `headers` object of a frame header: string values, names lower cased. */
export function readHeaderMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolViolation(`${what} headers must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string')
      throw new ProtocolViolation(`${what} header ${name} is not a string`);
    out[name.toLowerCase()] = headerValue;
  }
  return out;
}

/** A Headers init as the plain lower case map the frames carry, less the names in `drop`. */
export function headerMap(
  init: HeadersInit | undefined,
  drop?: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    if (!drop?.(name)) out[name] = value;
  });
  return out;
}

export function readStatus(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new ProtocolViolation('http.res needs an integer `status` from 100 to 599');
  }
  return value;
}

/**
 * A close code that may travel in a close frame (RFC 6455 section 7.4): 1000
 * to 1014 less the reserved 1004, 1005 and 1006, or 3000 to 4999. Anything
 * else becomes 1000.
 */
export function wireCloseCode(code: unknown): number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  return 1000;
}

export function readClose(header: FrameHeader | null): { code: number; reason: string } {
  const code = header?.code;
  const reason = header?.reason;
  if (code !== undefined && (typeof code !== 'number' || !Number.isInteger(code))) {
    throw new ProtocolViolation('ws.close `code` must be an integer');
  }
  if (reason !== undefined && typeof reason !== 'string')
    throw new ProtocolViolation('ws.close `reason` must be a string');
  return { code: code ?? 1005, reason: reason ?? '' };
}

const NO_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** Statuses a web Response may not carry a body with. */
export function isNullBodyStatus(status: number): boolean {
  return NO_BODY_STATUS.has(status);
}

/**
 * A received body as a web ReadableStream. Chunks wait in a queue until the
 * reader pulls them, and only a pull counts as consumed (and so as credit for
 * the sender), which is what makes a slow reader slow the sender down.
 */
export class BodyQueue {
  readonly stream: ReadableStream<Uint8Array>;
  #queue: Uint8Array[] = [];
  #ended = false;
  #error: Error | null = null;
  #discarding = false;
  #wake: (() => void) | null = null;
  readonly #onConsumed: (bytes: number) => void;
  readonly #onEnd: () => void;

  constructor(options: {
    onConsumed: (bytes: number) => void;
    /** The reader has taken the last chunk. */
    onEnd?: () => void;
    /** The reader cancelled the stream. */
    onCancel?: (reason: unknown) => void;
  }) {
    this.#onConsumed = options.onConsumed;
    this.#onEnd = options.onEnd ?? (() => {});
    const onCancel = options.onCancel ?? (() => {});
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            if (this.#error) {
              controller.error(this.#error);
              return;
            }
            const chunk = this.#queue.shift();
            if (chunk) {
              if (chunk.length === 0) continue;
              this.#onConsumed(chunk.length);
              controller.enqueue(chunk);
              return;
            }
            if (this.#ended) {
              controller.close();
              this.#onEnd();
              return;
            }
            await new Promise<void>((resolve) => (this.#wake = resolve));
          }
        },
        cancel: (reason) => {
          this.discard();
          onCancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  }

  get ended(): boolean {
    return this.#ended;
  }

  push(chunk: Uint8Array): void {
    if (this.#ended || this.#error) return;
    if (this.#discarding) {
      this.#onConsumed(chunk.length);
      return;
    }
    // A copy, since the frame's body is a view into a decrypted buffer.
    this.#queue.push(chunk.slice());
    this.#notify();
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#discarding) this.#onEnd();
    this.#notify();
  }

  fail(error: Error): void {
    if (this.#error || (this.#ended && !this.#queue.length)) return;
    this.#error = error;
    this.#queue = [];
    this.#notify();
  }

  /** Nobody will read the rest: count what is queued and what still arrives as consumed at once. */
  discard(): void {
    if (this.#discarding) return;
    this.#discarding = true;
    const queued = this.#queue;
    this.#queue = [];
    for (const chunk of queued) this.#onConsumed(chunk.length);
    if (this.#ended) this.#onEnd();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/** Joins the `ws.msg` frames of one WebSocket message (END on the last). */
export class MessageAssembler {
  #parts: Uint8Array[] = [];
  #bytes = 0;
  #text: boolean | null = null;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  /** Adds a fragment; returns the whole message once END arrives. Throws `too_large` past the limit. */
  push(frame: Frame): { text: boolean; data: Uint8Array } | null {
    const text = (frame.flags & FLAG_TEXT) !== 0;
    if (this.#text !== null && this.#text !== text) {
      throw new ProtocolViolation('a WebSocket message changed between text and binary');
    }
    this.#text = text;
    this.#bytes += frame.body.length;
    if (this.#bytes > this.#maxBytes) {
      throw new TunnelError(
        'too_large',
        `a WebSocket message of more than ${this.#maxBytes} bytes`,
      );
    }
    this.#parts.push(frame.body.slice());
    if ((frame.flags & FLAG_END) === 0) return null;
    const parts = this.#parts;
    const length = this.#bytes;
    this.#parts = [];
    this.#bytes = 0;
    this.#text = null;
    if (parts.length === 1) return { text, data: parts[0]! };
    const data = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    return { text, data };
  }
}

/** Reads a web stream to the end, calling `onChunk` for each chunk in order. Cancels the stream when `onChunk` throws. */
export async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) await onChunk(value);
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();
