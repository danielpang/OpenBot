import { describe, expect, it } from 'vitest';
import { MemoryRegistry, counterKey } from './registry.js';
import { connectClient, linkHost, makeHost, Peer, startRelay, wsUrl } from './test/helpers.js';

// The per-host limits of RELAY_PROTOCOL.md 3.4 while the registry's counters
// cannot be reached: each host falls back to a local window counter with the
// same limits, and the shared counters are used again once the registry
// answers. The leases still work here; only `take` and `add` fail.

const HOUR_MS = 3_600_000;

/** A registry whose counters throw while `broken` is set, as an unreachable Redis would. */
class FlakyCounters extends MemoryRegistry {
  broken = false;

  override take(key: string, n: number, limit: number, ttlMs: number) {
    if (this.broken) return Promise.reject(new Error('registry unreachable'));
    return super.take(key, n, limit, ttlMs);
  }

  override add(key: string, n: number, ttlMs: number) {
    if (this.broken) return Promise.reject(new Error('registry unreachable'));
    return super.add(key, n, ttlMs);
  }
}

const push = (id: string) => ({
  type: 'push',
  id,
  platform: 'ios',
  token: 'ab',
  ciphertext: 'AA',
  priority: 5,
  expiresAt: 0,
});

describe('per-host limits without the registry', () => {
  it('still limits stream opens per host', async () => {
    const registry = new FlakyCounters();
    registry.broken = true;
    const relay = await startRelay({ registry, limits: { opensPerHour: 2 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    for (let i = 0; i < 2; i += 1) {
      const { client } = await connectClient(relay, host, link);
      client.socket.close();
      await client.closed;
      await link.text();
    }
    const third = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await third.closed).toEqual({ code: 4429, reason: 'too many stream opens' });
    // Another host has its own counter.
    const other = makeHost();
    const otherLink = await linkHost(relay, other);
    await connectClient(relay, other, otherLink);
  });

  it('answers a push past the local limit with error 429', async () => {
    const registry = new FlakyCounters();
    registry.broken = true;
    const relay = await startRelay({
      registry,
      limits: { pushesPerHour: 1 },
      apns: { send: async () => ({ ok: true }), close: async () => {} },
    });
    const link = await linkHost(relay, makeHost());
    link.send(push('p1'));
    expect(await link.text()).toEqual({ type: 'push.result', id: 'p1', ok: true });
    link.send(push('p2'));
    expect(await link.text()).toEqual({
      type: 'push.result',
      id: 'p2',
      ok: false,
      reason: 'error',
      status: 429,
    });
  });

  it('still limits stream bytes per host', async () => {
    const registry = new FlakyCounters();
    registry.broken = true;
    const relay = await startRelay({
      registry,
      limits: { bytesPerMinute: 1_000 },
      bytesFlushMs: 20,
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, link);
    client.send(Buffer.alloc(600));
    await link.binary();
    // Flushes fail meanwhile; the bytes stay counted here.
    await new Promise((resolve) => setTimeout(resolve, 80));
    client.send(Buffer.alloc(600));
    expect((await link.closed).code).toBe(1008);
  });

  it('uses the shared counters again once the registry answers', async () => {
    const registry = new FlakyCounters();
    const relay = await startRelay({ registry, limits: { opensPerHour: 2 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    // Other machines already used the hour's opens for this host.
    const key = counterKey('opens', host.hostId, HOUR_MS, Date.now());
    expect(await registry.take(key, 2, 2, HOUR_MS)).toBe(true);

    // With the registry away, this machine's own counter decides: one open passes.
    registry.broken = true;
    const { client } = await connectClient(relay, host, link);
    client.socket.close();
    await client.closed;
    await link.text();

    // Back again: the shared total says the hour is spent.
    registry.broken = false;
    const refused = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await refused.closed).toEqual({ code: 4429, reason: 'too many stream opens' });
  });
});
