import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { PushGateway, PushOutcome, PushRequest } from './apns.js';
import type { Ticket } from './budget.js';
import type { FlowControl, Outlet, SendResult, Valve } from './flow.js';
import type { RelayMetrics } from './metrics.js';
import type { ClaimResult } from './ownership.js';
import {
  CAPABILITIES,
  type Capability,
  type HostRegistry,
  type Link,
  type StreamPeer,
} from './hosts.js';
import {
  fromBase64Url,
  isHostId,
  NONCE_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  toBase64Url,
  verifyHello,
} from './identity.js';

// The host link on `/v1/host?hostId=...` (docs/RELAY_PROTOCOL.md section 3).
// The relay sends a challenge as soon as the socket opens; the host has 10
// seconds to answer with a `hello` that proves the host id of the URL. The
// machine then takes the host's lease (ownership.ts) before it answers
// `linked`, and from then on the link carries
// client streams (`open`, `[u32 stream id][payload]` binary frames, `close`)
// and push frames until either side goes. Everything the host sends before
// `linked` other than one `hello` is a protocol error. A protocol error is an
// `error` frame and then a close with 4400; the limits of 3.4 close the link
// without one.
//
// A claim that the registry does not answer within 10 seconds closes the link
// 1012, so the host reconnects rather than wait. Host to client bytes past the
// host's minute close the stream that would carry them (1008), not the link,
// since the streams are what a client can drive. Every push is answered with
// `push.result`, `reason: "error"` when the gateway fails in any way. On a
// drain the link closes 1012 as soon as its pushes in flight are answered, so
// the host relinks to another machine at once.

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
  /** A link whose lease is not taken this long after its hello is closed 1012. */
  claimTimeoutMs: number;
}

export const DEFAULT_TIMING: HostLinkTiming = {
  helloTimeoutMs: 10_000,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 50_000,
  claimTimeoutMs: 10_000,
};

export interface HostLinkDeps {
  registry: HostRegistry;
  push: PushGateway;
  logger: Logger;
  timing: HostLinkTiming;
  /** Takes or keeps the host's lease once the hello has proved the host id. */
  claim(hostId: string, streams: boolean): Promise<ClaimResult>;
  flow: FlowControl;
  metrics: RelayMetrics;
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
  environment: z.enum(['production', 'sandbox']).default('production'),
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
  /** The link socket as a destination: client streams' valves attach here (flow.ts). */
  readonly linkOutlet: Outlet;

  private readonly nonce = randomBytes(NONCE_BYTES);
  private state: 'challenged' | 'claiming' | 'linked' | 'ended' = 'challenged';
  private readonly helloTimer: NodeJS.Timeout;
  private claimTimer: NodeJS.Timeout | undefined;
  private lastPong = Date.now();
  /** Pushes sent to the gateway and not yet answered. */
  private readonly pushes = new Set<Promise<void>>();
  /** Set by a drain: the link closes with this once its pushes are answered. */
  private draining: { code: number; reason: string } | undefined;

