import type { Logger } from 'pino';
import type { Presence } from './hosts.js';
import type { LeaseLossReason } from './metrics.js';
import type { Registry } from './registry.js';

// Which hosts this machine owns (MOBILE_AND_VM_PLAN.md 5.8). A machine that
// holds a host's lease terminates every link and stream of that host; another
// machine that gets an upgrade for it answers with a replay to the owner
// (relay.ts). This module keeps the leases: it takes one when a host's first
// link here proves its id, renews each every `renewMs` with compare-and-renew,
// gives it up when the host's last link here goes, and calls `onLost` when a
// renewal finds the lease gone or held by a newer epoch, which closes the
// host's links and streams with 1012. A renewal that fails because the
// registry cannot be reached keeps the host until the lease would have run
// out, so a short registry outage costs no reconnects.
//
// The machine's node key is refreshed every `heartbeatMs`, which also reads
// the cluster's size: below `minClusterSize` no new lease is taken.
//
// Lease operations on one host run one at a time, in order, so a release
// queued by a closing link cannot overtake the claim of the next one.

export interface ClusterTiming {
  /** A lease's time to live. */
  leaseMs: number;
  /** How often the owner renews each lease. */
  renewMs: number;
  /** The node key's time to live. */
  nodeTtlMs: number;
  /** How often the node key is refreshed. */
  heartbeatMs: number;
}

export const DEFAULT_CLUSTER_TIMING: ClusterTiming = {
  leaseMs: 30_000,
  renewMs: 10_000,
  nodeTtlMs: 15_000,
  heartbeatMs: 5_000,
};

/** Where an upgrade for a host is served. */
export type Route =
  /** Here: this machine owns the host, or no live machine does. */
  | { kind: 'local' }
  /** Answer with `fly-replay: instance=<nodeId>`. */
  | { kind: 'replay'; nodeId: string }
  /** Another live machine owns the host, but the request was replayed once already. */
  | { kind: 'elsewhere'; nodeId: string };

export type ClaimResult = { ok: true } | { ok: false; code: number; reason: string };

export interface OwnershipOptions {
  nodeId: string;
  registry: Registry;
  timing: ClusterTiming;
  /** Below this many live machines, no new lease is taken. */
  minClusterSize: number;
  logger: Logger;
  /** Whether this machine holds any link of the host. */
  hasLinks(hostId: string): boolean;
  /** Whether this machine holds a `streams` link of the host. */
  hasStreams(hostId: string): boolean;
  /** The lease was lost: close the host's links and streams. */
  onLost(hostId: string): void;
  /** Counts each renewal and each lease lost or given up (metrics.ts). */
  metrics?: {
    leaseRenewed(ok: boolean): void;
    leaseLost(reason: LeaseLossReason): void;
  };
}

interface Held {
  epoch: number;
  /** When the registry last confirmed the lease. */
  renewedAt: number;
}

/** Closes for a link that cannot be served here; the host reconnects through routing. */
export const LEASE_LOST = { code: 1012, reason: 'lease lost' } as const;

export class Ownership implements Presence {
  readonly nodeId: string;
  private readonly owned = new Map<string, Held>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private clusterSizeSeen = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private halted = false;
  /** Cleared by a drain: no new lease is taken. */
  private taking = true;

  constructor(private readonly options: OwnershipOptions) {
    this.nodeId = options.nodeId;
  }

