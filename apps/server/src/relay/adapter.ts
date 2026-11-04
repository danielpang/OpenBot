import { defaultKeyHasher } from '@better-auth/api-key';
import { EVENTS_CHANNEL, type Unsubscribe, type WsEvent } from '@openbots/shared';
import {
  PAIR_PATH,
  base64urlEncode,
  createTunnelServer,
  type ServerSocket,
  type TunnelHandler,
  type TunnelServer,
} from '@openbots/tunnel';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import {
  ADAPTER_SECRET_HEADER,
  adapterHeaders,
  DEVICE_HEADER,
  DEVICE_KEY_HEADER,
  remoteDeviceHeader,
} from '../client-ip.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { asDirectory, outsideScope } from '../db/scope.js';
import { apiKeyFrom } from '../middleware/auth.js';
import { findDevicesByPublicKey, type DeviceRow } from '../services/devices.js';
import type { InstanceKey } from '../services/instance-key.js';
import type { HostRelayLink, RelayStreamTransport } from './link.js';

// The server side of the tunnel (RELAY_PROTOCOL.md 5.4; MOBILE_AND_VM_PLAN.md
// 5.5). Every stream the relay opens on this process's host link runs a
// Noise handshake as the responder (packages/tunnel's `createTunnelServer`),
// is told whether the client's static key is a paired device's, and then
// carries requests that become ordinary requests to this server's own port
// on loopback: `fetch` for HTTP, a `ws` socket for WebSockets. The API's
// authentication, ownership checks, rate limits and audit apply unchanged.
//
// The adapter adds two headers the tunnel never lets a client send:
// `x-openbots-device` (the device id, or `remote:<address>` while the stream
// is unpaired, the client's address as the relay reported it in `open`),
// which client-ip.ts turns into the rate-limit key for loopback requests, and
// on the pairing request `x-openbots-device-key`, the handshake's static
// key, which the pairing route compares with the body's. Relay stream ids
// start again at 1 on every link, so a limit keyed on them would reset.
//
// A known device's stream carries that device's key and no other: a request
// whose bearer key is not the key of a device with the session's static key
// is refused 401 DEVICE_KEY_MISMATCH before it reaches the server, so a
// paired session cannot carry a key lifted from another phone. One phone may
// be paired with several organizations (each its own device with the same
// static key, services/devices.ts); a request is served as the device whose
// key it carries, and the key's id is remembered per session so the lookup
// runs once per key.
//
// Sessions are kept so a `device.revoked` event closes that device's streams
// on every API process. Known and unknown devices are counted apart: at most
// MAX_SESSIONS of known devices and MAX_UNKNOWN_SESSIONS of unknown ones at a
// time, so strangers cannot take a paired phone's place (a stream past
// either cap is closed 4429). An unknown session serves one pairing request
// and closes once its answer is sent, or after UNKNOWN_SESSION_MS; the phone
// then opens a stream as the device it now is. A revoked device's stream
// refuses new requests at once (401 DEVICE_REVOKED) and is closed 4403 once
// the responses already in flight are sent, or after REVOKE_DRAIN_MS: a
// device that revokes itself over its own stream still gets its 204.
//
// The event needs a shared bus. With no REDIS_URL, `openbots devices revoke`
// in another process deletes the key but publishes on a bus of its own, so
// the adapter also asks the database: every RECHECK_MS for each open
// session of a known device, and before serving any request on a session
// whose last check is older than that. A device the database no longer has
// (revoked, or its key gone) is closed the same way.

/** Open tunnel sessions of known devices per process; the next is closed 4429. */
export const MAX_SESSIONS = 8;
/** Open tunnel sessions of unknown devices (pairing only) per process, counted apart. */
export const MAX_UNKNOWN_SESSIONS = 2;
/** How long an unknown device's session may stay open, if it does not pair first. */
export const UNKNOWN_SESSION_MS = 30_000;
/**
 * The close code of an unknown session once it paired or its time ran out:
 * the tunnel's own for a pairing only stream (packages/tunnel), which closes
 * one that is still unknown after its pairing; the adapter closes the rest.
 */
