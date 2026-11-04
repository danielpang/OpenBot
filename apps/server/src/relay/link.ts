import { randomUUID } from 'node:crypto';
import { EVENTS_CHANNEL, wsEvent, type Unsubscribe, type WsEvent } from '@openbots/shared';
import { and, gt, isNotNull, isNull } from 'drizzle-orm';
import {
  base64urlDecode,
  base64urlEncode,
  signHostChallenge,
  type ByteTransport,
} from '@openbots/tunnel';
import { WebSocket, type RawData } from 'ws';
import type {
  AppDeps,
  RelayLink,
  RelayPushOutcome,
  RelayPushRequest,
  RelayStatus,
} from '../context.js';
import { schema, type Db } from '../db/client.js';
import { forEachWorkspace, outsideScope } from '../db/scope.js';
import { publishEvent } from '../infra/index.js';
import { setRelayLinked, setRelayStreams } from '../metrics.js';
import { anyDevicesOrPairings } from '../services/devices.js';
import type { InstanceKey } from '../services/instance-key.js';

// The host link (docs/RELAY_PROTOCOL.md section 3; MOBILE_AND_VM_PLAN.md
// 5.2): one outbound WebSocket from this process to the relay's
// `/v1/host?hostId=<hostId>`. The host id in the URL lets a relay of several
// machines send the upgrade to the machine that owns the host before any
// frame (5.8); Fly's proxy follows that replay, so the link never sees it.
// The relay sends a challenge, the link answers `hello` signed with the
// instance key, and once `linked` the socket carries client streams (each
// handed to whoever listens with `onStream`, the adapter in an API process)
// and push frames.
//
// The link dials only while some organization has an unrevoked device or an
// open pairing, so a fresh install makes no outbound connection. It checks at
// start, on `device.paired` and `device.revoked`, on `wake()` (a pairing was
// just made in this process) and every 10 seconds while off, so a pairing
// made by `openbots pair` in another process (with no Redis to carry an
// event) is found within seconds. The check is one call to
// openbots_devices_exist(). Any close while it should be up is retried with
// backoff from 1 second, doubling to a minute, and reset once linked.
//
// Each push frame names the APNs environment of its token, and `onLinked`
// tells the push worker each time the link comes up, so it can send what
// waited while it was down.
//
// A link that serves streams publishes `relay.status` (the `GET /relay`
// answer) whenever its status changes, to every owner with a device or an
// open pairing, and to those it told last time, so an owner whose last
// device went sees the link go off.

const HOST_PATH = '/v1/host';
const STREAM_ID_BYTES = 4;
/** The longest close reason the relay accepts (spec 3.2). */
const MAX_REASON_BYTES = 123;

export interface LinkTiming {
  /** The first reconnect delay; it doubles up to `maxBackoffMs`. */
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** How often an `off` link asks the database whether it should dial. */
  offCheckMs: number;
  /** How long the relay has to answer `hello` with `linked`. */
  linkTimeoutMs: number;
  /** How often the link pings the relay, and how long a pong may take. */
  pingIntervalMs: number;
  pongTimeoutMs: number;
  /** How long a `push` waits for its `push.result`. */
  pushTimeoutMs: number;
}

export const DEFAULT_LINK_TIMING: LinkTiming = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  offCheckMs: 10_000,
  linkTimeoutMs: 10_000,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 50_000,
  pushTimeoutMs: 15_000,
};

/** What a link serves (spec 3.1): `streams` for an API process, `push` for any. */
export type LinkCapability = 'streams' | 'push';

/** One client stream on the link: a ByteTransport whose bytes carry the stream id prefix on the wire. */
export interface RelayStreamTransport extends ByteTransport {
  readonly id: number;
  /** The client's address as the relay saw it. */
  readonly remote: string;
}

/** The link as the adapter and the push worker see it: the status route's view plus streams. */
export interface HostRelayLink extends RelayLink {
  /** Called for each stream the relay opens. One listener; a later call replaces it. */
  onStream(handler: (stream: RelayStreamTransport) => void): void;
}

export interface RelayLinkOptions {
  instance: InstanceKey;
  /** Default: streams and push for the `api` and `all` roles, push only for `worker`. */
  capabilities?: LinkCapability[];
  timing?: Partial<LinkTiming>;
}

