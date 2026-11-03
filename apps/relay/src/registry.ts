import { Redis } from 'ioredis';

// The shared registry of a relay cluster (MOBILE_AND_VM_PLAN.md 5.8): which
// machine owns each host id, which machines are alive, and the per-host
// counters of RELAY_PROTOCOL.md 3.4. One machine owns a host at a time and
// every link and stream of that host terminates there, so the registry holds
// routing facts only, never bytes.
//
// A lease is `<nodeId>:<epoch>` under `relay:host:<hostId>`, taken with a
// fresh epoch from `INCR relay:epoch:<hostId>` (a fencing token) and kept
// alive by its owner with compare-and-renew. A lease whose owner's node key
// (`relay:node:<nodeId>`) is gone may be taken over at once instead of waiting
// for it to expire. Beside the lease, `relay:host:<hostId>:streams` says
// whether the owner holds a `streams` link, which is what presence answers.
//
// `MemoryRegistry` is the same contract in one process: the default without
// Redis, so a single machine behaves as before, and shareable by several
// relays in one test process. `RedisRegistry` is the cluster's.

/** Who owns a host: the machine, the epoch it took the lease with, and whether it serves streams. */
export interface Lease {
  nodeId: string;
  epoch: number;
  streams: boolean;
}

export type AcquireResult = { ok: true; epoch: number } | { ok: false; owner: Lease };

export interface Registry {
  /**
   * Takes the host's lease for `nodeId` with a new epoch, unless another
   * machine whose node key is alive holds it (then answers that owner). A
   * lease this node holds from an earlier life is taken again with a new epoch.
   */
  acquire(hostId: string, nodeId: string, ttlMs: number, streams: boolean): Promise<AcquireResult>;
  /** Refreshes the lease if it is still exactly `nodeId:epoch`; false means it was lost. */
  renew(
    hostId: string,
    nodeId: string,
    epoch: number,
    ttlMs: number,
    streams: boolean,
  ): Promise<boolean>;
  /** Gives the lease up if it is still exactly `nodeId:epoch`. */
  release(hostId: string, nodeId: string, epoch: number): Promise<boolean>;
  /** The host's lease, or null when nobody holds one. The owner may be dead; ask `alive`. */
  owner(hostId: string): Promise<Lease | null>;
  /** Sets or refreshes this machine's node key. */
  heartbeat(nodeId: string, ttlMs: number): Promise<void>;
  /** Deletes this machine's node key, on a clean shutdown. */
  leave(nodeId: string): Promise<void>;
  /** Whether the machine's node key is alive. */
  alive(nodeId: string): Promise<boolean>;
  /** How many node keys are alive: the cluster's size. */
  liveNodes(): Promise<number>;
  /**
   * Adds `n` to the counter `key` unless the total would pass `limit`; the
   * counter expires `ttlMs` after its first use (`INCRBY` with `PEXPIRE`).
   * Answers whether `n` was counted.
   */
  take(key: string, n: number, limit: number, ttlMs: number): Promise<boolean>;
  /** Adds `n` to the counter `key` (as `take`, with no limit) and answers its total. */
  add(key: string, n: number, ttlMs: number): Promise<number>;
  close(): Promise<void>;
}

export const HOST_KEY = 'relay:host:';
export const EPOCH_KEY = 'relay:epoch:';
export const NODE_KEY = 'relay:node:';
export const COUNTER_KEY = 'relay:limit:';
const STREAMS_SUFFIX = ':streams';

