import { EVENTS_CHANNEL, type Unsubscribe, type WsEvent } from '@openbots/shared';
import {
  PAIR_PATH,
  base64urlEncode,
  createTunnelServer,
  type ServerSocket,
  type TunnelHandler,
  type TunnelServer,
} from '@openbots/tunnel';
import { WebSocket } from 'ws';
import {
  ADAPTER_SECRET_HEADER,
  adapterHeaders,
  DEVICE_HEADER,
  DEVICE_KEY_HEADER,
} from '../client-ip.js';
import type { AppDeps } from '../context.js';
import { outsideScope } from '../db/scope.js';
import { findDeviceByPublicKey } from '../services/devices.js';
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
// `x-openbots-device` (the device id, or `stream:<relay stream id>` while the
// stream is unpaired), which client-ip.ts turns into the rate-limit key for
// loopback requests, and on the pairing request `x-openbots-device-key`, the
// handshake's static key, which the pairing route compares with the body's.
//
// Sessions are kept so a `device.revoked` event closes that device's streams
// on every API process, and at most MAX_SESSIONS run at a time. A revoked
// device's stream refuses new requests at once (401 DEVICE_REVOKED) and is
// closed 4403 once the responses already in flight are sent, or after
// REVOKE_DRAIN_MS: a device that revokes itself over its own stream still
// gets its 204.
//
// The event needs a shared bus. With no REDIS_URL, `openbots devices revoke`
// in another process deletes the key but publishes on a bus of its own, so
// the adapter also asks the database: every RECHECK_MS for each open
// session of a known device, and before serving any request on a session
// whose last check is older than that. A device the database no longer has
// (revoked, or its key gone) is closed the same way.

/** Open tunnel sessions per process; the next stream is closed 4429. */
export const MAX_SESSIONS = 8;
/** How long one forwarded request may take, its streamed body included. */
export const FETCH_TIMEOUT_MS = 10 * 60_000;
/** The close code of a revoked device's streams. */
export const CLOSE_REVOKED = 4403;
/** How long a revoked device's stream may take to send the responses in flight. */
export const REVOKE_DRAIN_MS = 5_000;
/** How old a session's last look at its device may get before it is looked up again. */
export const RECHECK_MS = 15_000;
const CLOSE_TOO_MANY = 4429;
const CLOSE_GOING_AWAY = 4410;

export interface RelayAdapterOptions {
  link: Pick<HostRelayLink, 'onStream'>;
  instance: InstanceKey;
  /** This server's own HTTP port on 127.0.0.1. */
  port: number;
  maxSessions?: number;
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
  checkedAt: number;
  checking: Promise<boolean> | null;
}

function revokedResponse(): Response {
  return Response.json(
    { code: 'DEVICE_REVOKED', message: 'This device was revoked. Pair it again.' },
    { status: 401 },
  );
}

export interface RelayAdapter {
  /** Tunnel sessions open now, past their handshake or in it. */
  sessions(): number;
  stop(): Promise<void>;
}

/** A device id or `stream:<id>`: who the server's rate limits count a tunneled request as. */
function deviceHeader(deviceId: string | null, stream: RelayStreamTransport): string {
  return deviceId ?? `stream:${stream.id}`;
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
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const recheckIntervalMs = options.recheckIntervalMs ?? recheckMs;
  const revokeDrainMs = options.revokeDrainMs ?? REVOKE_DRAIN_MS;
  const origin = `http://127.0.0.1:${options.port}`;
  const wsOrigin = `ws://127.0.0.1:${options.port}`;
  /** Streams in their handshake, which count against the cap before they are sessions. */
  const handshaking = new Set<RelayStreamTransport>();
  const sessions = new Map<TunnelServer, SessionState>();
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
        const device = await outsideScope(() => findDeviceByPublicKey(db, session.clientKey));
        state.checkedAt = Date.now();
        if (device?.id === session.deviceId) return true;
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
      for (const session of sessions.keys()) {
        if (session.deviceId === id) revoke(session, 'device.revoked');
      }
    })
    .then(
      (off) => {
        unsubscribe = off;
      },
      (err: unknown) => logger.warn({ err }, 'relay adapter could not subscribe to device events'),
    );

  function handlerFor(state: SessionState, clientKey: () => Uint8Array): TunnelHandler {
    const { stream } = state;
    return {
      async fetch(request, { deviceId }) {
        if (!(await current(state))) {
          request.body?.cancel().catch(() => {});
          return revokedResponse();
        }
        const url = new URL(request.url);
        const headers = requestHeaders(request.headers, deviceId, stream);
        if (request.method === 'POST' && url.pathname === PAIR_PATH) {
          headers[DEVICE_KEY_HEADER] = base64urlEncode(clientKey());
        }
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
        return fetch(origin + url.pathname + url.search, {
          method: request.method,
          headers,
          body: hasBody ? request.body : null,
          redirect: 'manual',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(fetchTimeoutMs)]),
          ...(hasBody && request.body ? { duplex: 'half' } : {}),
        } as RequestInit);
      },
      async openSocket(path, sent, { deviceId }) {
        if (!(await current(state))) return revokedResponse();
        const target = loopbackTarget(wsOrigin, path);
        if (target === null) return new Response(null, { status: 400 });
        return openLoopbackSocket(target, requestHeaders(sent, deviceId, stream));
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
    if (handshaking.size + sessions.size >= maxSessions) {
      logger.warn({ stream: stream.id }, 'too many tunnel sessions; refusing a stream');
      stream.close(CLOSE_TOO_MANY, 'too many streams');
      return;
    }
    handshaking.add(stream);
    let clientKey: Uint8Array | null = null;
    const state: SessionState = { stream, server: null, checkedAt: Date.now(), checking: null };
    let session: TunnelServer;
    try {
      session = await createTunnelServer({
        transport: stream,
        staticKey: options.instance.tunnelPrivateKey,
        lookupDevice: async (publicKey) => {
          clientKey = publicKey;
          const device = await findDeviceByPublicKey(db, publicKey);
          state.checkedAt = Date.now();
          return device ? { known: true, id: device.id } : { known: false };
        },
        handler: handlerFor(state, () => clientKey!),
      });
    } catch (err) {
      logger.info({ stream: stream.id, error: (err as Error).message }, 'tunnel handshake failed');
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
    logger.info(
      { stream: stream.id, device: session.device, deviceId: session.deviceId },
      'tunnel session opened',
    );
    session.onClose((code, reason) => {
      sessions.delete(session);
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
      for (const stream of handshaking) stream.close(1000, 'shutting down');
      for (const session of sessions.keys()) session.close(1000, 'shutting down');
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
