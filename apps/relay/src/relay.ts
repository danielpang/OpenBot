import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pino, type Logger } from 'pino';
import { WebSocketServer } from 'ws';
import { ApnsGateway, NO_PUSH, type ApnsOptions, type PushGateway } from './apns.js';
import { NodeBudget, type BudgetOptions, type SocketKind, type Ticket } from './budget.js';
import { DrainController, type DrainOptions } from './drain.js';
import { FlowControl, type FlowOptions } from './flow.js';
import { metricsHandler, RelayMetrics } from './metrics.js';
import type { Telemetry } from './telemetry.js';
import { readyHandler, relayConditions } from './readiness.js';
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
import { DEFAULT_CLUSTER_TIMING, Ownership, type ClusterTiming, type Route } from './ownership.js';
import { MemoryRegistry, RegistryClock, type Registry } from './registry.js';

// The relay process (docs/RELAY_PROTOCOL.md sections 3 and 4): one HTTP
// server with Hono for the plain routes (`/healthz`, presence) and two `ws`
// servers on its `upgrade` event, one for host links and one for client
// streams. Any other upgrade is refused with a raw HTTP status, as the API
// server's gateway does. `createRelay` listens and hands back a handle, so a
// test in another package can run a relay in process on port 0.
//
// Several relays form one cluster through a shared registry (registry.ts,
// MOBILE_AND_VM_PLAN.md 5.8): one machine owns each host id, and an upgrade
// for a host that another live machine owns is not upgraded here but answered
// with `fly-replay: instance=<owner>`, which Fly's proxy replays on the owner.
// A request that already carries `fly-replay-src` is never replayed again.
// Replays happen only with `replay: 'fly'` (main.ts sets it on Fly): behind
// any other proxy nobody would act on the header, so every upgrade is served
// here, and a self-hosted relay of several machines needs a proxy that routes
// by host id. Without a registry the relay keeps one in memory and is a
// cluster of one.
//
// When the registry cannot be reached the machine degrades rather than stops
// (ownership.ts): links and streams it has go on, new hosts are served on
// this machine alone, `/ready` stays ready and says so in its body, and a
// metric counts it.
//
// Each machine on its own (5.8): flow control between sockets (flow.ts), one
// byte budget and a socket ceiling (budget.ts; an upgrade past the ceiling is
// refused 503), a drain (drain.ts; a draining machine still replays, but
// upgrades nothing and takes no lease), `/ready` (readiness.ts) and
// `/metrics` behind a token (metrics.ts).

export const HOST_PATH = '/v1/host';
const CONNECT_PREFIX = '/v1/connect/';
/** How often hosts with no links are forgotten. */
const SWEEP_INTERVAL_MS = 60_000;
/** The header Fly's proxy acts on, and the one it adds to the replayed request. */
export const REPLAY_HEADER = 'fly-replay';
export const REPLAY_SOURCE_HEADER = 'fly-replay-src';
/** A machine id fit for a header value and a Redis key. */
const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface RelayOptions {
  /** 0 picks a free port. Default 3200. */
  port?: number;
  /** Default 0.0.0.0. */
  host?: string;
  /** Read the client address from the proxy's headers (`remoteAddress`), not the socket. */
  trustProxy?: boolean;
  /** With `trustProxy`, a header holding the client's address, read before `x-forwarded-for`. Lower case. */
  clientIpHeader?: string;
  /** APNs credentials, or a gateway (a test's fake). Without either, push answers `unavailable`. */
  apns?: ApnsOptions | PushGateway;
  logger?: Logger;
  limits?: Partial<RelayLimits>;
  timing?: Partial<HostLinkTiming>;
  /**
   * The cluster's shared registry. Default: one in memory, for this relay
   * alone. The relay does not close one it is given.
   */
  registry?: Registry;
  /** This machine's id in the registry and in replays (`FLY_MACHINE_ID`). Default: random. */
  nodeId?: string;
  /** Below this many live machines, no new lease is taken. Default 1. */
  minClusterSize?: number;
  cluster?: Partial<ClusterTiming>;
  /** How often stream bytes counted here are added to the registry's totals. Default 1 second. */
  bytesFlushMs?: number;
  flow?: Partial<FlowOptions>;
  budget?: Partial<BudgetOptions>;
  drain?: Partial<DrainOptions>;
  /** The bearer token for `GET /metrics`; without one the route answers 404. */
  metricsToken?: string;
  /** The bearer token `GET /v1/hosts/{id}` wants; without one presence is open. */
  presenceToken?: string;
  /**
   * `fly`: answer an upgrade for a host another machine owns with
   * `fly-replay`. `off` (the default): serve every upgrade here, as behind
   * any proxy that does not act on the header.
   */
  replay?: 'fly' | 'off';
  /** How long one registry call may take. Default 2 seconds. */
  registryTimeoutMs?: number;
  /** Anonymous usage counts and errors (telemetry.ts). Default: none. The relay closes it. */
  telemetry?: Telemetry;
  /** Node's process metrics on `/metrics` as well. Default true. */
  defaultMetrics?: boolean;
  /**
   * Whether `/ready` asks the registry. Default: when a registry is given,
   * since one in memory always answers.
   */
  checkRegistry?: boolean;
}

