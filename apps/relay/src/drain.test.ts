import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DRAIN,
  DrainController,
  drainOptionsFromEnv,
  drainRequested,
  SERVICE_RESTART,
  type DrainHooks,
} from './drain.js';

function recorder(overrides: Partial<DrainHooks> = {}) {
  const calls: string[] = [];
  const hooks: DrainHooks = {
    stopAccepting: vi.fn(() => {
      calls.push('stopAccepting');
    }),
    releaseLeases: vi.fn(() => {
      calls.push('releaseLeases');
    }),
    closeAll: vi.fn((code: number, reason: string) => {
      calls.push(`closeAll ${code} ${reason}`);
    }),
    ...overrides,
  };
  return { hooks, calls };
}

describe('DrainController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves until started', () => {
    const { hooks } = recorder();
    const drain = new DrainController(hooks);
    expect(drain.draining).toBe(false);
    expect(drain.phase).toBe('serving');
    expect(DEFAULT_DRAIN.graceMs).toBe(20_000);
  });

  it('goes not ready, stops accepting, gives up leases, and closes with 1012 after the grace', async () => {
    const { hooks, calls } = recorder();
    const drain = new DrainController(hooks);
    const done = drain.start('manual');
    expect(drain.draining).toBe(true);
    expect(drain.trigger).toBe('manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['stopAccepting', 'releaseLeases']);
    expect(drain.phase).toBe('draining');

    await vi.advanceTimersByTimeAsync(19_999);
    expect(hooks.closeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toEqual([
      'stopAccepting',
      'releaseLeases',
      'closeAll 1012 relay restarting, reconnect',
    ]);
    expect(SERVICE_RESTART).toBe(1012);
    expect(drain.phase).toBe('drained');
    expect(drain.draining).toBe(true);
  });

  it('runs once however often it is started', async () => {
    const { hooks } = recorder();
    const drain = new DrainController(hooks, { graceMs: 100 });
    const first = drain.start('signal');
    const second = drain.start('env');
    expect(second).toBe(first);
    expect(drain.trigger).toBe('signal');
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(hooks.stopAccepting).toHaveBeenCalledTimes(1);
    expect(hooks.closeAll).toHaveBeenCalledTimes(1);
  });

  it('waits for leases to be given up before the grace starts', async () => {
    let release!: () => void;
    const { hooks, calls } = recorder({
      releaseLeases: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const drain = new DrainController(hooks, { graceMs: 1_000 });
    const done = drain.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual(['stopAccepting']);
    release();
    await vi.advanceTimersByTimeAsync(999);
    expect(hooks.closeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(hooks.closeAll).toHaveBeenCalledWith(1012, expect.any(String));
  });

  it('finishes early once nothing is left open', async () => {
    let open = 3;
    const { hooks } = recorder({ idle: () => open === 0 });
    const drain = new DrainController(hooks, { graceMs: 20_000, idlePollMs: 1_000 });
    const done = drain.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hooks.closeAll).not.toHaveBeenCalled();
    open = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(hooks.closeAll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries on past a hook that fails, and reports it', async () => {
    const onError = vi.fn();
    const { hooks } = recorder({
      stopAccepting: () => {
        throw new Error('no');
      },
      releaseLeases: () => Promise.reject(new Error('redis is gone')),
      onError,
    });
    const drain = new DrainController(hooks, { graceMs: 10 });
    const done = drain.start();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(onError).toHaveBeenCalledWith('stopAccepting', expect.any(Error));
    expect(onError).toHaveBeenCalledWith('releaseLeases', expect.any(Error));
    expect(hooks.closeAll).toHaveBeenCalledTimes(1);
    expect(drain.phase).toBe('drained');
  });

  it('starts on SIGTERM, and stops listening when asked', async () => {
    const { hooks } = recorder();
    const signals = new EventEmitter();
    const drain = new DrainController(hooks, { graceMs: 10 });
    const stop = drain.listen(signals);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    signals.emit('SIGTERM');
    expect(drain.draining).toBe(true);
    expect(drain.trigger).toBe('signal');
    await vi.advanceTimersByTimeAsync(10);
    expect(hooks.closeAll).toHaveBeenCalledTimes(1);
    stop();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('settings', () => {
  it('reads RELAY_DRAIN', () => {
    expect(drainRequested({})).toBe(false);
    expect(drainRequested({ RELAY_DRAIN: '' })).toBe(false);
    expect(drainRequested({ RELAY_DRAIN: 'false' })).toBe(false);
    expect(drainRequested({ RELAY_DRAIN: 'true' })).toBe(true);
    expect(drainRequested({ RELAY_DRAIN: 'TRUE' })).toBe(true);
    expect(drainRequested({ RELAY_DRAIN: '1' })).toBe(true);
    expect(() => drainRequested({ RELAY_DRAIN: 'maybe' })).toThrow(/RELAY_DRAIN/);
  });

  it('reads the grace period', () => {
    expect(drainOptionsFromEnv({}).graceMs).toBe(20_000);
    expect(drainOptionsFromEnv({ RELAY_DRAIN_GRACE_MS: '5000' }).graceMs).toBe(5_000);
  });
});
