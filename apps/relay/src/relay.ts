import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { pino, type Logger } from 'pino';
import { WebSocketServer } from 'ws';
import { ApnsGateway, NO_PUSH, type ApnsOptions, type PushGateway } from './apns.js';
import { ClientStream } from './client-stream.js';
import {
  DEFAULT_TIMING,
  HostLink,
  MAX_HOST_BINARY_BYTES,
  MAX_PAYLOAD_BYTES,
  type HostLinkTiming,
} from './host-link.js';
import { DEFAULT_LIMITS, HostRegistry, type RelayLimits } from './hosts.js';
import { isHostId } from './identity.js';

// The relay process (docs/RELAY_PROTOCOL.md sections 3 and 4): one HTTP
// server with Hono for the plain routes (`/healthz`, presence) and two `ws`
// servers on its `upgrade` event, one for host links and one for client
// streams. Any other upgrade is refused with a raw HTTP status, as the API
// server's gateway does. `createRelay` listens and hands back a handle, so a
// test in another package can run a relay in process on port 0.

export const HOST_PATH = '/v1/host';
const CONNECT_PREFIX = '/v1/connect/';
/** How often hosts with no links are checked for counters that have run out. */
const SWEEP_INTERVAL_MS = 60_000;

export interface RelayOptions {
  /** 0 picks a free port. Default 3200. */
  port?: number;
  /** Default 0.0.0.0. */
  host?: string;
  /** Read the client address from the last `x-forwarded-for` hop. */
  trustProxy?: boolean;
  /** APNs credentials, or a gateway (a test's fake). Without either, push answers `unavailable`. */
  apns?: ApnsOptions | PushGateway;
  logger?: Logger;
  limits?: Partial<RelayLimits>;
  timing?: Partial<HostLinkTiming>;
}

export interface Relay {
  port: number;
  /** `http://host:port`; WebSocket clients use the same origin with `ws:`. */
  url: string;
  close(): Promise<void>;
}

export async function createRelay(options: RelayOptions = {}): Promise<Relay> {
  const logger = options.logger ?? pino({ level: 'silent' });
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const timing: HostLinkTiming = { ...DEFAULT_TIMING, ...options.timing };
  const registry = new HostRegistry(limits);
  const push: PushGateway =
    options.apns === undefined
      ? NO_PUSH
      : 'send' in options.apns
        ? options.apns
        : new ApnsGateway(options.apns, logger);
  const trustProxy = options.trustProxy ?? false;

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/v1/hosts/:hostId', async (c) => {
    const hostId = c.req.param('hostId');
    if (!isHostId(hostId)) {
      return c.json({ code: 'BAD_HOST_ID', message: 'Not a host id' }, 404);
    }
    return c.json({ hostId, linked: await registry.linked(hostId) });
  });

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const hostWss = new WebSocketServer({ noServer: true, maxPayload: MAX_HOST_BINARY_BYTES });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const hostLinks = new Set<HostLink>();
  const clientStreams = new Set<ClientStream>();
  const hostDeps = { registry, push, logger, timing };
  const clientDeps = { registry, logger };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const pathname = new URL(req.url ?? '/', 'http://relay').pathname;
    const remote = remoteAddress(req, trustProxy);
    if (pathname === HOST_PATH) {
      hostWss.handleUpgrade(req, socket, head, (ws) => {
        hostLinks.add(new HostLink(ws, remote, hostDeps, (link) => hostLinks.delete(link)));
      });
      return;
    }
    if (pathname.startsWith(CONNECT_PREFIX)) {
      // A malformed id is still upgraded, so the client learns why from a
      // close code (4400) rather than a bare HTTP status.
      const hostId = decodeSegment(pathname.slice(CONNECT_PREFIX.length));
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        const stream = new ClientStream(ws, hostId, remote, clientDeps, (s) =>
          clientStreams.delete(s),
        );
        if (ws.readyState === ws.OPEN) clientStreams.add(stream);
      });
      return;
    }
    reject(socket, 404);
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const link of hostLinks) link.heartbeat(now);
    for (const stream of clientStreams) stream.heartbeat();
  }, timing.pingIntervalMs);
  heartbeat.unref();
  const sweep = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3200, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const urlHost =
    options.host === undefined || options.host === '0.0.0.0' ? '127.0.0.1' : options.host;

  return {
    port,
    url: `http://${urlHost.includes(':') ? `[${urlHost}]` : urlHost}:${port}`,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      // Clients first, so they hear the relay is going rather than 4410.
      for (const stream of clientStreams) stream.end(1001, 'relay shutting down');
      for (const link of hostLinks) link.end(1001, 'relay shutting down');
      await Promise.all([
        new Promise<void>((resolve) => hostWss.close(() => resolve())),
        new Promise<void>((resolve) => clientWss.close(() => resolve())),
        push.close(),
      ]);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sockets that never finish their close handshake would hold this open.
        setTimeout(() => server.closeAllConnections(), 1_000).unref();
      });
    },
  };
}

/**
 * The client's address: the socket's peer, or behind a trusted proxy the last
 * `x-forwarded-for` hop, the one the proxy itself added. Earlier hops are
 * whatever the client claimed.
 */
export function remoteAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : header;
    const hops = (value ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    const last = hops.at(-1);
    if (last !== undefined) return last;
  }
  return req.socket.remoteAddress ?? '';
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function reject(socket: Duplex, status: number) {
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