export interface Relay {
  port: number;
  /** `http://host:port`; WebSocket clients use the same origin with `ws:`. */
  url: string;
  /** This machine's id in the registry. */
  nodeId: string;
  /** The leases this machine holds, for tests and diagnostics. */
  ownership: Ownership;
  /** The drain: `drain.start()` (main.ts does it on SIGTERM), then `close()` once it settles. */
  drain: DrainController;
  budget: NodeBudget;
  flow: FlowControl;
  metrics: RelayMetrics;
  /** Closes every client, then every link, with 1001, and gives up its leases. */
  close(): Promise<void>;
  /**
   * Drops every socket without a close frame and stops renewing, leaving its
   * leases and node key to expire, as a machine that dies would. For tests.
   */
  crash(): Promise<void>;
}

export async function createRelay(options: RelayOptions = {}): Promise<Relay> {
  const logger = options.logger ?? pino({ level: 'silent' });
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const timing: HostLinkTiming = { ...DEFAULT_TIMING, ...options.timing };
  const nodeId = options.nodeId ?? `relay-${randomBytes(6).toString('hex')}`;
  if (!NODE_ID_PATTERN.test(nodeId)) throw new Error(`not a usable node id: ${nodeId}`);
  const shared = options.registry ?? new MemoryRegistry();
  const callTimeoutMs = options.registryTimeoutMs ?? 2_000;
  // The fixed windows of the limits follow the registry's clock, so machines
  // whose clocks disagree still count into the same windows.
  const clock = new RegistryClock(shared, { timeoutMs: callTimeoutMs });
  const registry = new HostRegistry(limits, shared, () => clock.now(), callTimeoutMs);
  const replays = options.replay === 'fly';
  const push: PushGateway =
    options.apns === undefined
      ? NO_PUSH
      : 'send' in options.apns
        ? options.apns
        : new ApnsGateway(options.apns, logger);
  const trustProxy = options.trustProxy ?? false;
  const clientIpHeader = options.clientIpHeader;
  const minClusterSize = options.minClusterSize ?? 1;
  const budget = new NodeBudget(options.budget);
  const flow = new FlowControl(options.flow);
  flow.start();
  const metrics = new RelayMetrics({
    defaultMetrics: options.defaultMetrics ?? true,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  /** Cleared by a drain: no new upgrade is accepted (replays still go out). */
  let accepting = true;

  const app = new Hono();
  app.onError((err, c) => {
    // A deliberate 4xx answer is not a fault of the relay.
    if (err instanceof HTTPException) return err.getResponse();
    logger.error({ err }, 'request failed');
    metrics.failed({ type: 'http_500', where: 'route' });
    return c.json({ code: 'INTERNAL', message: 'Internal error' }, 500);
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get(
    '/ready',
    readyHandler(
      relayConditions({
        draining: () => drain.draining,
        ...((options.checkRegistry ?? options.registry !== undefined)
          ? { registryReachable: () => ownership.registryReachable() }
          : {}),
        // The size last seen, so a registry outage does not also read as a small cluster.
        clusterSize: () => ownership.clusterSize,
        minClusterSize,
        atCapacity: () => budget.full,
      }),
    ),
  );
  app.get('/metrics', metricsHandler(metrics, options.metricsToken));
  app.get('/v1/hosts/:hostId', async (c) => {
    if (
      options.presenceToken &&
      !bearerMatches(c.req.header('authorization'), options.presenceToken)
    ) {
      c.header('www-authenticate', 'Bearer');
      return c.json({ code: 'UNAUTHORIZED', message: 'Send the presence token' }, 401);
    }
    const hostId = c.req.param('hostId');
    if (!isHostId(hostId)) {
      return c.json({ code: 'BAD_HOST_ID', message: 'Not a host id' }, 404);
    }
    try {
      return c.json({ hostId, linked: await ownership.linked(hostId) });
    } catch (err) {
      logger.warn({ err, hostId }, 'presence: registry unavailable');
      return c.json({ code: 'REGISTRY_UNAVAILABLE', message: 'Try again' }, 503);
    }
  });

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const hostWss = new WebSocketServer({ noServer: true, maxPayload: MAX_HOST_BINARY_BYTES });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const hostLinks = new Set<HostLink>();
  const clientStreams = new Set<ClientStream>();
  /** Every upgraded socket, so `crash` can drop them without a close frame. */
  const rawSockets = new Set<Duplex>();
  let crashed = false;

  const ownership = new Ownership({
    nodeId,
    registry: shared,
    timing: { ...DEFAULT_CLUSTER_TIMING, ...options.cluster },
    minClusterSize,
    logger,
    metrics,
    callTimeoutMs,
    hasLinks: (hostId) => registry.hasLinks(hostId),
    hasStreams: (hostId) => registry.hasStreams(hostId),
    isClaiming: (hostId) => [...hostLinks].some((link) => link.claiming && link.hostId === hostId),
    onLost(hostId) {
      // Clients first, as on shutdown; then the links, which reconnect through routing.
      for (const link of registry.endStreams(hostId, 1012, 'lease lost')) {
        link.end(1012, 'lease lost');
      }
    },
  });

  const hostDeps = {
    registry,
    push,
    logger,
    timing,
    claim: (hostId: string, streams: boolean) => ownership.claim(hostId, streams),
    flow,
    metrics,
  };
  const clientDeps = { registry, logger, flow, metrics };

  const drain = new DrainController(
    {
      stopAccepting() {
        accepting = false;
        ownership.stopTaking();
      },
      releaseLeases: () => ownership.stop(true),
      // Each link closes once its pushes are answered, its streams with it,
      // so the server relinks to the next owner without waiting out the grace.
      closeLinks(code, reason) {
        for (const link of hostLinks) link.drain(code, reason);
      },
      settle: async () => {
        await Promise.all([...hostLinks].map((link) => link.settled()));
      },
      closeAll(code, reason) {
        // Clients first, as on shutdown; then the links.
        for (const stream of clientStreams) stream.end(code, reason);
        for (const link of hostLinks) link.end(code, reason);
      },
      // A link with pushes in flight stays in `hostLinks` until they are answered.
      idle: () => hostLinks.size === 0 && clientStreams.size === 0,
      onError: (step, err) => logger.error({ err, step }, 'drain step failed'),
    },
    options.drain,
  );

  metrics.observe({
    sockets: () => budget.snapshot().socketsByKind,
    budget: () => budget.snapshot(),
    pausedSources: () => flow.pausedSources,
    blockedDestinations: () => flow.blockedDestinations,
    draining: () => drain.draining,
    hostsOwned: () => ownership.ownedHosts().length,
    streams: () => clientStreams.size,
    clusterSize: () => ownership.clusterSize,
    degraded: () => ownership.degraded,
    hostsAlone: () => ownership.aloneHosts().length,
  });

  /**
   * After the routing decision: a draining machine or one at its socket
   * ceiling refuses the upgrade with 503, so Fly's proxy tries another.
   * Answers the ticket the socket's bytes are held on, bound to its close.
   */
  const admit = (socket: Duplex, kind: SocketKind, hostId?: string): Ticket | undefined => {
    if (!accepting) {
      metrics.rejected('draining');
      reject(socket, 503);
      return undefined;
    }
    // The ticket names the host, so its bytes count against the host's share.
    // Past the socket ceiling a host this machine serves is still admitted,
    // since no other machine can serve it, up to the hard ceiling.
    const admitted = budget.admit(kind, hostId, hostId !== undefined && ownership.serves(hostId));
    if (!admitted.ok) {
      metrics.rejected('sockets');
      reject(socket, admitted.refusal.httpStatus);
      return undefined;
    }
    return admitted.ticket.bind(socket);
  };

  /** A link went: the lease goes with the host's last link here, else its streams flag is updated. */
  const hostLinkEnded = (link: HostLink) => {
    hostLinks.delete(link);
    if (crashed || link.hostId === '') return;
    if (registry.hasLinks(link.hostId)) ownership.touch(link.hostId);
    else ownership.release(link.hostId);
  };

  /** Where an upgrade goes; without replays, always here. */
  const routeFor = async (hostId: string, replayed: boolean): Promise<Route> =>
    replays ? ownership.route(hostId, replayed) : { kind: 'local' };

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const remote = remoteAddress(req, trustProxy, clientIpHeader);
    const replayed = req.headers[REPLAY_SOURCE_HEADER] !== undefined;
    if (url.pathname === HOST_PATH) {
      const hostId = url.searchParams.get('hostId');
      if (hostId === null || !isHostId(hostId)) {
        metrics.rejected('malformed');
        return reject(socket, 400);
      }
      const route = await routeFor(hostId, replayed);
      if (route.kind === 'replay') return replay(socket, route.nodeId, 'host');
      // Served here, or (replayed once already) upgraded and closed 1012 once
      // the claim finds the other owner, so the host reconnects.
      if (socket.destroyed) return;
      const ticket = admit(socket, 'host', hostId);
      if (!ticket) return;
      hostWss.handleUpgrade(req, socket, head, (ws) => {
        rawSockets.add(socket);
        socket.once('close', () => rawSockets.delete(socket));
        hostLinks.add(new HostLink(ws, remote, hostId, hostDeps, ticket, hostLinkEnded));
      });
      return;
    }
    if (url.pathname.startsWith(CONNECT_PREFIX)) {
      // A malformed id is still upgraded, so the client learns why from a
      // close code (4400) rather than a bare HTTP status.
      const hostId = decodeSegment(url.pathname.slice(CONNECT_PREFIX.length));
      const route = isHostId(hostId)
        ? await routeFor(hostId, replayed)
        : ({ kind: 'local' } as const);
      if (route.kind === 'replay') return replay(socket, route.nodeId, 'client');
      if (socket.destroyed) return;
      const ticket = admit(socket, 'client', isHostId(hostId) ? hostId : undefined);
      if (!ticket) return;
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        if (route.kind === 'elsewhere') {
          // Replayed here, yet the host moved on: the client tries again.
          ws.close(1012, 'host moved');
          return;
        }
        rawSockets.add(socket);
        socket.once('close', () => rawSockets.delete(socket));
        const stream = new ClientStream(ws, hostId, remote, clientDeps, ticket, (s) =>
          clientStreams.delete(s),
        );
        if (ws.readyState === ws.OPEN) clientStreams.add(stream);
      });
      return;
    }
    metrics.rejected('not_found');
    reject(socket, 404);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    upgrade(req, socket, head).catch((err: unknown) => {
      logger.error({ err }, 'upgrade failed');
      metrics.failed({ type: 'http_500', where: 'upgrade' });
      if (!socket.destroyed) reject(socket, 500);
    });
  });

  /** Answers the upgrade with a replay to the owner; Fly's proxy sends the request there. */
  const replay = (socket: Duplex, owner: string, kind: SocketKind) => {
    logger.debug({ owner }, 'replaying an upgrade to its owner');
    if (socket.destroyed) return;
    metrics.replayed(kind);
    socket.once('finish', () => socket.destroy());
    socket.end(
      `HTTP/1.1 307 ${STATUS_CODES[307]}\r\n${REPLAY_HEADER}: instance=${owner}\r\n` +
        'Connection: close\r\nContent-Length: 0\r\n\r\n',
    );
  };

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const link of hostLinks) link.heartbeat(now);
    for (const stream of clientStreams) stream.heartbeat();
  }, timing.pingIntervalMs);
  heartbeat.unref();
  const sweep = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();
  const flush = setInterval(() => void registry.flushBytes(), options.bytesFlushMs ?? 1_000);
  flush.unref();
  await ownership.start();

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

  let closed = false;
  const shutDown = async () => {
    await Promise.all([
      new Promise<void>((resolve) => hostWss.close(() => resolve())),
      new Promise<void>((resolve) => clientWss.close(() => resolve())),
      push.close(),
    ]);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sockets that never finish their close handshake would hold this open.
      setTimeout(() => {
        server.closeAllConnections();
        for (const socket of rawSockets) socket.destroy();
      }, 1_000).unref();
    });
    if (!options.registry) await shared.close();
  };

  return {
    port,
    url: `http://${urlHost.includes(':') ? `[${urlHost}]` : urlHost}:${port}`,
    nodeId,
    ownership,
    drain,
    budget,
    flow,
    metrics,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(sweep);
      clearInterval(flush);
      flow.stop();
      // Clients first, so they hear the relay is going rather than 4410.
      for (const stream of clientStreams) stream.end(1001, 'relay shutting down');
      for (const link of hostLinks) link.end(1001, 'relay shutting down');
      // Bounded, and before the registry is torn down: PostHog being slow or
      // down must not hold the shutdown past its grace.
      await options.telemetry?.close().catch(() => undefined);
      await registry.flushBytes();
      await ownership.stop(true);
      await shutDown();
    },
    async crash() {
      if (closed) return;
      closed = true;
      crashed = true;
      clearInterval(heartbeat);
      clearInterval(sweep);
      clearInterval(flush);
      flow.stop();
      await ownership.stop(false);
      for (const socket of rawSockets) socket.destroy();
      await shutDown();
    },
  };
}

/**
 * The client's address: the socket's peer, or behind a trusted proxy
 * `clientIpHeader`, else the last `x-forwarded-for` hop (earlier hops are
 * whatever the client claimed). Fly needs the header: its last hop is the
 * app's own address, so every client would share one address and its limits.
 */
export function remoteAddress(
  req: IncomingMessage,
  trustProxy: boolean,
  clientIpHeader?: string,
): string {
  if (trustProxy) {
    if (clientIpHeader) {
      const direct = req.headers[clientIpHeader];
      const claimed = (Array.isArray(direct) ? direct[0] : direct)?.trim();
      if (claimed) return claimed;
    }
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

/** Whether an `Authorization` header carries `token`, compared in constant time. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? '')?.[1] ?? '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(token)) && presented.length === token.length;
}

function reject(socket: Duplex, status: number) {
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