export function capabilitiesFor(role: AppDeps['config']['role']): LinkCapability[] {
  return role === 'worker' ? ['push'] : ['streams', 'push'];
}

/** The host link's URL: the relay's `/v1/host` with the host id in the query (spec 3.1). */
export function hostLinkUrl(relayUrl: string, hostId: string): string {
  return `${relayUrl.replace(/\/+$/, '')}${HOST_PATH}?hostId=${encodeURIComponent(hostId)}`;
}

/** A close code the relay passes on (spec 3.2): 1000 or 4000 to 4999; anything else reads as 1000. */
export function relayCloseCode(code: number | undefined): number {
  if (code === undefined || !Number.isInteger(code)) return 1000;
  return code === 1000 || (code >= 4000 && code <= 4999) ? code : 1000;
}

function relayCloseReason(reason: string): string {
  if (Buffer.byteLength(reason) <= MAX_REASON_BYTES) return reason;
  let cut = reason;
  while (Buffer.byteLength(cut) > MAX_REASON_BYTES) cut = cut.slice(0, -1);
  return cut;
}

/** Each open stream on one connection to the relay. */
class Stream implements RelayStreamTransport {
  #messageHandlers: ((bytes: Uint8Array) => void)[] = [];
  #closeHandlers: ((code: number, reason: string) => void)[] = [];
  #held: Uint8Array[] = [];
  #closed: { code: number; reason: string } | null = null;

  constructor(
    readonly id: number,
    readonly remote: string,
    private readonly connection: Connection,
  ) {}

  get closed(): boolean {
    return this.#closed !== null;
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.connection.sendData(this.id, bytes);
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.#messageHandlers.push(handler);
    if (this.#messageHandlers.length === 1 && this.#held.length) {
      const held = this.#held;
      this.#held = [];
      for (const bytes of held) handler(bytes);
    }
  }

  onClose(handler: (code: number, reason: string) => void): void {
    const closed = this.#closed;
    if (closed) queueMicrotask(() => handler(closed.code, closed.reason));
    else this.#closeHandlers.push(handler);
  }

