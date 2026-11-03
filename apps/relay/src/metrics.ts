import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { SOCKET_KINDS, type BudgetSnapshot, type SocketKind } from './budget.js';

// The relay's Prometheus metrics (docs/MOBILE_AND_VM_PLAN.md 5.8), served at
// `GET /metrics` behind `RELAY_METRICS_TOKEN` as the API server serves its
// own. Counters are bumped where things happen; gauges read the live state
// at scrape time from the sources the relay hands to `observe`, so nothing
// has to keep them in step. Every name starts with `openbots_relay_`. No
// label carries a host id, an address or anything else a peer chose, so the
// series stay few and say nothing about who uses the relay.

export type Direction = 'to_host' | 'to_client';

/** Why a socket or an upgrade was turned away. */
export type RejectionReason =
  | 'sockets'
  | 'bytes'
  | 'host_share'
  | 'draining'
  | 'host_offline'
  | 'too_many_streams'
  | 'rate_limited'
  | 'unauthorized'
  | 'malformed'
  | 'not_found'
  | 'address_streams'
  | 'address_rate'
  | 'byte_rate'
  | 'no_payload';

export type LeaseLossReason =
  'renewal_failed' | 'stolen' | 'newer_epoch' | 'released' | 'node_lapsed';

/** The live state the gauges read at scrape time. Each is optional; a gauge without its source reads 0. */
export interface MetricSources {
  sockets?: () => Record<SocketKind, number>;
  hostsOwned?: () => number;
  streams?: () => number;
  pausedSources?: () => number;
  blockedDestinations?: () => number;
  budget?: () => BudgetSnapshot;
  draining?: () => boolean;
  clusterSize?: () => number;
  /** True while the registry cannot be reached (the machine serves on, degraded). */
  degraded?: () => boolean;
  /** Hosts served on this machine alone, without a lease, while the registry is away. */
  hostsAlone?: () => number;
}

export interface RelayMetricsOptions {
  /** Node's default process metrics as well. Default true. */
  defaultMetrics?: boolean;
}

export class RelayMetrics {
  readonly registry = new Registry();
  private sources: MetricSources = {};

  /** Upgrades that another machine owned and were answered with `fly-replay`, by socket kind. */
  readonly replays: Counter<'kind'>;
  /** Sockets and upgrades turned away, by reason. */
  readonly rejections: Counter<'reason'>;
  /** Stream payload bytes moved, by direction. */
  readonly bytesForwarded: Counter<'direction'>;
  /** Destinations closed 1013 for staying blocked past the delivery deadline, by socket kind. */
  readonly shedPeers: Counter<'kind'>;
  /** Lease renewals, by outcome (`ok` or `failed`). */
  readonly leaseRenewals: Counter<'result'>;
  /** Leases this machine lost or gave up, by reason. */
  readonly leaseLosses: Counter<'reason'>;
  /** Host links served without a lease because the registry could not be reached. */
  readonly servedAloneLinks: Counter;
  /** Pushes answered `error` because the gateway failed. */
  readonly pushFailures: Counter;

