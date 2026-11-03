import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { counterKey, MemoryRegistry, RedisRegistry, type Registry } from './registry.js';

// The registry's contract (MOBILE_AND_VM_PLAN.md 5.8): leases with a fencing
// epoch, takeover from a dead node, compare-and-renew and compare-and-release,
// node liveness and the counters. The same cases run on MemoryRegistry and,
// when REDIS_URL is set, on RedisRegistry, which is where the Lua scripts run.

const redisUrl = process.env.REDIS_URL;
const unique = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

const opened: Registry[] = [];
afterAll(async () => {
  await Promise.all(opened.map((registry) => registry.close()));
});

function contract(name: string, make: () => Registry) {
  describe(`${name} registry`, () => {
    const registry = make();
    opened.push(registry);

    it('takes a free lease with a new epoch and answers its owner', async () => {
      const host = unique('host');
      const node = unique('node');
      expect(await registry.owner(host)).toBeNull();
      const taken = await registry.acquire(host, node, 5_000, true);
      expect(taken).toEqual({ ok: true, epoch: 1 });
      expect(await registry.owner(host)).toEqual({ nodeId: node, epoch: 1, streams: true });
    });

    it('refuses a lease a live node holds, and answers that owner', async () => {
      const host = unique('host');
      const [a, b] = [unique('a'), unique('b')];
      await registry.heartbeat(a, 5_000);
      await registry.acquire(host, a, 5_000, false);
      expect(await registry.acquire(host, b, 5_000, true)).toEqual({
        ok: false,
        owner: { nodeId: a, epoch: 1, streams: false },
      });
      await registry.leave(a);
    });

    it('takes over at once from a node whose key is gone, with a newer epoch', async () => {
      const host = unique('host');
      const [a, b] = [unique('a'), unique('b')];
      await registry.heartbeat(a, 5_000);
      await registry.acquire(host, a, 60_000, true);
      await registry.leave(a);
      expect(await registry.alive(a)).toBe(false);
      expect(await registry.acquire(host, b, 5_000, true)).toEqual({ ok: true, epoch: 2 });
      // The old owner's renewal and release now fail: the fencing check.
      expect(await registry.renew(host, a, 1, 5_000, true)).toBe(false);
      expect(await registry.release(host, a, 1)).toBe(false);
      expect((await registry.owner(host))?.nodeId).toBe(b);
    });

    it('retakes its own stale lease with a newer epoch', async () => {
      const host = unique('host');
      const node = unique('node');
      await registry.heartbeat(node, 5_000);
      await registry.acquire(host, node, 5_000, true);
      expect(await registry.acquire(host, node, 5_000, true)).toEqual({ ok: true, epoch: 2 });
      await registry.leave(node);
    });

    it('renews only the exact lease, and updates its streams flag', async () => {
      const host = unique('host');
      const node = unique('node');
      await registry.acquire(host, node, 200, false);
      expect(await registry.renew(host, node, 1, 5_000, true)).toBe(true);
      expect(await registry.owner(host)).toMatchObject({ streams: true });
      expect(await registry.renew(host, node, 2, 5_000, true)).toBe(false);
      expect(await registry.renew(host, 'someone-else', 1, 5_000, true)).toBe(false);
      // Renewed past its first time to live.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await registry.owner(host)).toMatchObject({ nodeId: node, epoch: 1 });
      expect(await registry.renew(host, node, 1, 5_000, false)).toBe(true);
      expect(await registry.owner(host)).toMatchObject({ streams: false });
    });

    it('lets a lease expire when it is not renewed', async () => {
      const host = unique('host');
      await registry.acquire(host, unique('node'), 100, true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await registry.owner(host)).toBeNull();
    });

    it('releases only the exact lease', async () => {
      const host = unique('host');
      const node = unique('node');
      await registry.acquire(host, node, 5_000, true);
      expect(await registry.release(host, node, 7)).toBe(false);
      expect(await registry.release(host, node, 1)).toBe(true);
      expect(await registry.owner(host)).toBeNull();
      expect(await registry.release(host, node, 1)).toBe(false);
    });

    it('keeps node keys alive while they are refreshed and counts them', async () => {
      const node = unique('node');
      await registry.heartbeat(node, 150);
      expect(await registry.alive(node)).toBe(true);
      // Other suites share the database, so only a lower bound holds.
      expect(await registry.liveNodes()).toBeGreaterThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await registry.alive(node)).toBe(false);
    });

    it('counts up to a limit, and only what it counted', async () => {
      const key = counterKey('opens', unique('host'), 3_600_000, Date.now());
      expect(await registry.take(key, 1, 2, 5_000)).toBe(true);
      expect(await registry.take(key, 1, 2, 5_000)).toBe(true);
      expect(await registry.take(key, 1, 2, 5_000)).toBe(false);
      expect(await registry.add(key, 0, 5_000)).toBe(2);
      expect(await registry.add(key, 5, 5_000)).toBe(7);
    });

    it('starts a counter over once it expires', async () => {
      const key = counterKey('pushes', unique('host'), 3_600_000, Date.now());
      expect(await registry.take(key, 2, 2, 100)).toBe(true);
      expect(await registry.take(key, 1, 2, 100)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await registry.take(key, 1, 2, 100)).toBe(true);
    });
  });
}

contract('memory', () => new MemoryRegistry());

if (redisUrl) {
  contract('redis', () => new RedisRegistry({ redis: redisUrl }));
} else {
  describe.skip('redis registry (set REDIS_URL to run)', () => {
    it('runs the contract on Redis', () => undefined);
  });
}

describe('counterKey', () => {
  it('names one fixed window', () => {
    expect(counterKey('bytes', 'h', 60_000, 120_001)).toBe('relay:limit:bytes:h:2');
  });
});
