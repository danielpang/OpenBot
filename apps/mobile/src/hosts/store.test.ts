import { describe, expect, it } from 'vitest';
import { HostStore, createMemoryStorage } from './store';
import type { SavedHost } from './types';

const host = (id: string): SavedHost => ({
  id,
  name: id,
  kind: 'server',
  directUrls: ['https://example.com'],
  relayUrl: null,
});

describe('HostStore', () => {
  it('persists secrets separately, restores active host, and isolates credentials', async () => {
    const storage = createMemoryStorage();
    const store = new HostStore(storage);
    await store.save(host('a'), { apiKey: 'secret-a', devicePrivateKey: 'private' });
    await store.save(host('b'), { apiKey: 'secret-b' });
    await store.activate('a');
    expect(JSON.stringify(store.getSnapshot())).not.toContain('secret');
    const restored = new HostStore(storage);
    await restored.load();
    expect(restored.getSnapshot().activeHostId).toBe('a');
    expect(await restored.secrets('b')).toEqual({ apiKey: 'secret-b' });
  });

  it('serializes saves and removals and selects the remaining host', async () => {
    const store = new HostStore(createMemoryStorage());
    await Promise.all([
      store.save(host('a'), { apiKey: 'a' }),
      store.save(host('b'), { apiKey: 'b' }),
      store.remove('b'),
    ]);
    expect(store.getSnapshot()).toEqual({ hosts: [host('a')], activeHostId: 'a' });
    await expect(store.secrets('b')).rejects.toThrow('Host not found');
    await expect(store.activate('missing')).rejects.toThrow('Host not found');
  });

  it('does not publish a save if the durable registry write fails', async () => {
    const storage = createMemoryStorage();
    const store = new HostStore({
      ...storage,
      async setItem(key, value) {
        if (key === 'openbots.hosts.v1') throw new Error('Keychain unavailable');
        await storage.setItem(key, value);
      },
    });
    await expect(store.save(host('a'), { apiKey: 'a' })).rejects.toThrow('Keychain unavailable');
    expect(store.getSnapshot().hosts).toEqual([]);
  });
});
