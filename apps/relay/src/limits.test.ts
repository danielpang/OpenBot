import { describe, expect, it } from 'vitest';
import { MemoryRegistry, counterKey } from './registry.js';
import {
  connectClient,
  linkHost,
  makeHost,
  prefixed,
  startRelay,
  type Peer,
} from './test/helpers.js';

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

/** A stream that carries one payload, so it counts against the host's hour, and then closes. */
async function useStream(relay: { url: string }, host: ReturnType<typeof makeHost>, link: Peer) {
  const { client } = await connectClient(relay, host, link);
  client.send(Buffer.from('hi'));
  await link.binary();
  client.socket.close();
  await client.closed;
  await link.text();
}

/** A stream past the hour: it opens, and its first payload closes it 4429. */
async function refusedStream(
  relay: { url: string },
  host: ReturnType<typeof makeHost>,
  link: Peer,
) {
  const { client } = await connectClient(relay, host, link);
  client.send(Buffer.from('hi'));
  return client.closed;
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
  it('falls back to the local counter when the registry is slow, freeing the stream slot', async () => {
    const registry = new (class extends MemoryRegistry {
      override take() {
        return new Promise<boolean>(() => undefined);
      }
    })();
    const relay = await startRelay({
      registry,
      registryTimeoutMs: 50,
      limits: { streamsPerHost: 1 },
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, link);
    client.socket.close();
    await client.closed;
    await link.text();
    // The slot went back once the open's counter gave up on the registry.
    await connectClient(relay, host, link);
  });

  it('still limits stream opens per host', async () => {
    const registry = new FlakyCounters();
    registry.broken = true;
    const relay = await startRelay({ registry, limits: { opensPerHour: 2 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    for (let i = 0; i < 2; i += 1) await useStream(relay, host, link);
    expect(await refusedStream(relay, host, link)).toEqual({
      code: 4429,
      reason: 'too many stream opens',
    });
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
    const { client, stream } = await connectClient(relay, host, link);
    link.send(prefixed(stream, Buffer.alloc(600)));
    await client.binary();
    // Flushes fail meanwhile; the bytes stay counted here.
    await new Promise((resolve) => setTimeout(resolve, 80));
    link.send(prefixed(stream, Buffer.alloc(600)));
    expect((await client.closed).code).toBe(1008);
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
    await useStream(relay, host, link);

    // Back again: the shared total says the hour is spent.
    registry.broken = false;
    expect(await refusedStream(relay, host, link)).toEqual({
      code: 4429,
      reason: 'too many stream opens',
    });
  });
});
