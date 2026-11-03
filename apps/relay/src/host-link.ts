import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { PushGateway, PushOutcome } from './apns.js';
import {
  CAPABILITIES,
  type Capability,
  type HostRegistry,
  type Link,
  type StreamPeer,
} from './hosts.js';
import {
  fromBase64Url,
  NONCE_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  toBase64Url,
  verifyHello,
} from './identity.js';

// The host link on `/v1/host` (docs/RELAY_PROTOCOL.md section 3). The relay
// sends a challenge as soon as the socket opens; the host has 10 seconds to
// answer with a `hello` that proves its host id, and then the link carries
// client streams (`open`, `[u32 stream id][payload]` binary frames, `close`)
// and push frames until either side goes. Everything the host sends before
// `linked` other than one `hello` is a protocol error. A protocol error is an
// `error` frame and then a close with 4400; the limits of 3.4 close the link
// without one.

/** A binary frame's stream id prefix. */
export const STREAM_ID_BYTES = 4;
/** One stream payload, as in 3.2. */
export const MAX_PAYLOAD_BYTES = 65_536;
/** The largest binary frame on a host link: the id and one payload (3.4). */
export const MAX_HOST_BINARY_BYTES = STREAM_ID_BYTES + MAX_PAYLOAD_BYTES;
/** The largest text frame on a host link (3.4). */
export const MAX_HOST_TEXT_BYTES = 64 * 1024;
/** The longest close reason a WebSocket close frame can carry. */
const MAX_REASON_BYTES = 123;

export interface HostLinkTiming {
  /** How long a host has to send `hello` after the challenge. */
  helloTimeoutMs: number;
  /** How often the relay pings each link. */
  pingIntervalMs: number;
  /** A link with no pong for this long is closed 1001. */
  pongTimeoutMs: number;
}

export const DEFAULT_TIMING: HostLinkTiming = {
  helloTimeoutMs: 10_000,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 50_000,
};

export interface HostLinkDeps {
  registry: HostRegistry;
  push: PushGateway;
  logger: Logger;
  timing: HostLinkTiming;
}

const HelloSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(1),
  hostId: z.string().max(64),
  publicKey: z.string().max(128),
  sig: z.string().max(256),
  capabilities: z.array(z.string().max(32)).max(16),
});

const CloseSchema = z.object({
  type: z.literal('close'),
  stream: z.number().int().min(0).max(0xffff_ffff),
  code: z
    .number()
    .int()
    .refine((code) => code === 1000 || (code >= 4000 && code <= 4999), {
      message: 'code must be 1000 or 4000 to 4999',
    }),
  reason: z
    .string()
    .refine((reason) => Buffer.byteLength(reason) <= MAX_REASON_BYTES, {
      message: `reason must be at most ${MAX_REASON_BYTES} bytes`,
    })
    .default(''),
});

const PushSchema = z.object({
  type: z.literal('push'),
  id: z.string().min(1).max(128),
  platform: z.literal('ios'),
  token: z
    .string()
    .regex(/^[0-9a-f]+$/, 'token must be lower case hex')
    .max(200),
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'ciphertext must be base64url')
    .max(4096),
  collapseId: z
    .string()
    .refine((value) => Buffer.byteLength(value) <= 64, 'collapseId must be at most 64 bytes')
    .optional(),
  priority: z.union([z.literal(10), z.literal(5)]),
  expiresAt: z.number().int().min(0),
  threadId: z.string().max(256).optional(),
});

/** Just enough of a `push` frame to answer it when the rest does not parse. */
const PushIdSchema = z.object({ type: z.literal('push'), id: z.string().min(1).max(128) });

class ProtocolError extends Error {}

/**
 * One socket on `/v1/host`, from the challenge to its close. It becomes a
 * `Link` in the registry once the host has proved its id.
 */
export class HostLink implements Link {
  hostId = '';
  capabilities: ReadonlySet<Capability> = new Set();
  readonly streams = new Map<number, StreamPeer>();

  private readonly nonce = randomBytes(NONCE_BYTES);
  private state: 'challenged' | 'linked' | 'ended' = 'challenged';
  private readonly helloTimer: NodeJS.Timeout;
  private lastPong = Date.now();

