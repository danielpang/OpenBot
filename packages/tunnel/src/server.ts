import { TunnelError } from './errors.js';
import { FLAG_END, FrameType, frameTypeName, type Frame } from './frames.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  TransportRoute,
  runResponderHandshake,
  type DeviceStatus,
} from './handshake.js';
import {
  BodyQueue,
  CLOSE_QUEUE_FULL,
  DEFAULT_LIMITS,
  MessageAssembler,
  PAIR_PATH,
  ProtocolViolation,
  TunnelSession,
  headerMap,
  pumpStream,
  readClose,
  readHeaderMap,
  wireCloseCode,
  textDecoder,
  textEncoder,
  type Channel,
  type ChannelHandler,
  type KeepaliveOptions,
  type TunnelLimits,
} from './session.js';
import type { ByteTransport } from './transport.js';

// The server side of the tunnel (RELAY_PROTOCOL.md sections 5.1 to 5.4).
// `createTunnelServer` answers the client's handshake as the Noise responder,
// asks `lookupDevice` whether the client's static key belongs to a paired
// device, and then serves the stream's frames:
//
// - `http.req` becomes a web Request with a streaming body for
//   `handler.fetch`, and the Response goes back as `http.res` and `http.body`
//   frames under the credit window.
// - `ws.open` goes to `handler.openSocket`; a ServerSocket is answered with
//   `ws.opened` and its messages are piped both ways, and a Response (a
//   refused upgrade) goes back as an HTTP response.
//
// A stream from an unknown device serves pairing only: every request but
// `POST /api/v1/devices/pair` gets 403 `DEVICE_UNKNOWN` without reaching the
// handler. When that pairing answers 200, the session looks the client's key
// up again and, now that it is known, serves anything from then on. Such a
// stream has a short life, since anyone who knows the server's key can open
// one: it closes 4400 once its first pairing request has been answered (if
// that did not make the device known), or 30 seconds after the handshake,
// whichever is first (`unknownDeviceLifetimeMs`).
//
// Headers cross in both directions less the names spec 5.4 lists (and less
// `x-openbots-device` from the client, which only the adapter may set), so the
// handler can forward the Request to the server's own port as it is.
//
// `drain` ends a stream gently: every request and `ws.open` from then on is
// refused at once, and the stream closes once the HTTP responses already in
// flight have been sent, or after a bound. A device that revokes itself over
// its own stream so still gets its 204. Open WebSockets are not waited for;
// they close with the stream.
//
// A WebSocket the handler opened may queue at most `maxQueuedBytes` behind a
// shut window (beyond the message being sent). Past that the tunnel socket is
// closed 1008 and so is the handler's socket.
//
// The other way, messages from the client are credited only once the
// handler's socket has taken them: while its `bufferedAmount` (when it has
// one) is above one window, credit is held back, so the client stops, and a
// socket that still holds more than `maxQueuedBytes` when the next message is
// handed to it is closed 1008, as is the tunnel socket.

/** The origin of the Requests handed to `handler.fetch`. Only the path and query mean anything. */
export const TUNNEL_ORIGIN = 'http://openbots.tunnel';

export type DeviceLookup = { known: true; id: string } | { known: false };

export interface TunnelRequestMeta {
  /** The paired device this stream belongs to, or null while it is unknown (pairing only). */
  deviceId: string | null;
}

/** The server's end of a WebSocket the handler opened, e.g. a `ws` socket to the server's own port. */
export interface ServerSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  /** Headers for `ws.opened`, e.g. the negotiated `sec-websocket-protocol`. */
  headers?: Record<string, string>;
  /**
   * Bytes sent to the socket and not yet written out, as a `ws` WebSocket's
   * `bufferedAmount`. With it the tunnel credits the client only as the
   * socket drains; without it, bytes count as taken once `send` returns.
   */
  readonly bufferedAmount?: number;
}

