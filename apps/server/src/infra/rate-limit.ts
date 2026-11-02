import { Redis } from 'ioredis';

// Token buckets for the HTTP edge (plan 17 control 6; S-6, S-14): better-auth's
// limiter and webhook ingress. A bucket holds `max` tokens and refills at
// `max` per `window` seconds; each request takes one. Each take is a single
// atomic step, a Lua script in Redis or a synchronous update in memory, so
// concurrent requests cannot all pass on a stale count. Redis-backed buckets
// are shared by every API process; in-memory ones belong to one process.

export interface RateLimitRule {
  /** Seconds to refill a whole bucket. */
  window: number;
  /** Bucket size: the burst allowed, and the requests per `window` sustained. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next token, when not allowed. */
  retryAfter: number | null;
}

export interface RateLimiter {
  /** Takes one token from the bucket at `key`. */
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  close(): Promise<void>;
}

const KEY_PREFIX = 'openbots:rl:';

interface Bucket {
  tokens: number;
  at: number;
}

/** One step of a bucket at time `now` (ms); shared by the memory limiter and its tests. */
export function takeToken(
  bucket: Bucket | undefined,
  { window, max }: RateLimitRule,
  now: number,
): { bucket: Bucket; result: RateLimitResult } {
  const perMs = max / (window * 1000);
  const elapsed = bucket ? Math.max(0, now - bucket.at) : 0;
  let tokens = bucket ? Math.min(max, bucket.tokens + elapsed * perMs) : max;
  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;
  return {
    bucket: { tokens, at: now },
    result: { allowed, retryAfter: allowed ? null : Math.ceil((1 - tokens) / perMs / 1000) },
  };
}

const MEMORY_MAX_KEYS = 100_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket & { expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = this.now();
    if (this.buckets.size >= MEMORY_MAX_KEYS) this.prune(now);
    const { bucket, result } = takeToken(this.buckets.get(key), rule, now);
    // A full bucket is the same as no bucket, so it can go once refilled.
    this.buckets.set(key, { ...bucket, expiresAt: now + rule.window * 1000 });
    return result;
  }

  private prune(now: number) {
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
    // Still full: drop the oldest, which only ever lets a client through early.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MEMORY_MAX_KEYS) break;
      this.buckets.delete(key);
    }
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}

// KEYS[1] the bucket; ARGV window (ms), max. Returns {allowed, retry ms}.
const TAKE_SCRIPT = `
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
local per_ms = max / window
if tokens == nil or at == nil then
  tokens = max
else
  tokens = math.min(max, tokens + math.max(0, now - at) * per_ms)
end
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / per_ms)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], window)
return {allowed, retry}
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;

  constructor(url: string, onError: (error: unknown) => void = () => {}) {
    this.redis = new Redis(url);
    this.redis.on('error', onError);
  }

  async consume(key: string, { window, max }: RateLimitRule): Promise<RateLimitResult> {
    const [allowed, retryMs] = (await this.redis.eval(
      TAKE_SCRIPT,
      1,
      KEY_PREFIX + key,
      String(window * 1000),
      String(max),
    )) as [number, number];
    return allowed === 1
      ? { allowed: true, retryAfter: null }
      : { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