  constructor(
    private readonly socket: WebSocket,
    readonly remote: string,
    private readonly deps: HostLinkDeps,
    private readonly onEnd: (link: HostLink) => void,
  ) {
    socket.on('message', (data, isBinary) => this.receive(data, isBinary));
    socket.on('pong', () => {
      this.lastPong = Date.now();
    });
    socket.on('close', () => this.end());
    socket.on('error', () => socket.terminate());
    this.helloTimer = setTimeout(
      () => this.fail(4400, 'protocol', 'no hello in time'),
      deps.timing.helloTimeoutMs,
    );
    this.send({ type: 'challenge', v: 1, nonce: toBase64Url(this.nonce) });
  }

  get linked(): boolean {
    return this.state === 'linked';
  }

  /** The keepalive tick: closes a link that missed its pongs, else pings it. */
  heartbeat(now: number): void {
    if (this.state === 'ended') return;
    if (now - this.lastPong > this.deps.timing.pongTimeoutMs) {
      this.end(1001, 'keepalive missed');
      return;
    }
    this.socket.ping();
  }

  sendOpen(stream: number, remote: string): void {
    this.send({ type: 'open', stream, remote });
  }

  sendData(stream: number, payload: Buffer): void {
    if (!this.countBytes(payload.length)) return;
    const frame = Buffer.allocUnsafe(STREAM_ID_BYTES + payload.length);
    frame.writeUInt32BE(stream, 0);
    payload.copy(frame, STREAM_ID_BYTES);
    this.write(frame);
  }

  sendClose(stream: number, code: number, reason: string): void {
    this.send({ type: 'close', stream, code, reason });
  }

  /**
   * Ends the link once: it leaves the registry (its clients close 4410) and
   * the socket closes with `code` when one is given. Called again by the
   * socket's own close, which then has nothing left to do.
   */
  end(code?: number, reason?: string): void {
    if (this.state === 'ended') return;
    const wasLinked = this.state === 'linked';
    this.state = 'ended';
    clearTimeout(this.helloTimer);
    if (wasLinked) {
      this.deps.registry.removeLink(this);
      this.deps.logger.info({ hostId: this.hostId, remote: this.remote, code }, 'host link closed');
    }
    if (code !== undefined && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(code, closeReason(reason ?? ''));
    }
    this.onEnd(this);
  }

  private receive(data: RawData, isBinary: boolean) {
    if (this.state === 'ended') return;
    const bytes = data as Buffer;
    try {
      if (isBinary) this.receiveBinary(bytes);
      else this.receiveText(bytes);
    } catch (error) {
      if (error instanceof ProtocolError) return this.fail(4400, 'protocol', error.message);
      // A fault of the relay's own costs this link, not the process.
      this.deps.logger.error({ err: error, hostId: this.hostId }, 'host frame failed');
      this.end(1011, 'internal error');
    }
  }

  private receiveBinary(frame: Buffer) {
    if (this.state !== 'linked') throw new ProtocolError('binary frame before linked');
    if (frame.length < STREAM_ID_BYTES) throw new ProtocolError('binary frame without a stream id');
    // ws refuses larger frames itself (maxPayload); this is the same limit.
    if (frame.length > MAX_HOST_BINARY_BYTES) return this.end(1009, 'frame too large');
    const payload = frame.subarray(STREAM_ID_BYTES);
    if (!this.countBytes(payload.length)) return;
    // Data for an unknown or closed stream is dropped (3.2).
    this.streams.get(frame.readUInt32BE(0))?.deliver(payload);
  }

  private receiveText(text: Buffer) {
    if (text.length > MAX_HOST_TEXT_BYTES) return this.end(1009, 'frame too large');
    let frame: unknown;
    try {
      frame = JSON.parse(text.toString('utf8'));
    } catch {
      throw new ProtocolError('text frames are JSON');
    }
    const type = frame && typeof frame === 'object' && 'type' in frame ? frame.type : undefined;
    if (this.state === 'challenged') {
      if (type !== 'hello') throw new ProtocolError('expected hello');
      return this.hello(frame);
    }
    if (type === 'close') return this.close(frame);
    if (type === 'push') return this.push(frame);
    throw new ProtocolError('unexpected frame type');
  }