  /** Writes the node key once, then keeps it and the leases fresh. */
  async start(): Promise<void> {
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.timing.heartbeatMs);
    this.heartbeatTimer.unref();
    this.renewTimer = setInterval(() => this.renewAll(), this.options.timing.renewMs);
    this.renewTimer.unref();
  }

  /** Live machines when the node key was last refreshed, this one included. */
  get clusterSize(): number {
    return this.clusterSizeSeen;
  }

  /** Takes no new lease from now on; the leases held are kept until `stop`. A drain does this. */
  stopTaking(): void {
    this.taking = false;
  }

  /** Whether the registry answers right now, for `/ready`. */
  async registryReachable(): Promise<boolean> {
    try {
      await this.options.registry.alive(this.nodeId);
      return true;
    } catch {
      return false;
    }
  }

  /** The hosts this machine holds a lease for. */
  ownedHosts(): string[] {
    return [...this.owned.keys()];
  }

  owns(hostId: string): boolean {
    return this.owned.has(hostId);
  }

  /**
   * Where an upgrade for `hostId` goes. A registry that cannot be reached
   * serves locally: a host link then fails to take its lease and retries.
   */
  async route(hostId: string, replayed: boolean): Promise<Route> {
    if (this.owned.has(hostId)) return { kind: 'local' };
    const { registry } = this.options;
    try {
      const owner = await registry.owner(hostId);
      if (!owner || owner.nodeId === this.nodeId) return { kind: 'local' };
      if (!(await registry.alive(owner.nodeId))) return { kind: 'local' };
      return replayed
        ? { kind: 'elsewhere', nodeId: owner.nodeId }
        : { kind: 'replay', nodeId: owner.nodeId };
    } catch (err) {
      this.options.logger.warn({ err, hostId }, 'registry unavailable; serving locally');
      return { kind: 'local' };
    }
  }

  /**
   * Takes the host's lease for a link that proved its id, or keeps it when
   * this machine owns it already. `streams` says whether that link serves
   * streams, since it is not in the host's links yet.
   */
  claim(hostId: string, streams: boolean): Promise<ClaimResult> {
    return this.serial(hostId, async (): Promise<ClaimResult> => {
      if (this.halted) return { ok: false, code: 1012, reason: 'relay stopping' };
      if (this.owned.has(hostId)) {
        await this.renewOne(hostId, streams);
        return this.owned.has(hostId) ? { ok: true } : { ok: false, ...LEASE_LOST };
      }
      if (!this.taking) return { ok: false, code: 1012, reason: 'relay draining' };
      if (this.clusterSizeSeen < this.options.minClusterSize) {
        return { ok: false, code: 1012, reason: 'cluster below its minimum size' };
      }
      const { registry, timing, logger } = this.options;
      let result;
      try {
        result = await registry.acquire(
          hostId,
          this.nodeId,
          timing.leaseMs,
          streams || this.options.hasStreams(hostId),
        );
      } catch (err) {
        logger.warn({ err, hostId }, 'could not take a lease');
        return { ok: false, code: 1012, reason: 'registry unavailable' };
      }
      if (!result.ok) {
        logger.info({ hostId, owner: result.owner.nodeId }, 'host owned by another machine');
        return { ok: false, code: 1012, reason: 'host owned by another machine' };
      }
      this.owned.set(hostId, { epoch: result.epoch, renewedAt: Date.now() });
      logger.info({ hostId, epoch: result.epoch }, 'lease taken');
      return { ok: true };
    });
  }

  /** The host's links here changed: the lease's streams flag is brought up to date. */
  touch(hostId: string): void {
    void this.serial(hostId, () => this.renewOne(hostId));
  }

  /** Gives up the host's lease once its last link here has gone. */
  release(hostId: string): void {
    void this.serial(hostId, async () => {
      if (this.halted || this.options.hasLinks(hostId)) return;
      const held = this.owned.get(hostId);
      if (!held) return;
      this.owned.delete(hostId);
      this.options.metrics?.leaseLost('released');
      await this.options.registry.release(hostId, this.nodeId, held.epoch).catch((err: unknown) => {
        this.options.logger.warn({ err, hostId }, 'could not release a lease; it will expire');
      });
    });
  }

  /** Presence (RELAY_PROTOCOL.md 3.5) from the registry, so any machine answers it. */
  async linked(hostId: string): Promise<boolean> {
    if (this.owned.has(hostId)) return this.options.hasStreams(hostId);
    const { registry } = this.options;
    const owner = await registry.owner(hostId);
    if (!owner?.streams || owner.nodeId === this.nodeId) return false;
    return registry.alive(owner.nodeId);
  }

  /**
   * Stops renewing. With `release`, every lease and the node key are given
   * up, so other machines may take the hosts at once; without it (a crash,
   * in tests) they are left to expire.
   */
  async stop(release: boolean): Promise<void> {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.renewTimer);
    if (!release) {
      this.halted = true;
      return;
    }
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => undefined)));
    this.halted = true;
    const { registry, logger } = this.options;
    const held = [...this.owned];
    this.owned.clear();
    for (let i = 0; i < held.length; i += 1) this.options.metrics?.leaseLost('released');
    await Promise.all(
      held.map(([hostId, lease]) =>
        registry.release(hostId, this.nodeId, lease.epoch).catch((err: unknown) => {
          logger.warn({ err, hostId }, 'could not release a lease; it will expire');
        }),
      ),
    );
    await registry.leave(this.nodeId).catch(() => undefined);
  }

  /** Renews every lease now; the renewal tick, and a test's way to skip the wait. */
  renewAll(): Promise<void> {
    return Promise.all(
      [...this.owned.keys()].map((hostId) => this.serial(hostId, () => this.renewOne(hostId))),
    ).then(() => undefined);
  }

  private async heartbeat(): Promise<void> {
    if (this.halted) return;
    const { registry, timing, logger } = this.options;
    try {
      await registry.heartbeat(this.nodeId, timing.nodeTtlMs);
      this.clusterSizeSeen = await registry.liveNodes();
    } catch (err) {
      logger.warn({ err }, 'could not refresh the node key');
    }
  }

  private async renewOne(hostId: string, streams = false): Promise<void> {
    const held = this.owned.get(hostId);
    if (!held || this.halted) return;
    const { registry, timing, logger } = this.options;
    const metrics = this.options.metrics;
    let renewed: boolean;
    let reason: LeaseLossReason = 'renewal_failed';
    let counted = false;
    try {
      renewed = await registry.renew(
        hostId,
        this.nodeId,
        held.epoch,
        timing.leaseMs,
        streams || this.options.hasStreams(hostId),
      );
    } catch (err) {
      metrics?.leaseRenewed(false);
      counted = true;
      if (Date.now() - held.renewedAt < timing.leaseMs) {
        logger.warn({ err, hostId }, 'could not renew a lease; keeping it for now');
        return;
      }
      renewed = false;
    }
    if (this.owned.get(hostId) !== held) return;
    if (renewed) {
      metrics?.leaseRenewed(true);
      held.renewedAt = Date.now();
      return;
    }
    if (!counted && metrics) {
      // Who holds it now, for the metric: another machine, or this one with a newer epoch.
      const owner = await registry.owner(hostId).catch(() => null);
      if (owner && owner.nodeId !== this.nodeId) reason = 'stolen';
      else if (owner && owner.epoch > held.epoch) reason = 'newer_epoch';
    }
    if (this.owned.get(hostId) !== held) return;
    this.owned.delete(hostId);
    if (!counted) metrics?.leaseRenewed(false);
    metrics?.leaseLost(reason);
    logger.warn({ hostId, epoch: held.epoch, reason }, 'lease lost');
    this.options.onLost(hostId);
  }

  private serial<T>(hostId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(hostId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.queues.set(hostId, tail);
    void tail.then(() => {
      if (this.queues.get(hostId) === tail) this.queues.delete(hostId);
    });
    return next;
  }
}