  /** Our side closes: the relay is told, then the handlers run. */
  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    const wire = relayCloseCode(code);
    const why = relayCloseReason(reason);
    this.connection.sendClose(this.id, wire, why);
    this.ended(wire, why);
  }

  deliver(bytes: Uint8Array): void {
    if (this.#closed) return;
    if (!this.#messageHandlers.length) this.#held.push(bytes);
    else for (const handler of this.#messageHandlers) handler(bytes);
  }

  /** The stream is over, from either end or because the link went; nothing more is sent. */
  ended(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = { code, reason };
    this.#held = [];
    this.connection.forget(this.id);
    const handlers = this.#closeHandlers;
    this.#closeHandlers = [];
    for (const handler of handlers) handler(code, reason);
  }
}

type PushFailure = Extract<RelayPushOutcome, { ok: false }>['reason'];
const PUSH_REASONS = new Set<string>(['unregistered', 'unavailable', 'invalid', 'error']);

interface PendingPush {
  resolve(outcome: RelayPushOutcome): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** One WebSocket to the relay, from the dial to its close. */
class Connection {
  readonly streams = new Map<number, Stream>();
  readonly pushes = new Map<string, PendingPush>();
  linked = false;
  #lastPong = Date.now();
  #ping: NodeJS.Timeout | undefined;
  #linkTimer: NodeJS.Timeout;
  #ended = false;

  constructor(
    readonly socket: WebSocket,
    private readonly link: LinkCore,
  ) {
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data, isBinary) => this.#receive(data, isBinary));
    socket.on('pong', () => {
      this.#lastPong = Date.now();
    });
    socket.on('error', (err) => {
      link.logger.warn({ err: { message: err.message } }, 'relay link socket error');
      socket.terminate();
    });
    socket.on('close', (code, reason) => {
      if (!this.#ended) this.end(code, reason.toString());
    });
    this.#linkTimer = setTimeout(() => {
      link.logger.warn('the relay did not link in time');
      socket.terminate();
    }, link.timing.linkTimeoutMs);
    this.#linkTimer.unref();
  }

  sendData(id: number, payload: Uint8Array): void {
    if (!this.linked || this.socket.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.allocUnsafe(STREAM_ID_BYTES + payload.length);
    frame.writeUInt32BE(id, 0);
    frame.set(payload, STREAM_ID_BYTES);
    this.socket.send(frame);
  }

  sendClose(id: number, code: number, reason: string): void {
    this.send({ type: 'close', stream: id, code, reason });
  }

  forget(id: number): void {
    this.streams.delete(id);
    this.link.streamsChanged();
  }

  send(frame: object): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  push(request: RelayPushRequest): Promise<RelayPushOutcome> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pushes.delete(id);
        reject(new Error('the relay did not answer the push in time'));
      }, this.link.timing.pushTimeoutMs);
      timer.unref();
      this.pushes.set(id, { resolve, reject, timer });
      if (!this.send({ type: 'push', id, ...request })) {
        clearTimeout(timer);
        this.pushes.delete(id);
        reject(new Error('the relay link is not open'));
      }
    });
  }

  /** Ends the connection once: streams close 4410 as the relay would, pending pushes fail. */
  end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.linked = false;
    clearTimeout(this.#linkTimer);
    clearInterval(this.#ping);
    for (const stream of [...this.streams.values()]) stream.ended(4410, 'host link closed');
    for (const pending of this.pushes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('the relay link closed'));
    }
    this.pushes.clear();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.terminate();
    }
    this.link.connectionEnded(this, code, reason);
  }

  #receive(data: RawData, isBinary: boolean): void {
    if (this.#ended) return;
    const bytes = data as Buffer;
    if (isBinary) {
      if (!this.linked || bytes.length < STREAM_ID_BYTES) return;
      const stream = this.streams.get(bytes.readUInt32BE(0));
      // A copy, since ws may reuse the buffer and the tunnel keeps what it is handed.
      stream?.deliver(new Uint8Array(bytes.subarray(STREAM_ID_BYTES)));
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      this.link.logger.warn('the relay sent a text frame that is not JSON');
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'challenge':
        return this.#hello(frame);
      case 'linked':
        clearTimeout(this.#linkTimer);
        this.linked = true;
        this.#lastPong = Date.now();
        this.#ping = setInterval(() => this.#keepalive(), this.link.timing.pingIntervalMs);
        this.#ping.unref();
        this.link.connectionLinked(this);
        return;
      case 'open': {
        if (!this.linked || typeof frame.stream !== 'number') return;
        const remote = typeof frame.remote === 'string' ? frame.remote : '';
        const stream = new Stream(frame.stream, remote, this);
        this.streams.set(stream.id, stream);
        this.link.streamsChanged();
        this.link.streamOpened(stream);
        return;
      }
      case 'close': {
        if (typeof frame.stream !== 'number') return;
        const code = typeof frame.code === 'number' ? frame.code : 1000;
        const reason = typeof frame.reason === 'string' ? frame.reason : '';
        this.streams.get(frame.stream)?.ended(code, reason);
        return;
      }
      case 'push.result': {
        const pending = typeof frame.id === 'string' ? this.pushes.get(frame.id) : undefined;
        if (!pending) return;
        this.pushes.delete(frame.id as string);
        clearTimeout(pending.timer);
        pending.resolve(
          frame.ok === true
            ? { ok: true }
            : {
                ok: false,
                reason: PUSH_REASONS.has(frame.reason as string)
                  ? (frame.reason as PushFailure)
                  : 'error',
                status: typeof frame.status === 'number' ? frame.status : null,
              },
        );
        return;
      }
      case 'error':
        this.link.logger.warn(
          { code: frame.code, message: frame.message },
          'the relay reported a protocol error',
        );
        return;
      default:
        return;
    }
  }

  #hello(frame: Record<string, unknown>): void {
    const { instance } = this.link;
    let nonce: Uint8Array;
    try {
      nonce = base64urlDecode(String(frame.nonce));
    } catch {
      this.link.logger.warn('the relay sent a malformed challenge');
      this.socket.terminate();
      return;
    }
    this.send({
      type: 'hello',
      v: 1,
      hostId: instance.hostId,
      publicKey: base64urlEncode(instance.publicKey),
      sig: base64urlEncode(signHostChallenge(instance.signingKey, nonce)),
      capabilities: this.link.capabilities,
    });
  }

  #keepalive(): void {
    if (Date.now() - this.#lastPong > this.link.timing.pongTimeoutMs) {
      this.link.logger.warn('the relay missed its pongs; reconnecting');
      this.socket.terminate();
      return;
    }
    this.socket.ping();
  }
}