  private hello(frame: unknown) {
    clearTimeout(this.helloTimer);
    const parsed = HelloSchema.safeParse(frame);
    if (!parsed.success) throw new ProtocolError('malformed hello');
    const publicKey = fromBase64Url(parsed.data.publicKey);
    const sig = fromBase64Url(parsed.data.sig);
    if (publicKey?.length !== PUBLIC_KEY_BYTES || sig?.length !== SIGNATURE_BYTES) {
      throw new ProtocolError('malformed hello');
    }
    const { hostId } = parsed.data;
    if (!verifyHello({ hostId, publicKey, sig }, this.nonce)) {
      this.deps.logger.info({ remote: this.remote }, 'host link refused');
      return this.fail(4401, 'unauthorized', 'the signature does not prove this host id');
    }
    // Unknown capabilities are ignored, so a later host can offer more.
    this.capabilities = new Set(
      CAPABILITIES.filter((capability) => parsed.data.capabilities.includes(capability)),
    );
    this.hostId = hostId;
    this.state = 'linked';
    this.deps.registry.addLink(this);
    this.deps.logger.info(
      { hostId, remote: this.remote, capabilities: [...this.capabilities] },
      'host linked',
    );
    this.send({ type: 'linked', v: 1, hostId });
  }

  private close(frame: unknown) {
    const parsed = CloseSchema.safeParse(frame);
    if (!parsed.success) throw new ProtocolError('malformed close');
    const { stream, code, reason } = parsed.data;
    this.deps.registry.forgetStream(this, stream)?.end(code, reason);
  }

  private push(frame: unknown) {
    if (!this.capabilities.has('push')) throw new ProtocolError('this link did not offer push');
    const parsed = PushSchema.safeParse(frame);
    if (!parsed.success) {
      // A push with an id is answered, so one bad notice does not cost the
      // host its link; one without an id cannot be answered at all.
      const withId = PushIdSchema.safeParse(frame);
      if (!withId.success) throw new ProtocolError('malformed push');
      return this.pushResult(withId.data.id, { ok: false, reason: 'invalid', status: null });
    }
    const { id, type: _type, platform: _platform, ...push } = parsed.data;
    if (!this.deps.registry.countPush(this.hostId)) {
      return this.pushResult(id, { ok: false, reason: 'error', status: 429 });
    }
    void this.deps.push.send(push).then((outcome) => this.pushResult(id, outcome));
  }

  private pushResult(id: string, outcome: PushOutcome) {
    this.send({ type: 'push.result', id, ...outcome });
  }

  /** Counts stream bytes against the host's minute; past it the link closes 1008. */
  private countBytes(bytes: number): boolean {
    if (this.deps.registry.countBytes(this.hostId, bytes)) return true;
    this.deps.logger.warn({ hostId: this.hostId }, 'host link over its byte rate');
    this.end(1008, 'byte rate exceeded');
    return false;
  }

  private fail(code: number, errorCode: string, message: string) {
    this.send({ type: 'error', code: errorCode, message });
    this.end(code, message);
  }

  private send(frame: object) {
    this.write(JSON.stringify(frame));
  }

  /** Sends one frame; a host this far behind is closed 1008 (3.4). */
  private write(data: string | Buffer) {
    if (this.state === 'ended' || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data);
    if (this.socket.bufferedAmount > this.deps.registry.limits.maxBufferedBytes) {
      this.deps.logger.warn({ hostId: this.hostId }, 'host link send buffer full');
      this.end(1008, 'send buffer full');
    }
  }
}

/** A close reason cut to what a close frame carries, on a character boundary. */
export function closeReason(reason: string): string {
  if (Buffer.byteLength(reason) <= MAX_REASON_BYTES) return reason;
  let cut = reason;
  while (Buffer.byteLength(cut) > MAX_REASON_BYTES) cut = cut.slice(0, -1);
  return cut;
}