/** Parses `<nodeId>:<epoch>`; a node id may itself hold colons. */
function parseLease(value: string, streams: boolean): Lease | null {
  const at = value.lastIndexOf(':');
  if (at <= 0) return null;
  const epoch = Number(value.slice(at + 1));
  if (!Number.isSafeInteger(epoch)) return null;
  return { nodeId: value.slice(0, at), epoch, streams };
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/**
 * The registry in one process. Expiry is checked on read, so it needs no
 * timers. Several relays in one process may share one, which is how the
 * cluster tests stand in for Redis.
 */
export class MemoryRegistry implements Registry {
  private readonly leases = new Map<string, Expiring<Lease>>();
  private readonly epochs = new Map<string, number>();
  private readonly nodes = new Map<string, number>();
  private readonly counters = new Map<string, Expiring<number>>();

  constructor(private readonly now: () => number = Date.now) {}

  private lease(hostId: string): Lease | null {
    const entry = this.leases.get(hostId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.leases.delete(hostId);
      return null;
    }
    return entry.value;
  }

  private isAlive(nodeId: string): boolean {
    const expiresAt = this.nodes.get(nodeId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.nodes.delete(nodeId);
      return false;
    }
    return true;
  }

  acquire(hostId: string, nodeId: string, ttlMs: number, streams: boolean) {
    const current = this.lease(hostId);
    if (current && current.nodeId !== nodeId && this.isAlive(current.nodeId)) {
      return Promise.resolve<AcquireResult>({ ok: false, owner: { ...current } });
    }
    const epoch = (this.epochs.get(hostId) ?? 0) + 1;
    this.epochs.set(hostId, epoch);
    this.leases.set(hostId, { value: { nodeId, epoch, streams }, expiresAt: this.now() + ttlMs });
    return Promise.resolve<AcquireResult>({ ok: true, epoch });
  }

  renew(hostId: string, nodeId: string, epoch: number, ttlMs: number, streams: boolean) {
    const current = this.lease(hostId);
    if (!current || current.nodeId !== nodeId || current.epoch !== epoch) {
      return Promise.resolve(false);
    }
    this.leases.set(hostId, { value: { nodeId, epoch, streams }, expiresAt: this.now() + ttlMs });
    return Promise.resolve(true);
  }

  release(hostId: string, nodeId: string, epoch: number) {
    const current = this.lease(hostId);
    if (!current || current.nodeId !== nodeId || current.epoch !== epoch) {
      return Promise.resolve(false);
    }
    this.leases.delete(hostId);
    return Promise.resolve(true);
  }

  owner(hostId: string) {
    const current = this.lease(hostId);
    return Promise.resolve(current ? { ...current } : null);
  }

  heartbeat(nodeId: string, ttlMs: number) {
    this.nodes.set(nodeId, this.now() + ttlMs);
    return Promise.resolve();
  }

  leave(nodeId: string) {
    this.nodes.delete(nodeId);
    return Promise.resolve();
  }

  alive(nodeId: string) {
    return Promise.resolve(this.isAlive(nodeId));
  }

  liveNodes() {
    let count = 0;
    for (const nodeId of [...this.nodes.keys()]) if (this.isAlive(nodeId)) count += 1;
    return Promise.resolve(count);
  }

  private counter(key: string, ttlMs: number): Expiring<number> {
    let entry = this.counters.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      entry = { value: 0, expiresAt: this.now() + ttlMs };
      this.counters.set(key, entry);
    }
    return entry;
  }

  take(key: string, n: number, limit: number, ttlMs: number) {
    const entry = this.counter(key, ttlMs);
    if (entry.value + n > limit) return Promise.resolve(false);
    entry.value += n;
    return Promise.resolve(true);
  }

  add(key: string, n: number, ttlMs: number) {
    const entry = this.counter(key, ttlMs);
    entry.value += n;
    return Promise.resolve(entry.value);
  }

  close() {
    // Expired counters are dropped here as well as on read, so a long test
    // process does not keep every window it ever used.
    const now = this.now();
    for (const [key, entry] of this.counters) if (entry.expiresAt <= now) this.counters.delete(key);
    return Promise.resolve();
  }
}

// KEYS[1] lease, KEYS[2] epoch counter, KEYS[3] streams flag.
// ARGV[1] node id, ARGV[2] ttl ms, ARGV[3] "1" when the owner serves streams,
// ARGV[4] the node key prefix.
// Answers {1, epoch} when taken, {0, current lease, streams flag} when held.
const ACQUIRE = `
local current = redis.call('GET', KEYS[1])
if current then
  local owner = string.match(current, '^(.*):%d+$')
  if owner and owner ~= ARGV[1] and redis.call('EXISTS', ARGV[4] .. owner) == 1 then
    return {0, current, redis.call('EXISTS', KEYS[3])}
  end
end
local epoch = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. epoch, 'PX', ARGV[2])
if ARGV[3] == '1' then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[2])
else
  redis.call('DEL', KEYS[3])
end
return {1, epoch}
`;

// KEYS[1] lease, KEYS[2] streams flag. ARGV[1] `node:epoch`, ARGV[2] ttl ms,
// ARGV[3] "1" when the owner serves streams. Answers 1 when renewed.
const RENEW = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if ARGV[3] == '1' then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
else
  redis.call('DEL', KEYS[2])
