import type { Logger } from 'pino';
import type { Presence } from './hosts.js';
import type { LeaseLossReason } from './metrics.js';
import { withTimeout, type Registry } from './registry.js';

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
// the cluster's size: below `minClusterSize` no new lease is taken. A machine
// that has not refreshed its node key for longer than its time to live may
// look dead to the others, which may then take its hosts, so it drops every
// lease it holds itself (1012) rather than serve a host another machine may
// now own.
//
// Every registry call has a time limit (`callTimeoutMs`). When the registry
// cannot be reached at all, a new host link is still served: the host is
// served on this machine alone, without a lease (single-machine mode, logged
// and counted), and each renewal tick tries to take its lease. Once the
// registry answers, the host keeps going here if no other live machine took
// it meanwhile, and is closed 1012 to reconnect to the owner if one did.
//
// Lease operations on one host run one at a time, in order, so a release
// queued by a closing link cannot overtake the claim of the next one, and a
// release waits while another link of the same host is still claiming here,
// so the lease passes from one link to the next without a gap.

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

/** How long one registry call may take before it counts as failed. */
export const DEFAULT_CALL_TIMEOUT_MS = 2_000;

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
  /** Whether a link of the host is between its hello and `linked` here. */
  isClaiming?(hostId: string): boolean;
  /** The lease was lost: close the host's links and streams. */
  onLost(hostId: string): void;
  /** How long one registry call may take. Default 2 seconds. */
  callTimeoutMs?: number;
  /** Counts each renewal, each lease lost or given up, and each host served without a lease (metrics.ts). */
  metrics?: {
    leaseRenewed(ok: boolean): void;
    leaseLost(reason: LeaseLossReason): void;
    servedAlone?(): void;
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
  /** Hosts served here without a lease while the registry could not be reached. */
  private readonly alone = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private clusterSizeSeen = 0;
  /** When the node key was last refreshed (stamped before the call), and whether the last try failed. */
  private heartbeatAt = Date.now();
  private heartbeatFailing = false;
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
    this.heartbeatAt = Date.now();
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
      await this.call(this.options.registry.alive(this.nodeId));
      return true;
    } catch {
      return false;
    }
  }

  /** True while the node key cannot be refreshed or a host is served without a lease. */
  get degraded(): boolean {
    return this.heartbeatFailing || this.alone.size > 0;
  }

  /** The hosts this machine holds a lease for. */
  ownedHosts(): string[] {
    return [...this.owned.keys()];
  }

  /** The hosts served here without a lease, in single-machine mode. */
  aloneHosts(): string[] {
    return [...this.alone];
  }

  owns(hostId: string): boolean {
    return this.owned.has(hostId);
  }

  /** Whether this machine serves the host: it holds the lease, or serves it alone during an outage. */
  serves(hostId: string): boolean {
    return this.owned.has(hostId) || this.alone.has(hostId);
  }

  /**
   * Where an upgrade for `hostId` goes. A registry that cannot be reached
   * serves locally: a host link then fails to take its lease and retries.
   */
  async route(hostId: string, replayed: boolean): Promise<Route> {
    if (this.serves(hostId)) return { kind: 'local' };
    const { registry } = this.options;
    try {
      const owner = await this.call(registry.owner(hostId));
      if (!owner || owner.nodeId === this.nodeId) return { kind: 'local' };
      if (!(await this.call(registry.alive(owner.nodeId)))) return { kind: 'local' };
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
      if (this.alone.has(hostId)) return { ok: true };
      if (!this.taking) return { ok: false, code: 1012, reason: 'relay draining' };
      if (this.clusterSizeSeen < this.options.minClusterSize) {
        return { ok: false, code: 1012, reason: 'cluster below its minimum size' };
      }
      const { registry, timing, logger } = this.options;
      const started = Date.now();
      let result;
      try {
        result = await this.call(
          registry.acquire(
            hostId,
            this.nodeId,
            timing.leaseMs,
            streams || this.options.hasStreams(hostId),
          ),
        );
      } catch (err) {
        // Better one machine serving the host than none: the renewal tick
        // takes its lease once the registry answers again.
        this.alone.add(hostId);
        this.options.metrics?.servedAlone?.();
        logger.warn(
          { err, hostId },
          'registry unreachable: serving this host on this machine alone, without a lease',
        );
        return { ok: true };
      }
      if (!result.ok) {
        logger.info({ hostId, owner: result.owner.nodeId }, 'host owned by another machine');
        return { ok: false, code: 1012, reason: 'host owned by another machine' };
      }
      this.owned.set(hostId, { epoch: result.epoch, renewedAt: started });
      logger.info({ hostId, epoch: result.epoch }, 'lease taken');
      return { ok: true };
    });
  }

  /** The host's links here changed: the lease's streams flag is brought up to date. */
  touch(hostId: string): void {
    void this.serial(hostId, () => this.renewOne(hostId));
  }

  /**
   * Gives up the host's lease once its last link here has gone. While another
   * link of the host is claiming here, the lease is kept for it, so it passes
   * from one link to the next without a moment in which nobody owns the host.
   */
  release(hostId: string): void {
    void this.serial(hostId, async () => {
      if (this.halted || this.options.hasLinks(hostId)) return;
      if (this.options.isClaiming?.(hostId)) return;
      if (this.alone.delete(hostId)) return;
      const held = this.owned.get(hostId);
      if (!held) return;
      this.owned.delete(hostId);
      this.options.metrics?.leaseLost('released');
      await this.call(this.options.registry.release(hostId, this.nodeId, held.epoch)).catch(
        (err: unknown) => {
          this.options.logger.warn({ err, hostId }, 'could not release a lease; it will expire');
        },
      );
    });
  }

  /** Presence (RELAY_PROTOCOL.md 3.5) from the registry, so any machine answers it. */
  async linked(hostId: string): Promise<boolean> {
    if (this.serves(hostId)) return this.options.hasStreams(hostId);
    const { registry } = this.options;
    const owner = await this.call(registry.owner(hostId));
    if (!owner?.streams || owner.nodeId === this.nodeId) return false;
    return this.call(registry.alive(owner.nodeId));
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
    this.alone.clear();
    for (let i = 0; i < held.length; i += 1) this.options.metrics?.leaseLost('released');
    await Promise.all(
      held.map(([hostId, lease]) =>
        this.call(registry.release(hostId, this.nodeId, lease.epoch)).catch((err: unknown) => {
          logger.warn({ err, hostId }, 'could not release a lease; it will expire');
        }),
      ),
    );
    await this.call(registry.leave(this.nodeId)).catch(() => undefined);
  }

  /**
   * Renews every lease now, and tries to take the lease of each host served
   * alone; the renewal tick, and a test's way to skip the wait.
   */
  renewAll(): Promise<void> {
    return Promise.all([
      ...[...this.owned.keys()].map((hostId) => this.serial(hostId, () => this.renewOne(hostId))),
      ...[...this.alone].map((hostId) => this.serial(hostId, () => this.adopt(hostId))),
    ]).then(() => undefined);
  }

  /** Refreshes the node key now; the heartbeat tick, and a test's way to skip the wait. */
  async heartbeat(): Promise<void> {
    if (this.halted) return;
    const { registry, timing, logger } = this.options;
    const started = Date.now();
    try {
      await this.call(registry.heartbeat(this.nodeId, timing.nodeTtlMs));
      // The key's time to live runs from when Redis set it, which is after this.
      this.heartbeatAt = started;
      this.heartbeatFailing = false;
      this.clusterSizeSeen = await this.call(registry.liveNodes());
    } catch (err) {
      this.heartbeatFailing = true;
      logger.warn({ err }, 'could not refresh the node key');
    }
    this.dropIfLapsed();
  }

  /**
   * The node key may have expired: to the others this machine may look dead,
   * and they may take its hosts at once. It gives every lease up itself, so
   * no host is served by two machines that each think they own it.
   */
  private dropIfLapsed(): void {
    if (this.halted || this.owned.size === 0) return;
    if (Date.now() - this.heartbeatAt <= this.options.timing.nodeTtlMs) return;
    const hosts = [...this.owned.keys()];
    this.owned.clear();
    this.options.logger.warn(
      { hosts: hosts.length },
      'node key may have lapsed: giving up every lease this machine holds',
    );
    for (const hostId of hosts) {
      this.options.metrics?.leaseLost('node_lapsed');
      this.options.onLost(hostId);
    }
  }

  /** Takes the lease of a host served alone, once the registry answers again. */
  private async adopt(hostId: string): Promise<void> {
    if (!this.alone.has(hostId) || this.halted || !this.taking) return;
    const { registry, timing, logger } = this.options;
    const started = Date.now();
    let result;
    try {
      result = await this.call(
        registry.acquire(hostId, this.nodeId, timing.leaseMs, this.options.hasStreams(hostId)),
      );
    } catch {
      return;
    }
    if (!this.alone.delete(hostId)) {
      // The host's last link went meanwhile: give back what was just taken.
      if (result.ok) {
        await this.call(registry.release(hostId, this.nodeId, result.epoch)).catch(() => undefined);
      }
      return;
    }
    if (result.ok) {
      this.owned.set(hostId, { epoch: result.epoch, renewedAt: started });
      logger.info({ hostId, epoch: result.epoch }, 'lease taken for a host served alone');
      return;
    }
    // Another machine took the host while the registry was away here.
    this.options.metrics?.leaseLost('stolen');
    logger.warn({ hostId, owner: result.owner.nodeId }, 'a host served alone is owned elsewhere');
    this.options.onLost(hostId);
  }

  private async renewOne(hostId: string, streams = false): Promise<void> {
    const held = this.owned.get(hostId);
    if (!held || this.halted) return;
    const { registry, timing, logger } = this.options;
    const metrics = this.options.metrics;
    let renewed: boolean;
    let reason: LeaseLossReason = 'renewal_failed';
    let counted = false;
    // The lease's time to live runs from when Redis renewed it, which is after this.
    const started = Date.now();
    try {
      renewed = await this.call(
        registry.renew(
          hostId,
          this.nodeId,
          held.epoch,
          timing.leaseMs,
          streams || this.options.hasStreams(hostId),
        ),
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
      held.renewedAt = started;
      return;
    }
    if (!counted && metrics) {
      // Who holds it now, for the metric: another machine, or this one with a newer epoch.
      const owner = await this.call(registry.owner(hostId)).catch(() => null);
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

  /** One registry call under the time limit. */
  private call<T>(promise: Promise<T>): Promise<T> {
    return withTimeout(promise, this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
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