export interface TunnelHandler {
  fetch(request: Request, meta: TunnelRequestMeta): Promise<Response>;
  /** `path` carries the query. Answer a Response to refuse the upgrade. */
  openSocket(
    path: string,
    headers: Record<string, string>,
    meta: TunnelRequestMeta,
  ): Promise<ServerSocket | Response>;
}

export interface TunnelServerOptions {
  transport: ByteTransport;
  /** The server tunnel key (X25519 private key). */
  staticKey: Uint8Array;
  /** Decides `device` in handshake message 2, and is asked again after a pairing on the stream. */
  lookupDevice(publicKey: Uint8Array): Promise<DeviceLookup>;
  handler: TunnelHandler;
  limits?: Partial<TunnelLimits>;
  handshakeTimeoutMs?: number;
  /** The ping and idle close of spec 5.3; 25 and 60 seconds by default. */
  keepalive?: Partial<KeepaliveOptions>;
  /**
   * How long a stream from an unknown device lives after its handshake: it
   * closes 4400 then, or once its first pairing request has been answered
   * without making the device known, whichever is first. Default 30 seconds;
   * 0 turns the limit off.
   */
  unknownDeviceLifetimeMs?: number;
}

/** How long a pairing only stream lives by default (spec 5.1). */
export const DEFAULT_UNKNOWN_DEVICE_LIFETIME_MS = 30_000;
/** The close code of a pairing only stream whose time is up. */
const CLOSE_PAIRING_OVER = 4400;
/** How often credit held back for a busy handler socket is looked at again. */
const DRAIN_POLL_MS = 20;

export interface DrainOptions {
  /** Close anyway after this long. Default 5 seconds. */
  timeoutMs?: number;
  /** The answer to a request or `ws.open` that arrives while draining. Default 503. */
  refuse?: () => Response;
}

/** How long `drain` waits for in-flight responses by default. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export interface TunnelServer {
  /** The device id once known; null while the stream serves pairing only. */
  readonly deviceId: string | null;
  readonly device: DeviceStatus;
  /** The client's static X25519 public key from the handshake. */
  readonly clientKey: Uint8Array;
  readonly closed: boolean;
  readonly handshakeHash: Uint8Array;
  /** True once `drain` was called. */
  readonly draining: boolean;
  ping(): Promise<number>;
  close(code?: number, reason?: string): void;
  /**
   * Refuses every new request at once and closes the stream with `code` once
   * the HTTP responses in flight are sent, or after `timeoutMs`. A second
   * call changes nothing.
   */
  drain(code: number, reason: string, options?: DrainOptions): void;
  onClose(handler: (code: number, reason: string) => void): () => void;
}

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'origin',
  'connection',
  'upgrade',
  'content-length',
  'transfer-encoding',
  'x-openbots-device',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'content-length',
]);

/** True for a request header spec 5.4 says the adapter sets itself rather than passing through. */
export function isDroppedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DROPPED_REQUEST_HEADERS.has(lower) ||
    lower.startsWith('sec-fetch-') ||
    lower.startsWith('x-forwarded-')
  );
}

/** True for a response header spec 5.4 says does not pass back. */
export function isDroppedResponseHeader(name: string): boolean {
  return DROPPED_RESPONSE_HEADERS.has(name.toLowerCase());
}

function stripRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (!isDroppedRequestHeader(name)) out[name] = value;
  return out;
}