export const CLOSE_PAIRING_DONE = 4400;
/** How long one forwarded request may take, its streamed body included. */
export const FETCH_TIMEOUT_MS = 10 * 60_000;
/** The close code of a revoked device's streams. */
export const CLOSE_REVOKED = 4403;
/** How long a revoked device's stream may take to send the responses in flight. */
export const REVOKE_DRAIN_MS = 5_000;
/** How old a session's last look at its device may get before it is looked up again. */
export const RECHECK_MS = 15_000;
export const CLOSE_TOO_MANY = 4429;
/** Keys remembered per session, matched or not. */
const MAX_KEYS_PER_SESSION = 8;
const CLOSE_GOING_AWAY = 4410;

export interface RelayAdapterOptions {
  link: Pick<HostRelayLink, 'onStream'>;
  instance: InstanceKey;
  /** This server's own HTTP port on 127.0.0.1. */
  port: number;
  maxSessions?: number;
  maxUnknownSessions?: number;
  /** How long an unknown session lives. Default UNKNOWN_SESSION_MS. */
  unknownSessionMs?: number;
  fetchTimeoutMs?: number;
  /** How old a session's device check may be before a request looks again. Default RECHECK_MS. */
  recheckMs?: number;
  /** How often every known session's device is looked up. Default `recheckMs`. */
  recheckIntervalMs?: number;
  revokeDrainMs?: number;
}

/** One tunnel session and when its device was last found in the database. */
interface SessionState {
  readonly stream: RelayStreamTransport;
  server: TunnelServer | null;
  /** Known or unknown, as the handshake found it; null before. Counts against that cap. */
  kind: 'known' | 'unknown' | null;
  /** The devices of the session's static key, one per organization it is paired with. */
  devices: Pick<DeviceRow, 'id' | 'apiKeyId'>[];
  /** Bearer keys seen on the session, by their hash: the device each is, or null for none. */
  keys: Map<string, string | null>;
  checkedAt: number;
  checking: Promise<boolean> | null;
  timer: NodeJS.Timeout | null;
}

/** Thrown from the handshake's lookup when the session's cap is full. */
class SessionsFull extends Error {}

function revokedResponse(): Response {
  return Response.json(
    { code: 'DEVICE_REVOKED', message: 'This device was revoked. Pair it again.' },
    { status: 401 },
  );
}

function keyMismatchResponse(): Response {
  return Response.json(
    {
      code: 'DEVICE_KEY_MISMATCH',
      message: 'This key is not the key of the device this connection was opened by.',
    },
    { status: 401 },
  );
}

export interface RelayAdapter {
  /** Tunnel sessions open now, past their handshake or in it. */
  sessions(): number;
  stop(): Promise<void>;
}

/** A device id or `remote:<address>`: who the server's rate limits count a tunneled request as. */
function deviceHeader(deviceId: string | null, stream: RelayStreamTransport): string {
  return deviceId ?? remoteDeviceHeader(stream.remote);
}

function requestHeaders(
  source: Headers | Record<string, string>,
  deviceId: string | null,
  stream: RelayStreamTransport,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const entries = source instanceof Headers ? source.entries() : Object.entries(source);
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    // A WebSocket from a non-browser client sends no Origin (ws/gateway.ts);
    // the tunnel already drops it, and an Origin would be a browser's.
    if (
      lower === 'origin' ||
      lower === DEVICE_KEY_HEADER ||
      lower === DEVICE_HEADER ||
      lower === ADAPTER_SECRET_HEADER
    ) {
      continue;
    }
    headers[lower] = value;
  }
  Object.assign(headers, adapterHeaders());
  headers[DEVICE_HEADER] = deviceHeader(deviceId, stream);
  // The tunnel carries bodies as they are: a body fetch decoded must not keep its encoding.
  headers['accept-encoding'] = 'identity';
  return headers;
}