  constructor(
    private readonly socket: WebSocket,
    readonly remote: string,
    /** The host id of the upgrade's query string, which the hello must prove. */
    private readonly expectedHostId: string,
    private readonly deps: HostLinkDeps,
    ticket: Ticket,
    private readonly onEnd: (link: HostLink) => void,
  ) {
    this.linkOutlet = deps.flow.outlet(socket, {
      kind: 'host',
      ticket,
      onShed: () => {
        deps.metrics.shed('host');
        this.end(1013, 'too slow');
      },
    });
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

  /** Between the hello and `linked`: the lease is being taken. */
  get claiming(): boolean {
    return this.state === 'claiming';
  }

  /** Pushes in flight on this link. */
  get pushesInFlight(): number {
    return this.pushes.size;
  }

  /** Settles once every push in flight has been answered. */
  async settled(): Promise<void> {
    while (this.pushes.size > 0) await Promise.all([...this.pushes]);
  }

  /**
   * The machine is draining: no new push is taken, and the link closes with
   * `code` (1012), its streams first, once the pushes in flight are answered,
   * so the host can relink to another machine at once.
   */
  drain(code: number, reason: string): void {
    if (this.state === 'ended' || this.draining) return;
    this.draining = { code, reason };
    this.closeIfDrained();
  }

  private closeIfDrained() {
    if (!this.draining || this.pushes.size > 0 || this.state === 'ended') return;
    const { code, reason } = this.draining;
    for (const [stream, peer] of [...this.streams]) {
      this.streams.delete(stream);
      peer.end(code, reason);
    }
    this.end(code, reason);
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

  /** One client payload to the host. Its byte limits are the client stream's to count (3.4). */
  sendData(stream: number, payload: Buffer, from?: Valve): SendResult {
    const frame = Buffer.allocUnsafe(STREAM_ID_BYTES + payload.length);
    frame.writeUInt32BE(stream, 0);
    payload.copy(frame, STREAM_ID_BYTES);
    // A refusal by the budget is the stream's to answer (1013), not the link's.
    return this.write(frame, from, false);
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
    clearTimeout(this.claimTimer);
    this.linkOutlet.close();
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
    const stream = frame.readUInt32BE(0);
    // Data for an unknown or closed stream is dropped (3.2).
    const peer = this.streams.get(stream);
    if (!peer) return;
    if (!this.deps.registry.countBytes(this.hostId, payload.length)) {
      // Past the host's minute: the stream that would carry it goes, the link stays.
      this.deps.logger.warn({ hostId: this.hostId }, 'host over its byte rate; closing a stream');
      this.deps.metrics.rejected('byte_rate');
      this.deps.registry.forgetStream(this, stream);
      this.sendClose(stream, 1008, 'byte rate exceeded');
      peer.end(1008, 'byte rate exceeded');
      return;
    }
    this.deps.metrics.forwarded('to_client', payload.length);
    peer.deliver(payload);
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
    if (this.state === 'claiming') throw new ProtocolError('frame before linked');
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
    if (!isHostId(hostId)) throw new ProtocolError('malformed hello: not a host id');
    if (!verifyHello({ hostId, publicKey, sig }, this.nonce)) {
      this.deps.logger.info({ remote: this.remote }, 'host link refused');
      return this.fail(4401, 'unauthorized', 'the signature does not prove this host id');
    }
    if (hostId !== this.expectedHostId) {
      this.deps.logger.info({ remote: this.remote }, 'host link refused: another host id');
      return this.fail(4401, 'unauthorized', 'the hello names another host id than the URL');
    }
    // Unknown capabilities are ignored, so a later host can offer more.
    this.capabilities = new Set(
      CAPABILITIES.filter((capability) => parsed.data.capabilities.includes(capability)),
    );
    this.hostId = hostId;
    this.state = 'claiming';
    this.claimTimer = setTimeout(() => {
      if (this.state !== 'claiming') return;
      this.deps.logger.warn({ hostId }, 'the lease was not taken in time');
      this.end(1012, 'registry slow');
    }, this.deps.timing.claimTimeoutMs);
    this.claimTimer.unref();
    void this.deps.claim(hostId, this.capabilities.has('streams')).then(
      (claimed) => this.claimed(claimed),
      (error: unknown) => {
        this.deps.logger.error({ err: error, hostId }, 'host claim failed');
        this.end(1011, 'internal error');
      },
    );
  }

  /** The lease is this machine's, or the host is told to reconnect (1012). */
  private claimed(claimed: ClaimResult) {
    if (this.state !== 'claiming') return;
    clearTimeout(this.claimTimer);
    const { hostId } = this;
    if (!claimed.ok) {
      this.deps.logger.info({ hostId, reason: claimed.reason }, 'host link not served here');
      return this.end(claimed.code, claimed.reason);
    }
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
    if (this.draining) {
      return this.pushResult(id, { ok: false, reason: 'error', status: 503 });
    }
    const pending: Promise<void> = this.sendPush(id, push).finally(() => {
      this.pushes.delete(pending);
      this.closeIfDrained();
    });
    this.pushes.add(pending);
  }

  /** Counts and sends one push, and answers it whatever happens, `error` when anything fails. */
  private async sendPush(id: string, push: PushRequest): Promise<void> {
    let outcome: PushOutcome;
    try {
      const counted = await this.deps.registry.countPush(this.hostId);
      outcome = counted
        ? await this.deps.push.send(push)
        : { ok: false, reason: 'error', status: 429 };
    } catch (error) {
      this.deps.logger.warn({ err: String(error), hostId: this.hostId }, 'push failed');
      this.deps.metrics.pushFailed();
      outcome = { ok: false, reason: 'error', status: null };
    }
    this.pushResult(id, outcome);
  }

  private pushResult(id: string, outcome: PushOutcome) {
    this.send({ type: 'push.result', id, ...outcome });
  }

  private fail(code: number, errorCode: string, message: string) {
    this.send({ type: 'error', code: errorCode, message });
    this.end(code, message);
  }

  private send(frame: object) {
    this.write(JSON.stringify(frame));
  }

  /**
   * Sends one frame through the link's outlet; a host this far behind is
   * closed 1008 (3.4). A stream's data frame that the machine's budget
   * refuses is the stream's to answer (it closes 1013). A control frame of
   * the link's own (`control`) is small and bounded by the streams, and the
   * host must hear it, so one the budget refuses is sent outside the budget
   * rather than cost every stream on the link.
   */
  private write(data: string | Buffer, from?: Valve, control = true): SendResult {
    if (this.state === 'ended' || this.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'closed' };
    }
    let sent = this.linkOutlet.send(data, from);
    if (!sent.ok && sent.reason === 'budget') {
      if (!control) return sent;
      this.socket.send(data);
      sent = { ok: true };
    }
    if (!sent.ok) return sent;
    if (this.socket.bufferedAmount > this.deps.registry.limits.maxBufferedBytes) {
      this.deps.logger.warn({ hostId: this.hostId }, 'host link send buffer full');
      this.end(1008, 'send buffer full');
      return { ok: false, reason: 'closed' };
    }
    return sent;
  }
}

/** A close reason cut to what a close frame carries, on a character boundary. */
export function closeReason(reason: string): string {
  if (Buffer.byteLength(reason) <= MAX_REASON_BYTES) return reason;
  let cut = reason;
  while (Buffer.byteLength(cut) > MAX_REASON_BYTES) cut = cut.slice(0, -1);
  return cut;
}
