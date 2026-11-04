import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCache } from './index';
import { SnapshotWriter } from './writer';
afterEach(() => vi.useRealTimers());

describe('streamed transcript persistence', () => {
  it('coalesces tokens and flushes the final pending content when the conversation closes', async () => {
    vi.useFakeTimers();
    const cache = createMemoryCache();
    const set = vi.spyOn(cache, 'set');
    const writer = new SnapshotWriter(cache, 'host', 'chat', 250);
    writer.schedule('a');
    writer.schedule('ab');
    writer.schedule('abc');
    await vi.advanceTimersByTimeAsync(250);
    expect(set).toHaveBeenCalledTimes(1);
    expect(await cache.get('host', 'chat')).toBe('abc');
    writer.schedule('complete');
    await writer.close();
    expect(await cache.get('host', 'chat')).toBe('complete');
    writer.schedule('late');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cache.get('host', 'chat')).toBe('complete');
    expect(set).toHaveBeenCalledTimes(2);
  });
});
