import { describe, expect, it } from 'vitest';
import { createMemoryCache } from './index';

describe('SnapshotCache', () => {
  it('isolates identical cache and message IDs across hosts and removes a host', async () => {
    const cache = createMemoryCache();
    await cache.set('one', 'bots', [{ id: 'a' }]);
    await cache.set('two', 'bots', [{ id: 'b' }]);
    await cache.mergeMessages('one', 'chat', [{ id: 'm', chatId: 'chat', seq: 4, text: 'one' }]);
    await cache.mergeMessages('two', 'chat', [{ id: 'm', chatId: 'chat', seq: 8, text: 'two' }]);
    expect(await cache.getChatSeq('one', 'chat')).toBe(4);
    await cache.removeHost('one');
    expect(await cache.get('one', 'bots')).toBeNull();
    expect(await cache.readMessages('one', 'chat')).toEqual([]);
    expect(await cache.get('two', 'bots')).toEqual([{ id: 'b' }]);
    expect(await cache.getChatSeq('two', 'chat')).toBe(8);
  });

  it('preserves newer streamed parts when an older REST page arrives and orders pages', async () => {
    const cache = createMemoryCache();
    await cache.mergeMessages('host', 'chat', [
      { id: 'new', chatId: 'chat', seq: 2, deltaSeq: 8, text: 'latest' },
    ]);
    await cache.mergeMessages('host', 'chat', [
      { id: 'old', chatId: 'chat', seq: 1 },
      { id: 'new', chatId: 'chat', seq: 2, deltaSeq: 2, text: 'stale' },
    ]);
    expect((await cache.readMessages('host', 'chat')).map((message) => message.id)).toEqual([
      'old',
      'new',
    ]);
    expect((await cache.readMessages('host', 'chat', 1))[0]?.text).toBe('latest');
  });
});