export function startRelayAdapter(
  deps: Pick<AppDeps, 'db' | 'logger' | 'infra'>,
  options: RelayAdapterOptions,
): RelayAdapter {
  const { db, infra } = deps;
  const logger = deps.logger.child({ component: 'relay-adapter' });
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxUnknown = options.maxUnknownSessions ?? MAX_UNKNOWN_SESSIONS;
  const unknownSessionMs = options.unknownSessionMs ?? UNKNOWN_SESSION_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const recheckIntervalMs = options.recheckIntervalMs ?? recheckMs;
  const revokeDrainMs = options.revokeDrainMs ?? REVOKE_DRAIN_MS;
  const origin = `http://127.0.0.1:${options.port}`;
  const wsOrigin = `ws://127.0.0.1:${options.port}`;
  /** Streams in their handshake: each counts against its cap once its device is looked up. */
  const handshaking = new Map<RelayStreamTransport, SessionState>();
  const sessions = new Map<TunnelServer, SessionState>();
  const counted = (kind: 'known' | 'unknown') => {
    let n = 0;
    for (const state of handshaking.values()) if (state.kind === kind) n++;
    for (const state of sessions.values()) if (state.kind === kind) n++;
    return n;
  };
  const sockets = new Set<WebSocket>();
  let stopped = false;

  /** Refuses the session's new requests and closes it 4403 once what is in flight is sent. */
  function revoke(session: TunnelServer, why: string): void {
    if (session.closed || session.draining) return;
    logger.info({ deviceId: session.deviceId, why }, 'closing a revoked device’s stream');
    session.drain(CLOSE_REVOKED, 'device revoked', {
      timeoutMs: revokeDrainMs,
      refuse: revokedResponse,
    });
  }

  /** Looks the session's device up again; false (and the session drains) when it is gone. */
  function verify(state: SessionState): Promise<boolean> {
    const session = state.server;
    if (!session || session.deviceId === null) return Promise.resolve(true);
    if (session.draining) return Promise.resolve(false);
    state.checking ??= (async () => {
      try {
        const devices = await outsideScope(() => findDevicesByPublicKey(db, session.clientKey));
        state.checkedAt = Date.now();
        state.devices = devices;
        // A key whose device went is looked up again, and refused.
        const ids = new Set(devices.map((d) => d.id));
        for (const [hash, id] of state.keys)
          if (id !== null && !ids.has(id)) state.keys.delete(hash);
        if (session.deviceId !== null && ids.has(session.deviceId)) return true;
        revoke(session, 'not in the database');
        return false;
      } catch (err) {
        // The request itself needs the database too; let it fail there.
        logger.warn({ err, deviceId: session.deviceId }, 'could not check a tunnel’s device');
        return true;
      } finally {
        state.checking = null;
      }
    })();
    return state.checking;
  }

  /** True when the session may serve a request: its device was seen lately, or is seen now. */
  function current(state: SessionState): Promise<boolean> {
    const session = state.server;
    if (session?.draining) return Promise.resolve(false);
    if (!session || session.deviceId === null) return Promise.resolve(true);
    if (Date.now() - state.checkedAt < recheckMs) return Promise.resolve(true);
    return verify(state);
  }

  const recheck = setInterval(() => {
    for (const state of sessions.values()) void verify(state);
  }, recheckIntervalMs);
  recheck.unref();

  let unsubscribe: Unsubscribe | null = null;
  const subscribed = infra.bus
    .subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
      if (event.type !== 'device.revoked') return;
      const id = (event.payload as { device?: { id?: string } }).device?.id;
      if (!id) return;
      for (const [session, state] of sessions) {
        if (session.deviceId === id || state.devices.some((d) => d.id === id)) {
          revoke(session, 'device.revoked');
        }
      }
    })
    .then(
      (off) => {
        unsubscribe = off;
      },
      (err: unknown) => logger.warn({ err }, 'relay adapter could not subscribe to device events'),
    );

  /**
   * The device a request of a known session is served as: the one whose API
   * key it carries, or the handshake's when it carries none (the server
   * then answers 401 itself). Null when the key is no device's of this
   * static key.
   */
  async function servedAs(
    state: SessionState,
    headers: Headers,
    deviceId: string,
  ): Promise<string | null> {
    const bearer = apiKeyFrom(headers);
    if (!bearer) return deviceId;
    const hash = await defaultKeyHasher(bearer);
    if (state.keys.has(hash)) return state.keys.get(hash) ?? null;
    // API keys are the directory's (db/scope.ts).
    const [key] = await outsideScope(() =>
      asDirectory(() =>
        db
          .select({ id: schema.apikeys.id })
          .from(schema.apikeys)
          .where(eq(schema.apikeys.key, hash)),
      ),
    );
    const device = key ? state.devices.find((d) => d.apiKeyId === key.id) : undefined;
    if (state.keys.size >= MAX_KEYS_PER_SESSION) state.keys.clear();
    state.keys.set(hash, device?.id ?? null);
    return device?.id ?? null;
  }

  /** An unknown session is over: it paired, or its time ran out. */
  function endUnknown(state: SessionState, why: string): void {
    const session = state.server;
    if (!session || session.closed || session.draining) return;
    logger.info({ stream: state.stream.id, why }, 'closing an unknown device’s stream');
    session.drain(CLOSE_PAIRING_DONE, why, { timeoutMs: revokeDrainMs });
  }

  function handlerFor(state: SessionState, clientKey: () => Uint8Array): TunnelHandler {
    const { stream } = state;
    return {
      async fetch(request, { deviceId }) {
        if (!(await current(state))) {
          request.body?.cancel().catch(() => {});
          return revokedResponse();
        }
        let served = deviceId;
        if (state.kind === 'known' && deviceId !== null) {
          served = await servedAs(state, request.headers, deviceId);
          if (served === null) {
            request.body?.cancel().catch(() => {});
            return keyMismatchResponse();
          }
        }
        const url = new URL(request.url);
        const headers = requestHeaders(request.headers, served, stream);
        const pairing = request.method === 'POST' && url.pathname === PAIR_PATH;
        if (pairing) headers[DEVICE_KEY_HEADER] = base64urlEncode(clientKey());
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
        try {
          return await fetch(origin + url.pathname + url.search, {
            method: request.method,
            headers,
            body: hasBody ? request.body : null,
            redirect: 'manual',
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(fetchTimeoutMs)]),
            ...(hasBody && request.body ? { duplex: 'half' } : {}),
          } as RequestInit);
        } finally {
          // One pairing request per unknown session: it closes once the answer is sent.
          if (pairing && state.kind === 'unknown')
            queueMicrotask(() => endUnknown(state, 'pairing only'));
        }
      },
      async openSocket(path, sent, { deviceId }) {
        if (!(await current(state))) return revokedResponse();
        let served = deviceId;
        if (state.kind === 'known' && deviceId !== null) {
          served = await servedAs(state, new Headers(sent), deviceId);
          if (served === null) return keyMismatchResponse();
        }
        const target = loopbackTarget(wsOrigin, path);
        if (target === null) return new Response(null, { status: 400 });
        return openLoopbackSocket(target, requestHeaders(sent, served, stream));
      },
    };
  }

  function openLoopbackSocket(
    url: string,
    headers: Record<string, string>,
  ): Promise<ServerSocket | Response> {
    return new Promise((resolve, reject) => {
      const protocols = headers['sec-websocket-protocol']
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      delete headers['sec-websocket-protocol'];
      for (const name of Object.keys(headers)) {
        if (name.startsWith('sec-websocket-')) delete headers[name];
      }
      const socket = new WebSocket(url, protocols ?? [], { headers, perMessageDeflate: false });
      sockets.add(socket);
      socket.binaryType = 'nodebuffer';
      let settled = false;
      socket.once('unexpected-response', (_req, res) => {
        settled = true;
        sockets.delete(socket);
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          const type = res.headers['content-type'];
          if (typeof type === 'string') responseHeaders.set('content-type', type);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: responseHeaders,
            }),
          );
        });
        res.on('error', () => resolve(new Response(null, { status: res.statusCode ?? 502 })));
      });
      socket.once('error', (err) => {
        sockets.delete(socket);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      socket.once('open', () => {
        settled = true;
        resolve(serverSocket(socket));
      });
      socket.on('error', () => {});
    });
  }

  /**
   * The tunnel's view of a loopback socket. Messages and the close are held
   * from the moment the socket opens, since the server may speak first, in
   * the same read as its 101, before the tunnel has asked for them.
   */
  function serverSocket(socket: WebSocket): ServerSocket {
    let onMessage: ((data: string | Uint8Array) => void) | null = null;
    let onClose: ((code: number, reason: string) => void) | null = null;
    const held: (string | Uint8Array)[] = [];
    let closed: { code: number; reason: string } | null = null;
    socket.on('message', (data, isBinary) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const message = isBinary ? new Uint8Array(bytes) : bytes.toString('utf8');
      if (onMessage) onMessage(message);
      else held.push(message);
    });
    socket.on('close', (code, reason) => {
      sockets.delete(socket);
      closed = { code, reason: reason.toString() };
      onClose?.(closed.code, closed.reason);
    });
    const protocol = socket.protocol;
    return {
      headers: protocol ? { 'sec-websocket-protocol': protocol } : {},
      // The tunnel holds the client's credit back while this is above one window.
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send(data) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      },
      close(code = 1000, reason = '') {
        try {
          socket.close(code, reason);
        } catch {
          socket.close();
        }
      },
      onMessage(handler) {
        onMessage = handler;
        for (const message of held.splice(0)) handler(message);
      },
      onClose(handler) {
        onClose = handler;
        if (closed) handler(closed.code, closed.reason);
      },
    };
  }

  async function serve(stream: RelayStreamTransport): Promise<void> {
    if (stopped) {
      stream.close(CLOSE_GOING_AWAY, 'shutting down');
      return;
    }
    // Handshakes in flight are bounded too, by both caps together.
    if (handshaking.size + sessions.size >= maxSessions + maxUnknown) {
      logger.warn({ stream: stream.id }, 'too many tunnel sessions; refusing a stream');
      stream.close(CLOSE_TOO_MANY, 'too many streams');
      return;
    }
    let clientKey: Uint8Array | null = null;
    const state: SessionState = {
      stream,
      server: null,
      kind: null,
      devices: [],
      keys: new Map(),
      checkedAt: Date.now(),
      checking: null,
      timer: null,
    };
    handshaking.set(stream, state);
    let session: TunnelServer;
    try {
      session = await createTunnelServer({
        transport: stream,
        staticKey: options.instance.tunnelPrivateKey,
        lookupDevice: async (publicKey) => {
          clientKey = publicKey;
          const devices = await findDevicesByPublicKey(db, publicKey);
          state.checkedAt = Date.now();
          state.devices = devices;
          const first = devices[0];
          // Asked again after a pairing on the stream: it stays counted as it began.
          if (state.kind === null) {
            const kind = first ? 'known' : 'unknown';
            if (counted(kind) >= (kind === 'known' ? maxSessions : maxUnknown)) {
              // Closed here, before the failed handshake closes it 4400.
              stream.close(CLOSE_TOO_MANY, 'too many streams');
              throw new SessionsFull(kind);
            }
            state.kind = kind;
          }
          return first ? { known: true, id: first.id } : { known: false };
        },
        handler: handlerFor(state, () => clientKey!),
      });
    } catch (err) {
      if (err instanceof SessionsFull) {
        logger.warn(
          { stream: stream.id, device: err.message },
          'too many tunnel sessions; refusing a stream',
        );
        stream.close(CLOSE_TOO_MANY, 'too many streams');
      } else {
        logger.info(
          { stream: stream.id, error: (err as Error).message },
          'tunnel handshake failed',
        );
      }
      return;
    } finally {
      handshaking.delete(stream);
    }
    if (stopped) {
      session.close(1000, 'shutting down');
      return;
    }
    state.server = session;
    sessions.set(session, state);
    if (state.kind === 'unknown') {
      state.timer = setTimeout(() => endUnknown(state, 'pairing only'), unknownSessionMs);
      state.timer.unref();
    }
    logger.info(
      { stream: stream.id, device: session.device, deviceId: session.deviceId },
      'tunnel session opened',
    );
    session.onClose((code, reason) => {
      sessions.delete(session);
      if (state.timer) clearTimeout(state.timer);
      logger.info(
        { stream: stream.id, deviceId: session.deviceId, code, reason },
        'tunnel session closed',
      );
    });
  }

  options.link.onStream((stream) => {
    serve(stream).catch((err: unknown) => {
      logger.warn({ err }, 'tunnel stream failed');
      stream.close(4400, 'internal error');
    });
  });

  return {
    sessions: () => handshaking.size + sessions.size,
    async stop() {
      stopped = true;
      clearInterval(recheck);
      await subscribed;
      await (unsubscribe as Unsubscribe | null)?.().catch(() => {});
      for (const stream of handshaking.keys()) stream.close(1000, 'shutting down');
      for (const [session, state] of sessions) {
        if (state.timer) clearTimeout(state.timer);
        session.close(1000, 'shutting down');
      }
      for (const socket of sockets) socket.terminate();
      sessions.clear();
      handshaking.clear();
    },
  };
}

/**
 * The loopback URL for a tunneled path, or null when the path would reach
 * anywhere but the server's own origin. The tunnel refuses such paths before
 * they get here (`normalizeTunnelPath`); this keeps the adapter safe on its
 * own, since the handler interface is public.
 */
export function loopbackTarget(origin: string, path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(origin + path);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return url.origin + url.pathname + url.search;
}
