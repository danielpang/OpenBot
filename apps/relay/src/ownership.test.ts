import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ownership, type OwnershipOptions } from './ownership.js';
import { MemoryRegistry } from './registry.js';

// The lease keeping of ownership.ts on its own: the hand over between two
// links of one host, when a renewal counts from, the node key lapsing, the
// single-machine mode while the registry is away, and the time limit on
// every registry call (MOBILE_AND_VM_PLAN.md 5.8).

const TIMING = { leaseMs: 1_000, renewMs: 300, nodeTtlMs: 600, heartbeatMs: 200 };

/** A registry whose calls can be made to fail or hang, and whose renewals can be made slow. */
class Controlled extends MemoryRegistry {
  mode: 'ok' | 'fail' | 'hang' = 'ok';
  /** How far the clock moves while a renewal is in flight. */
  renewTakesMs = 0;

  private gate<T>(run: () => Promise<T>): Promise<T> {
    if (this.mode === 'fail') return Promise.reject(new Error('registry unreachable'));
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return run();
  }

  override acquire(...args: Parameters<MemoryRegistry['acquire']>) {
    return this.gate(() => super.acquire(...args));
  }

  override renew(...args: Parameters<MemoryRegistry['renew']>) {
    return this.gate(() => {
      vi.setSystemTime(Date.now() + this.renewTakesMs);
      return super.renew(...args);
    });
  }

  override owner(hostId: string) {
    return this.gate(() => super.owner(hostId));
  }

  override heartbeat(nodeId: string, ttlMs: number) {
    return this.gate(() => super.heartbeat(nodeId, ttlMs));
  }

  override liveNodes() {
    return this.gate(() => super.liveNodes());
  }
}

function ownership(registry: Controlled, overrides: Partial<OwnershipOptions> = {}) {
  const lost: string[] = [];
  const alone = vi.fn();
  const owner = new Ownership({
    nodeId: 'node-a',
    registry,
    timing: TIMING,
    minClusterSize: 1,
    logger: pino({ level: 'silent' }),
    hasLinks: () => false,
    hasStreams: () => true,
    onLost: (hostId) => lost.push(hostId),
    callTimeoutMs: 50,
    metrics: { leaseRenewed: () => undefined, leaseLost: () => undefined, servedAlone: alone },
    ...overrides,
  });
  return { owner, lost, alone };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ownership', () => {
  it('keeps the lease for a link still claiming when the last link goes', async () => {
    const registry = new Controlled();
    let claiming = true;
    const { owner } = ownership(registry, { isClaiming: () => claiming });
    await owner.heartbeat();
    expect(await owner.claim('host-1', true)).toEqual({ ok: true });
    const { epoch } = (await registry.owner('host-1'))!;

    // The first link goes while the next is between its hello and `linked`.
    owner.release('host-1');
    expect(await owner.claim('host-1', true)).toEqual({ ok: true });
    expect(owner.owns('host-1')).toBe(true);
    // The same lease, never given up: no machine saw the host without an owner.
    expect(await registry.owner('host-1')).toMatchObject({ nodeId: 'node-a', epoch });

    claiming = false;
    owner.release('host-1');
    await vi.waitFor(async () => expect(await registry.owner('host-1')).toBeNull());
  });

  it('counts a renewal from before its call, so a slow answer does not stretch the lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const registry = new Controlled();
    const { owner, lost } = ownership(registry);
    await owner.heartbeat();
    await owner.claim('host-1', true);
    // A renewal that takes 400 ms to answer.
    const started = Date.now();
    registry.renewTakesMs = 400;
    await owner.renewAll();
    registry.renewTakesMs = 0;
    // The registry goes away. The lease ran from when the renewal was sent,
    // so it is gone a lease after that, though less than one after the answer.
    registry.mode = 'fail';
    vi.setSystemTime(started + TIMING.leaseMs + 50);
    await owner.renewAll();
    expect(lost).toEqual(['host-1']);
    expect(owner.owns('host-1')).toBe(false);
  });

  it('drops every lease once its node key may have lapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const registry = new Controlled();
    const { owner, lost } = ownership(registry);
    await owner.heartbeat();
    await owner.claim('host-1', true);
    await owner.claim('host-2', false);
    registry.mode = 'fail';
    vi.setSystemTime(Date.now() + TIMING.nodeTtlMs - 100);
    await owner.heartbeat();
    expect(lost).toEqual([]);
    vi.setSystemTime(Date.now() + 200);
    await owner.heartbeat();
    expect(lost.sort()).toEqual(['host-1', 'host-2']);
    expect(owner.ownedHosts()).toEqual([]);
    expect(owner.degraded).toBe(true);
  });

  it('serves a host alone while the registry is away, and takes its lease once it answers', async () => {
    const registry = new Controlled();
    const { owner, alone, lost } = ownership(registry);
    await owner.heartbeat();
    registry.mode = 'fail';
    expect(await owner.claim('host-1', true)).toEqual({ ok: true });
    expect(owner.serves('host-1')).toBe(true);
    expect(owner.owns('host-1')).toBe(false);
    expect(owner.degraded).toBe(true);
    expect(alone).toHaveBeenCalledTimes(1);
    expect(await owner.route('host-1', false)).toEqual({ kind: 'local' });
    expect(await owner.linked('host-1')).toBe(true);

    registry.mode = 'ok';
    await owner.renewAll();
    expect(owner.owns('host-1')).toBe(true);
    expect(owner.degraded).toBe(false);
    expect(await registry.owner('host-1')).toMatchObject({ nodeId: 'node-a' });
    expect(lost).toEqual([]);
  });

  it('closes a host it served alone that another machine took meanwhile', async () => {
    const registry = new Controlled();
    const { owner, lost } = ownership(registry);
    await owner.heartbeat();
    registry.mode = 'fail';
    await owner.claim('host-1', true);
    registry.mode = 'ok';
    await registry.heartbeat('node-b', 5_000);
    await registry.acquire('host-1', 'node-b', 5_000, true);
    await owner.renewAll();
    expect(lost).toEqual(['host-1']);
    expect(owner.serves('host-1')).toBe(false);
  });

  it('gives up on a registry call that hangs', async () => {
    const registry = new Controlled();
    const { owner } = ownership(registry);
    await owner.heartbeat();
    registry.mode = 'hang';
    const started = Date.now();
    expect(await owner.route('host-1', false)).toEqual({ kind: 'local' });
    expect(await owner.claim('host-1', true)).toEqual({ ok: true });
    await expect(owner.linked('host-2')).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
