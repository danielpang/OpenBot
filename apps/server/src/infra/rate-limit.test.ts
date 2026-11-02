import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RedisRateLimiter, takeToken, type RateLimiter } from './rate-limit.js';

const redisUrl = process.env.REDIS_URL;

const backends: [string, (() => RateLimiter) | undefined][] = [
  ['memory', () => new MemoryRateLimiter()],
  ['redis', redisUrl ? () => new RedisRateLimiter(redisUrl) : undefined],
];

describe.each(backends)('%s rate limiter', (_, make) => {
  const open: RateLimiter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((limiter) => limiter.close()));
  });

  it.skipIf(!make)('allows a burst of max, then refuses with a retry time', async () => {
    const limiter = make!();
    open.push(limiter);
    const key = `test:${randomUUID()}`;
    const rule = { window: 60, max: 3 };
    for (let i = 0; i < 3; i++) {
      expect(await limiter.consume(key, rule)).toEqual({ allowed: true, retryAfter: null });
    }
    const refused = await limiter.consume(key, rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(20);
    // Another key has its own bucket.
    expect((await limiter.consume(`${key}:other`, rule)).allowed).toBe(true);
  });

  it.skipIf(!make)('counts concurrent requests atomically', async () => {
    const limiter = make!();
    open.push(limiter);
    const key = `test:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume(key, { window: 60, max: 5 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});

describe('token bucket', () => {
  it('refills at max per window', () => {
    const rule = { window: 60, max: 6 };
    let bucket: Parameters<typeof takeToken>[0];
    for (let i = 0; i < 6; i++) bucket = takeToken(bucket, rule, 0).bucket;
    expect(takeToken(bucket, rule, 0).result).toEqual({ allowed: false, retryAfter: 10 });
    // One token every 10 s.
    expect(takeToken(bucket, rule, 9_999).result.allowed).toBe(false);
    expect(takeToken(bucket, rule, 10_000).result.allowed).toBe(true);
    // Never more than max, however long it waited.
    const later = takeToken(bucket, rule, 3_600_000).bucket;
    expect(later.tokens).toBe(5);
  });

  it('forgets a bucket once it would be full again', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const rule = { window: 10, max: 1 };
    expect((await limiter.consume('k', rule)).allowed).toBe(true);
    expect((await limiter.consume('k', rule)).allowed).toBe(false);
    now = 10_000;
    expect((await limiter.consume('k', rule)).allowed).toBe(true);
  });
});