/** The parts of the link its connections call back into. */
interface LinkCore {
  readonly instance: InstanceKey;
  readonly capabilities: LinkCapability[];
  readonly timing: LinkTiming;
  readonly logger: AppDeps['logger'];
  connectionLinked(connection: Connection): void;
  connectionEnded(connection: Connection, code: number, reason: string): void;
  streamOpened(stream: Stream): void;
  streamsChanged(): void;
}

/**
 * Starts the host link. Resolves once the first check has run, so `status()`
 * already says `off` or `connecting`. Needs `config.relayUrl`.
 */
export async function createRelayLink(
  deps: Pick<AppDeps, 'config' | 'db' | 'logger' | 'infra'>,
  options: RelayLinkOptions,
): Promise<HostRelayLink> {
  const { config, db, infra } = deps;
  const relayUrl = config.relayUrl;
  if (!relayUrl) throw new Error('the relay link needs OPENBOTS_RELAY_URL');
  const logger = deps.logger.child({ component: 'relay-link' });
  const timing: LinkTiming = { ...DEFAULT_LINK_TIMING, ...options.timing };
  const capabilities = options.capabilities ?? capabilitiesFor(config.role);
  const { instance } = options;

  let status: RelayStatus['status'] = 'off';
  let since: string | null = null;
  let connection: Connection | null = null;
  let backoffMs = timing.initialBackoffMs;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Whether the database last said to dial. */
  let wanted = false;
  let streamHandler: ((stream: RelayStreamTransport) => void) | null = null;
  /** Called each time the link becomes `linked` (the push worker's catch-up). */
  const linkedHandlers = new Set<() => void>();
  let checking: Promise<void> | null = null;
  let recheck = false;
  /** Owners told of the last status, as `workspace:user`. */
  let told = new Set<string>();
  /** Status events go out one at a time, in order. */
  let announcing: Promise<void> = Promise.resolve();
  const announces = capabilities.includes('streams');

  const currentStatus = (): RelayStatus => ({ hostId: instance.hostId, relayUrl, status, since });

  const setStatus = (next: RelayStatus['status']) => {
    if (next === status) return;
    status = next;
    since = new Date().toISOString();
    setRelayLinked(next === 'linked');
    logger.info({ status: next, hostId: instance.hostId }, 'relay link status');
    if (announces) {
      const snapshot = currentStatus();
      announcing = announcing.then(() =>
        outsideScope(() => announce(snapshot)).catch((err: unknown) =>
          logger.warn({ err }, 'relay link could not publish its status'),
        ),
      );
    }
  };

  /** Publishes `relay.status` to the owners with a device or an open pairing, and to those told last. */
  async function announce(payload: RelayStatus): Promise<void> {
    const now = new Set(await relayOwners(db));
    for (const key of now) told.add(key);
    for (const key of told) {
      const [workspaceId, userId] = key.split(':') as [string, string];
      await publishEvent(
        infra.bus,
        wsEvent('relay.status', { ...payload }, { user_id: userId, workspace_id: workspaceId }),
      );
    }
    told = now;
  }

  const core: LinkCore = {
    instance,
    capabilities,
    timing,
    logger,
    connectionLinked(c) {
      if (c !== connection) return;
      backoffMs = timing.initialBackoffMs;
      setStatus('linked');
      for (const handler of [...linkedHandlers]) {
        try {
          outsideScope(handler);
        } catch (err) {
          logger.warn({ err }, 'a relay link listener failed');
        }
      }
    },
    connectionEnded(c, code, reason) {
      if (c !== connection) return;
      connection = null;
      core.streamsChanged();
      if (stopped || !wanted) {
        setStatus('off');
        return;
      }
      logger.info({ code, reason, retryInMs: backoffMs }, 'relay link closed; reconnecting');
      setStatus('connecting');
      scheduleRetry();
    },
    streamOpened(stream) {
      if (!streamHandler) {
        stream.close(4404, 'this process serves no streams');
        return;
      }
      streamHandler(stream);
    },
    streamsChanged() {
      setRelayStreams(connection?.streams.size ?? 0);
    },
  };

  function scheduleRetry() {
    clearTimeout(retry);
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, timing.maxBackoffMs);
    retry = setTimeout(() => {
      retry = undefined;
      void check();
    }, delay);
    retry.unref();
  }

  function dial() {
    if (connection || stopped) return;
    setStatus('connecting');
    const url = hostLinkUrl(relayUrl!, instance.hostId);
    // No Origin and no credentials: the hello is the proof.
    const socket = new WebSocket(url, { maxPayload: 65_540 + 1024 });
    connection = new Connection(socket, core);
  }

  function hangUp() {
    clearTimeout(retry);
    retry = undefined;
    backoffMs = timing.initialBackoffMs;
    const current = connection;
    connection = null;
    if (current) {
      current.socket.close(1000, 'no devices');
      current.end(1000, 'no devices');
    }
    setStatus('off');
  }

  /**
   * Asks the database whether to dial, and dials or hangs up. One check at a
   * time. Out of any organization's scope (db/scope.ts): a wake from a
   * request or a bus event would otherwise lend its scope to the socket and
   * every stream after it.
   */
  function check(): Promise<void> {
    return outsideScope(runCheck);
  }

  function runCheck(): Promise<void> {
    if (checking) {
      recheck = true;
      return checking;
    }
    checking = (async () => {
      do {
        recheck = false;
        if (stopped) return;
        try {
          wanted = await anyDevicesOrPairings(db);
        } catch (err) {
          logger.warn({ err }, 'relay link could not read the devices');
          // Try again later: the minute's poll when off, the backoff otherwise.
          if (status !== 'off' && !connection && !retry) scheduleRetry();
          continue;
        }
        if (stopped) return;
        if (!wanted) hangUp();
        else if (!connection && !retry) dial();
      } while (recheck);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  const offPoll = setInterval(() => {
    if (status === 'off') void check();
  }, timing.offCheckMs);
  offPoll.unref();

  let unsubscribe: Unsubscribe | null = null;
  try {
    unsubscribe = await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
      if (event.type === 'device.paired' || event.type === 'device.revoked') void check();
    });
  } catch (err) {
    logger.warn({ err }, 'relay link could not subscribe to device events');
  }
  await check();

  return {
    status: currentStatus,
    wake() {
      // A pairing was just made: dial now rather than after the backoff.
      if (retry) {
        clearTimeout(retry);
        retry = undefined;
        backoffMs = timing.initialBackoffMs;
      }
      void check();
    },
    push(request) {
      const current = connection;
      if (!current?.linked) return Promise.reject(new Error('the relay link is not linked'));
      if (!capabilities.includes('push')) {
        return Promise.reject(new Error('this relay link does not carry push'));
      }
      return current.push(request);
    },
    onStream(handler) {
      streamHandler = handler;
    },
    onLinked(handler) {
      linkedHandlers.add(handler);
      return () => linkedHandlers.delete(handler);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(offPoll);
      clearTimeout(retry);
      await unsubscribe?.().catch(() => {});
      await checking?.catch(() => {});
      const current = connection;
      if (current) {
        current.socket.close(1000, 'shutting down');
        current.end(1000, 'shutting down');
      }
      connection = null;
      setStatus('off');
      await announcing;
    },
  };
}

/**
 * Every owner with an unrevoked device or an open pairing, as
 * `workspace:user`: who `relay.status` goes to. One query per organization,
 * run only when the link's status changes.
 */
async function relayOwners(db: Db, now = new Date()): Promise<string[]> {
  const owners = await forEachWorkspace(db, async (workspaceId) => {
    const devices = await db
      .selectDistinct({ ownerId: schema.devices.ownerId })
      .from(schema.devices)
      .where(isNull(schema.devices.revokedAt));
    const pairings = await db
      .selectDistinct({ ownerId: schema.devicePairings.ownerId })
      .from(schema.devicePairings)
      .where(
        and(
          isNotNull(schema.devicePairings.ownerId),
          isNull(schema.devicePairings.usedAt),
          gt(schema.devicePairings.expiresAt, now),
        ),
      );
    const ids = new Set<string>();
    for (const row of [...devices, ...pairings]) if (row.ownerId) ids.add(row.ownerId);
    return [...ids].map((id) => `${workspaceId}:${id}`);
  });
  return owners.flat();
}