end
return 1
`;

// KEYS[1] lease, KEYS[2] streams flag. ARGV[1] `node:epoch`. Answers 1 when released.
const RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

// KEYS[1] counter. ARGV[1] n, ARGV[2] limit (or -1 for none), ARGV[3] ttl ms.
// Answers {counted, total}.
const TAKE = `
local n = tonumber(ARGV[1])
local total = redis.call('INCRBY', KEYS[1], n)
if total == n then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
local limit = tonumber(ARGV[2])
if limit >= 0 and total > limit then
  total = redis.call('DECRBY', KEYS[1], n)
  return {0, total}
end
return {1, total}
`;

export interface RedisRegistryOptions {
  /** A `redis://` URL, or a client to use (and not close). */
  redis: string | Redis;
}

/** The registry on Redis, for a relay of several machines. */
export class RedisRegistry implements Registry {
  readonly redis: Redis;
  private readonly owned: boolean;

  constructor(options: RedisRegistryOptions) {
    if (typeof options.redis === 'string') {
      this.redis = new Redis(options.redis, { lazyConnect: false, maxRetriesPerRequest: 2 });
      this.owned = true;
    } else {
      this.redis = options.redis;
      this.owned = false;
    }
  }

  async acquire(hostId: string, nodeId: string, ttlMs: number, streams: boolean) {
    const reply = (await this.redis.eval(
      ACQUIRE,
      3,
      HOST_KEY + hostId,
      EPOCH_KEY + hostId,
      HOST_KEY + hostId + STREAMS_SUFFIX,
      nodeId,
      String(ttlMs),
      streams ? '1' : '0',
      NODE_KEY,
    )) as [number, number | string, number?];
    if (reply[0] === 1) return { ok: true, epoch: Number(reply[1]) } as const;
    const owner = parseLease(String(reply[1]), reply[2] === 1);
    if (!owner) throw new Error(`malformed lease for ${hostId}`);
    return { ok: false, owner } as const;
  }

  async renew(hostId: string, nodeId: string, epoch: number, ttlMs: number, streams: boolean) {
    const reply = await this.redis.eval(
      RENEW,
      2,
      HOST_KEY + hostId,
      HOST_KEY + hostId + STREAMS_SUFFIX,
      `${nodeId}:${epoch}`,
      String(ttlMs),
      streams ? '1' : '0',
    );
    return reply === 1;
  }

  async release(hostId: string, nodeId: string, epoch: number) {
    const reply = await this.redis.eval(
      RELEASE,
      2,
      HOST_KEY + hostId,
      HOST_KEY + hostId + STREAMS_SUFFIX,
      `${nodeId}:${epoch}`,
    );
    return reply === 1;
  }

  async owner(hostId: string) {
    const [value, streams] = await this.redis.mget(
      HOST_KEY + hostId,
      HOST_KEY + hostId + STREAMS_SUFFIX,
    );
    return value ? parseLease(value, streams === '1') : null;
  }

  async heartbeat(nodeId: string, ttlMs: number) {
    await this.redis.set(NODE_KEY + nodeId, '1', 'PX', ttlMs);
  }

  async leave(nodeId: string) {
    await this.redis.del(NODE_KEY + nodeId);
  }

  async alive(nodeId: string) {
    return (await this.redis.exists(NODE_KEY + nodeId)) === 1;
  }

  async liveNodes() {
    // A cluster has a handful of machines, so a scan of their keys is cheap.
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${NODE_KEY}*`, 'COUNT', 100);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  async take(key: string, n: number, limit: number, ttlMs: number) {
    const reply = (await this.redis.eval(
      TAKE,
      1,
      key,
      String(n),
      String(limit),
      String(ttlMs),
    )) as [number, number];
    return reply[0] === 1;
  }

  async add(key: string, n: number, ttlMs: number) {
    const reply = (await this.redis.eval(TAKE, 1, key, String(n), '-1', String(ttlMs))) as [
      number,
      number,
    ];
    return reply[1];
  }

  async close() {
    if (this.owned) await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/** The counter key of one fixed window: `relay:limit:<kind>:<hostId>:<window index>`. */
export function counterKey(kind: string, hostId: string, windowMs: number, now: number): string {
  return `${COUNTER_KEY}${kind}:${hostId}:${Math.floor(now / windowMs)}`;
}