function closingResponse(): Response {
  return new Response(
    JSON.stringify({ code: 'STREAM_CLOSING', message: 'This stream is closing. Open a new one.' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

function deviceUnknownResponse(): Response {
  return new Response(
    JSON.stringify({
      code: 'DEVICE_UNKNOWN',
      message: 'This device is not paired with this server. Only pairing is served on this stream.',
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function readPath(value: unknown, what: string): string {
  const path = typeof value === 'string' ? normalizeTunnelPath(value) : null;
  if (path === null) {
    throw new ProtocolViolation(`${what} needs a \`path\` starting with / on this server`);
  }
  return path;
}

// A backslash, whitespace or a control character: exactly what a path may not hold.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHAR = /[\\\s\u0000-\u001f\u007f]/;

/**
 * A request or socket path as the tunnel accepts it: a path and query on the
 * server itself, and nothing else. Null for a path that could name another
 * host (`//evil.example/ws`) or a scheme, or that carries a backslash,
 * whitespace or a control character a URL parser might reinterpret. What
 * comes back is the parsed path and query, which is all the server's adapter
 * joins to its loopback origin.
 */
export function normalizeTunnelPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE_PATH_CHAR.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(TUNNEL_ORIGIN + value);
  } catch {
    return null;
  }
  if (url.origin !== TUNNEL_ORIGIN) return null;
  return url.pathname + url.search;
}

function pathname(path: string): string {
  return new URL(TUNNEL_ORIGIN + path).pathname;
}

interface ServerContext {
  session: TunnelSession;
  limits: TunnelLimits;
  handler: TunnelHandler;
  meta(): TunnelRequestMeta;
  readonly known: boolean;
  /** Looks the client's key up again after a pairing; true when it is now known. */
  promote(): Promise<boolean>;
  /** The answer to a new request while the stream drains, or null when it does not. */
  refusal(): Response | null;
  /** A pairing request on this stream has been answered. */
  pairingAnswered(): void;
}

export async function createTunnelServer(options: TunnelServerOptions): Promise<TunnelServer> {
  const { transport, handler, lookupDevice } = options;
  const limits: TunnelLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const route = new TransportRoute(transport);
  const handshake = await runResponderHandshake(transport, route, {
    staticKey: options.staticKey,
    timeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxMessages: limits.maxMessages,
    decide: async (clientKey) => {
      const decision = await lookupDevice(clientKey);
      return { device: decision.known ? 'known' : 'unknown', decision };
    },
  });
  const { clientKey } = handshake;
  let deviceId: string | null = handshake.decision.known ? handshake.decision.id : null;
  /** The HTTP ids in flight, which a drain waits for. */
  const exchanges = new Set<Channel>();
  let draining: {
    code: number;
    reason: string;
    refuse: () => Response;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const settleDrain = () => {
    if (!draining) return;
    for (const channel of exchanges) if (!channel.open) exchanges.delete(channel);
    if (exchanges.size) return;
    clearTimeout(draining.timer);
    session.close(draining.code, draining.reason);
  };

  const ctx: ServerContext = {
    session: undefined as unknown as TunnelSession,
    limits,
    handler,
    meta: () => ({ deviceId }),
    get known() {
      return deviceId !== null;
    },
    async promote() {
      if (deviceId !== null) return true;
      const decision = await lookupDevice(clientKey);
      if (decision.known) {
        deviceId = decision.id;
        clearTimeout(unknownTimer);
      }
      return decision.known;
    },
    refusal: () => (draining ? draining.refuse() : null),
    pairingAnswered() {
      // Still unknown after its pairing: the stream has served its purpose.
      if (deviceId === null && unknownTimer) session.close(CLOSE_PAIRING_OVER, 'pairing only');
    },
  };
  const session = new TunnelSession({
    role: 'server',
    transport,
    ciphers: handshake.ciphers,
    limits,
    keepalive: options.keepalive,
    accept: (frame, channel) => {
      if (frame.type !== FrameType.HttpReq)
        return new ServerSocketChannel(ctx, channel, frame).handler;
      exchanges.add(channel);
      return new ServerExchange(ctx, channel, frame).handler;
    },
    onRelease: (channel) => {
      exchanges.delete(channel);
      if (draining && !exchanges.size) queueMicrotask(settleDrain);
    },
  });
  ctx.session = session;
  const lifetimeMs = options.unknownDeviceLifetimeMs ?? DEFAULT_UNKNOWN_DEVICE_LIFETIME_MS;
  let unknownTimer: ReturnType<typeof setTimeout> | undefined;
  if (deviceId === null && lifetimeMs > 0) {
    unknownTimer = setTimeout(() => {
      if (deviceId === null) session.close(CLOSE_PAIRING_OVER, 'pairing only');
    }, lifetimeMs);
    (unknownTimer as { unref?: () => void }).unref?.();
    session.onClose(() => clearTimeout(unknownTimer));
  }
  route.take(
    (bytes) => session.receive(bytes),
    (code, reason) => session.transportClosed(code, reason),
  );
  handshake.reply();

  return {
    get deviceId() {
      return deviceId;
    },
    get device() {
      return deviceId !== null ? 'known' : 'unknown';
    },
    clientKey,
    get closed() {
      return session.closed;
    },
    handshakeHash: handshake.handshakeHash,
    get draining() {
      return draining !== null;
    },
    ping: () => session.ping(),
    close: (code = 1000, reason = '') => session.close(code, reason),
    drain(code, reason, drainOptions = {}) {
      if (draining || session.closed) return;
      const timer = setTimeout(
        () => session.close(code, reason),
        drainOptions.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      draining = { code, reason, refuse: drainOptions.refuse ?? closingResponse, timer };
      session.onClose(() => clearTimeout(timer));
      settleDrain();
    },
    onClose: (onClose) => session.onClose(onClose),
  };
}

/**
 * Sends a Response on an id: `http.res`, then the body as `http.body` frames.
 * Resolves true once END is sent, false when the id or the stream went away.
 */
async function sendResponse(
  session: TunnelSession,
  channel: Channel,
  response: Response,
): Promise<boolean> {
  const body = response.body;
  try {
    const header = {
      status: response.status,
      headers: headerMap(response.headers, isDroppedResponseHeader),
    };
    if (
      !session.sendIfOpen(channel, {
        type: FrameType.HttpRes,
        id: channel.id,
        flags: body ? 0 : FLAG_END,
        header,
      })
    ) {
      body?.cancel().catch(() => {});
      return false;
    }
  } catch (error) {
    body?.cancel().catch(() => {});
    if (channel.open && !session.closed)
      session.sendError(channel, 'internal', (error as Error).message);
    return false;
  }
  if (!body) return true;
  try {
    await pumpStream(body, (chunk) =>
      session.sendData(channel, FrameType.HttpBody, chunk, { end: false }),
    );
    await session.sendData(channel, FrameType.HttpBody, new Uint8Array(0), { end: true });
    return true;
  } catch (error) {
    if (channel.open && !session.closed) {
      session.sendError(
        channel,
        'internal',
        `the response body failed: ${(error as Error).message}`,
      );
    }
    return false;
  }
}

/** One `http.req` on the stream. */
class ServerExchange {
  readonly handler: ChannelHandler;
  readonly #ctx: ServerContext;
  readonly #channel: Channel;
  readonly #abort = new AbortController();
  #body: BodyQueue | null = null;
  #bodyBytes = 0;
  #requestEnded: boolean;
  #responseEnded = false;

  constructor(ctx: ServerContext, channel: Channel, frame: Frame) {
    this.#ctx = ctx;
    this.#channel = channel;
    this.handler = {
      onFrame: (next) => this.#onFrame(next),
      onError: (error) => this.#onError(error),
    };
    const method = frame.header?.method;
    if (typeof method !== 'string' || !TOKEN.test(method))
      throw new ProtocolViolation('http.req needs a `method`');
    const path = readPath(frame.header?.path, 'http.req');
    const headers = readHeaderMap(frame.header?.headers, 'http.req');
    this.#requestEnded = (frame.flags & FLAG_END) !== 0;

    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > ctx.limits.maxRequestBodyBytes) {
      this.#tooLarge();
      return;
    }
    const hasBody = method !== 'GET' && method !== 'HEAD';
    if (!this.#requestEnded || frame.body.length) {
      this.#body = new BodyQueue({
        onConsumed: (bytes) => ctx.session.consumed(channel, bytes),
        // The body is complete and read: credit the rest now.
        onEnd: () => ctx.session.flushCredit(channel),
      });
      if (!hasBody) this.#body.discard();
      if (!this.#addBody(frame)) return;
    }
    void this.#run(method, path, headers, hasBody);
  }

  /** Adds a body chunk; false when it took the body past the limit (the id is then refused). */
  #addBody(frame: Frame): boolean {
    this.#bodyBytes += frame.body.length;
    if (this.#bodyBytes > this.#ctx.limits.maxRequestBodyBytes) {
      this.#tooLarge();
      return false;
    }
    this.#body!.push(frame.body);
    if (frame.flags & FLAG_END) {
      this.#requestEnded = true;
      this.#body!.end();
    }
    return true;
  }

  #tooLarge(): void {
    const message = `a request body of more than ${this.#ctx.limits.maxRequestBodyBytes} bytes`;
    this.#ctx.session.sendError(this.#channel, 'too_large', message);
    this.#onError(new TunnelError('too_large', message));
  }

  #onFrame(frame: Frame): void {
    if (frame.type !== FrameType.HttpBody || !this.#body || this.#requestEnded) {
      throw new ProtocolViolation(`${frameTypeName(frame.type)} on request id ${frame.id}`);
    }
    if (this.#addBody(frame)) this.#maybeFinish();
  }

  #onError(error: Error): void {
    this.#abort.abort(error);
    this.#body?.fail(error);
  }

  async #run(
    method: string,
    path: string,
    headers: Record<string, string>,
    hasBody: boolean,
  ): Promise<void> {
    const ctx = this.#ctx;
    const channel = this.#channel;
    const isPairing = method === 'POST' && pathname(path) === PAIR_PATH;
    let response: Response;
    const refused = ctx.refusal();
    if (refused) {
      response = refused;
    } else if (!ctx.known && !isPairing) {
      response = deviceUnknownResponse();
    } else {
      try {
        const request = new Request(TUNNEL_ORIGIN + path, {
          method,
          headers: stripRequestHeaders(headers),
          body: hasBody && this.#body ? this.#body.stream : null,
          signal: this.#abort.signal,
          duplex: 'half',
        } as RequestInit);
        response = await ctx.handler.fetch(request, ctx.meta());
        if (isPairing && response.status === 200 && !ctx.known) await ctx.promote();
      } catch (error) {
        if (channel.open)
          ctx.session.sendError(
            channel,
            'internal',
            (error as Error)?.message ?? 'the handler failed',
          );
        this.#onError(error as Error);
        if (isPairing) ctx.pairingAnswered();
        return;
      }
    }
    if (!channel.open) {
      response.body?.cancel().catch(() => {});
      return;
    }
    const sent = await sendResponse(ctx.session, channel, response);
    if (isPairing && !refused) ctx.pairingAnswered();
    if (!sent) return;
    this.#responseEnded = true;
    // The answer is complete; whatever of the request body is still to come is not wanted.
    if (!this.#requestEnded) this.#body?.discard();
    this.#maybeFinish();
  }

  #maybeFinish(): void {
    if (this.#requestEnded && this.#responseEnded) this.#ctx.session.release(this.#channel);
  }
}

/** One `ws.open` on the stream. */
class ServerSocketChannel {
  readonly handler: ChannelHandler;
  readonly #ctx: ServerContext;
  readonly #channel: Channel;
  #socket: ServerSocket | null = null;
  #state: 'opening' | 'open' | 'refused' | 'closed' = 'opening';
  #sentClose = false;
  #receivedClose = false;
  /** Bytes of messages handed to `#forward` and not sent yet. */
  #queued = 0;
  /** Client bytes received and not credited yet, held while the handler's socket is behind. */
  #uncredited = 0;
  #creditTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #assembler: MessageAssembler;

  constructor(ctx: ServerContext, channel: Channel, frame: Frame) {
    this.#ctx = ctx;
    this.#channel = channel;
    this.#assembler = new MessageAssembler(ctx.limits.maxMessageBytes);
    this.handler = {
      onFrame: (next) => this.#onFrame(next),
      onError: () => this.#teardown(),
    };
    const path = readPath(frame.header?.path, 'ws.open');
    const headers = readHeaderMap(frame.header?.headers, 'ws.open');
    void this.#open(path, headers);
  }

  async #open(path: string, headers: Record<string, string>): Promise<void> {
    const ctx = this.#ctx;
    const channel = this.#channel;
    let result: ServerSocket | Response;
    const refused = ctx.refusal();
    if (refused) {
      result = refused;
    } else if (!ctx.known) {
      result = deviceUnknownResponse();
    } else {
      try {
        result = await ctx.handler.openSocket(path, stripRequestHeaders(headers), ctx.meta());
      } catch (error) {
        if (channel.open)
          ctx.session.sendError(
            channel,
            'internal',
            (error as Error)?.message ?? 'the handler failed',
          );
        this.#state = 'closed';
        return;
      }
    }
    if (result instanceof Response) {
      this.#state = 'refused';
      if (await sendResponse(ctx.session, channel, result)) ctx.session.release(channel);
      return;
    }
    const socket = result;
    if (!channel.open || this.#state === 'closed') {
      socket.close(1000, 'the client went away');
      return;
    }
    this.#socket = socket;
    try {
      ctx.session.send({
        type: FrameType.WsOpened,
        id: channel.id,
        header: { headers: socket.headers ?? {} },
      });
    } catch {
      socket.close(1001, 'the tunnel closed');
      return;
    }
    this.#state = 'open';
    socket.onMessage((data) => this.#forward(data));
    socket.onClose((code, reason) => this.#socketClosed(code, reason));
  }

  /** A message from the server's socket, out to the client in order. */
  #forward(data: string | Uint8Array): void {
    const channel = this.#channel;
    if (!channel.open || this.#sentClose) return;
    const text = typeof data === 'string';
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
    if (this.#queued > 0 && this.#queued + bytes.length > this.#ctx.limits.maxQueuedBytes) {
      this.#overflow();
      return;
    }
    this.#queued += bytes.length;
    channel.sendChain = channel.sendChain
      .then(() => this.#ctx.session.sendData(channel, FrameType.WsMsg, bytes, { end: true, text }))
      .catch(() => {})
      .finally(() => {
        this.#queued -= bytes.length;
      });
  }

  /**
   * The client's window stayed shut while the server's socket kept talking
   * (`send queue full`), or the server's socket stopped taking what the
   * client sends (`receive queue full`): drop what is queued, close the
   * tunnel socket 1008 ahead of it, and tell the server's socket. The
   * client's echo frees the id.
   */
  #overflow(reason = 'send queue full'): void {
    const ctx = this.#ctx;
    const channel = this.#channel;
    clearTimeout(this.#creditTimer);
    this.#sentClose = true;
    channel.fail(new TunnelError('cancelled', reason));
    try {
      ctx.session.sendIfOpen(channel, {
        type: FrameType.WsClose,
        id: channel.id,
        header: { code: CLOSE_QUEUE_FULL, reason },
      });
    } catch {
      // The stream closed meanwhile.
    }
    this.#socket?.close(CLOSE_QUEUE_FULL, reason);
    if (this.#receivedClose) ctx.session.release(channel);
  }

  #socketClosed(code: number, reason: string): void {
    const channel = this.#channel;
    if (this.#sentClose || !channel.open) return;
    this.#sentClose = true;
    const header = { code: wireCloseCode(code), reason: truncateReason(reason) };
    channel.sendChain = channel.sendChain.then(() => {
      try {
        this.#ctx.session.sendIfOpen(channel, { type: FrameType.WsClose, id: channel.id, header });
      } catch {
        // The stream closed meanwhile.
      }
      if (this.#receivedClose) this.#ctx.session.release(channel);
    });
  }

  #onFrame(frame: Frame): void {
    const ctx = this.#ctx;
    const channel = this.#channel;
    if (this.#state !== 'open' || this.#receivedClose) {
      throw new ProtocolViolation(
        `${frameTypeName(frame.type)} on socket id ${frame.id}, which is not open`,
      );
    }
    switch (frame.type) {
      case FrameType.WsMsg: {
        let message: { text: boolean; data: Uint8Array } | null;
        try {
          message = this.#assembler.push(frame);
        } catch (error) {
          if (!(error instanceof TunnelError)) throw error;
          ctx.session.sendError(channel, error.code, error.message);
          this.#socket?.close(1009, 'message too big');
          this.#state = 'closed';
          return;
        }
        // Credited per fragment, so a message larger than the window
        // completes, but only while the handler's socket keeps up.
        this.#uncredited += frame.body.length;
        if (message && !this.#sentClose) {
          if (this.#backlog() > ctx.limits.maxQueuedBytes) {
            this.#overflow('receive queue full');
            return;
          }
          this.#socket!.send(message.text ? textDecoder.decode(message.data) : message.data);
        }
        this.#credit();
        return;
      }
      case FrameType.WsClose: {
        const { code, reason } = readClose(frame.header);
        this.#receivedClose = true;
        if (this.#sentClose) {
          // Our close went first; this is the client's answer.
          ctx.session.release(channel);
          return;
        }
        this.#sentClose = true;
        this.#socket!.close(wireCloseCode(code), reason);
        const echo = { code: wireCloseCode(code), reason: '' };
        channel.sendChain = channel.sendChain.then(() => {
          try {
            ctx.session.sendIfOpen(channel, {
              type: FrameType.WsClose,
              id: channel.id,
              header: echo,
            });
          } catch {
            // The stream closed meanwhile.
          }
          ctx.session.release(channel);
        });
        return;
      }
      default:
        throw new ProtocolViolation(`${frameTypeName(frame.type)} on socket id ${frame.id}`);
    }
  }

  /** Bytes the handler's socket holds and has not written out, or 0 when it does not say. */
  #backlog(): number {
    const buffered = this.#socket?.bufferedAmount;
    return typeof buffered === 'number' && Number.isFinite(buffered) ? buffered : 0;
  }

  /**
   * Credits what the client sent once the handler's socket is at most one
   * window behind; until then the credit waits and the client's window
   * shuts, so the bytes held for the socket stay bounded.
   */
  #credit(): void {
    clearTimeout(this.#creditTimer);
    this.#creditTimer = undefined;
    const channel = this.#channel;
    if (!channel.open || this.#uncredited === 0 || this.#state !== 'open') return;
    if (this.#backlog() > this.#ctx.limits.windowBytes) {
      this.#creditTimer = setTimeout(() => this.#credit(), DRAIN_POLL_MS);
      (this.#creditTimer as { unref?: () => void }).unref?.();
      return;
    }
    const bytes = this.#uncredited;
    this.#uncredited = 0;
    this.#ctx.session.consumed(channel, bytes);
  }

  /** The client cancelled the id, or the stream went away. */
  #teardown(): void {
    clearTimeout(this.#creditTimer);
    const wasOpen = this.#state === 'open';
    this.#state = 'closed';
    if (wasOpen && !this.#sentClose) {
      this.#sentClose = true;
      this.#socket?.close(1001, 'the tunnel closed');
    }
  }
}

function truncateReason(reason: string): string {
  const bytes = textEncoder.encode(reason);
  if (bytes.length <= 123) return reason;
  return new TextDecoder().decode(bytes.subarray(0, 123)).replace(/�$/, '');
}