  constructor(options: RelayMetricsOptions = {}) {
    if (options.defaultMetrics ?? true) {
      collectDefaultMetrics({ register: this.registry, prefix: 'openbots_relay_' });
    }
    const registers = [this.registry];
    const sources = () => this.sources;

    new Gauge({
      name: 'openbots_relay_sockets',
      help: 'Open sockets on this machine, by kind (host links and client streams)',
      labelNames: ['kind'] as const,
      registers,
      collect() {
        const read = sources().sockets;
        if (!read) return;
        const counts = read();
        for (const kind of SOCKET_KINDS) this.set({ kind }, counts[kind]);
      },
    });
    gauge(
      registers,
      'openbots_relay_hosts_owned',
      'Host ids this machine holds the lease for',
      () => sources().hostsOwned?.(),
    );
    gauge(registers, 'openbots_relay_streams', 'Open client streams on this machine', () =>
      sources().streams?.(),
    );
    gauge(
      registers,
      'openbots_relay_paused_sources',
      'Source sockets paused because a destination is behind',
      () => sources().pausedSources?.(),
    );
    gauge(
      registers,
      'openbots_relay_blocked_destinations',
      'Destination sockets above their high-water mark',
      () => sources().blockedDestinations?.(),
    );
    gauge(
      registers,
      'openbots_relay_budget_bytes',
      'Bytes in flight on this machine, held against the byte budget',
      () => sources().budget?.().bytesInFlight,
    );
    gauge(
      registers,
      'openbots_relay_budget_bytes_limit',
      'The byte budget for bytes in flight on this machine',
      () => sources().budget?.().maxBytes,
    );
    gauge(
      registers,
      'openbots_relay_budget_host_bytes_max',
      'The most bytes in flight that any one host holds on this machine, against its share',
      () => sources().budget?.().largestHostBytes,
    );
    gauge(
      registers,
      'openbots_relay_budget_host_bytes_limit',
      'The bytes in flight one host may hold on this machine (its share of the budget)',
      () => sources().budget?.().hostMaxBytes,
    );
    gauge(
      registers,
      'openbots_relay_budget_sockets_limit',
      'The socket ceiling of this machine',
      () => sources().budget?.().maxSockets,
    );
    gauge(registers, 'openbots_relay_draining', '1 while this machine is draining', () => {
      const draining = sources().draining?.();
      return draining === undefined ? undefined : Number(draining);
    });
    gauge(
      registers,
      'openbots_relay_registry_degraded',
      '1 while this machine cannot reach the registry and serves on without it',
      () => {
        const degraded = sources().degraded?.();
        return degraded === undefined ? undefined : Number(degraded);
      },
    );
    gauge(
      registers,
      'openbots_relay_hosts_alone',
      'Host ids served on this machine alone, without a lease, while the registry is away',
      () => sources().hostsAlone?.(),
    );
    gauge(
      registers,
      'openbots_relay_cluster_size',
      'Live relay machines this machine can see, itself included',
      () => sources().clusterSize?.(),
    );

    this.replays = new Counter({
      name: 'openbots_relay_replays_total',
      help: 'Upgrades answered with fly-replay to the machine that owns the host, by kind',
      labelNames: ['kind'] as const,
      registers,
    });
    this.rejections = new Counter({
      name: 'openbots_relay_rejections_total',
      help: 'Sockets and upgrades turned away, by reason',
      labelNames: ['reason'] as const,
      registers,
    });
    this.bytesForwarded = new Counter({
      name: 'openbots_relay_bytes_forwarded_total',
      help: 'Stream payload bytes forwarded, by direction',
      labelNames: ['direction'] as const,
      registers,
    });
    this.shedPeers = new Counter({
      name: 'openbots_relay_shed_peers_total',
      help: 'Destinations closed 1013 after staying blocked past the delivery deadline, by kind',
      labelNames: ['kind'] as const,
      registers,
    });
    this.leaseRenewals = new Counter({
      name: 'openbots_relay_lease_renewals_total',
      help: 'Host lease renewals, by result',
      labelNames: ['result'] as const,
      registers,
    });
    this.leaseLosses = new Counter({
      name: 'openbots_relay_lease_losses_total',
      help: 'Host leases lost or given up, by reason',
      labelNames: ['reason'] as const,
      registers,
    });
    this.servedAloneLinks = new Counter({
      name: 'openbots_relay_served_alone_total',
      help: 'Host links served on this machine alone because the registry could not be reached',
      registers,
    });
    this.pushFailures = new Counter({
      name: 'openbots_relay_push_failures_total',
      help: 'Pushes answered with reason error because the push gateway failed',
      registers,
    });
  }

  /** Points the gauges at the relay's live state. A later call replaces the sources it names. */
  observe(sources: MetricSources): void {
    this.sources = { ...this.sources, ...sources };
  }

  replayed(kind: SocketKind): void {
    this.replays.inc({ kind });
  }

  rejected(reason: RejectionReason): void {
    this.rejections.inc({ reason });
  }

  forwarded(direction: Direction, bytes: number): void {
    this.bytesForwarded.inc({ direction }, bytes);
  }

  shed(kind: SocketKind): void {
    this.shedPeers.inc({ kind });
  }

  leaseRenewed(ok: boolean): void {
    this.leaseRenewals.inc({ result: ok ? 'ok' : 'failed' });
  }

  leaseLost(reason: LeaseLossReason): void {
    this.leaseLosses.inc({ reason });
  }

  servedAlone(): void {
    this.servedAloneLinks.inc();
  }

  pushFailed(): void {
    this.pushFailures.inc();
  }

  /** The Prometheus text exposition. */
  render(): Promise<string> {
    return this.registry.metrics();
  }
}

/** A gauge without labels that reads `read` at scrape time; `undefined` reads 0. */
function gauge(
  registers: Registry[],
  name: string,
  help: string,
  read: () => number | undefined,
): void {
  new Gauge({
    name,
    help,
    registers,
    collect() {
      const value = read();
      if (value === undefined) this.reset();
      else this.set(value);
    },
  });
}

/**
 * The Hono handler for `GET /metrics`. Without a token configured, metrics
 * are off and the route answers 404; with one, it wants
 * `Authorization: Bearer <RELAY_METRICS_TOKEN>` and answers 401 otherwise.
 */
export function metricsHandler(metrics: RelayMetrics, token: string | undefined) {
  return async (c: Context) => {
    c.header('cache-control', 'no-store');
    if (!token) {
      return c.json(
        { code: 'NOT_FOUND', message: 'Metrics are off; set RELAY_METRICS_TOKEN to turn them on' },
        404,
      );
    }
    const presented = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    if (!safeEqual(presented, token)) {
      c.header('www-authenticate', 'Bearer');
      return c.json(
        { code: 'UNAUTHORIZED', message: 'Send RELAY_METRICS_TOKEN as a bearer token' },
        401,
      );
    }
    return c.body(await metrics.render(), 200, { 'content-type': metrics.registry.contentType });
  };
}

/** Compares two strings in time that does not depend on where they differ, or on their lengths. */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b)) && a.length === b.length;
}
