import type { HostSecrets, HostSnapshot, KeyValueStorage, SavedHost } from './types';

const REGISTRY = 'openbots.hosts.v1';
const secretKey = (id: string) => `openbots.host.${encodeURIComponent(id)}`;

/** Serializes writes so a fast switch/remove cannot resurrect a removed host. */
export class HostStore {
  private snapshot: HostSnapshot = { hosts: [], activeHostId: null };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: KeyValueStorage) {}

  getSnapshot = (): HostSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private async publish(snapshot: HostSnapshot): Promise<void> {
    await this.storage.setItem(REGISTRY, JSON.stringify(snapshot));
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  load(): Promise<void> {
    return this.enqueue(async () => {
      const raw = await this.storage.getItem(REGISTRY);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (
        !value ||
        typeof value !== 'object' ||
        !('hosts' in value) ||
        !Array.isArray(value.hosts)
      ) {
        throw new Error('The saved host registry is invalid');
      }
      const parsed = value as HostSnapshot;
      if (
        !parsed.hosts.every(
          (host) =>
            typeof host.id === 'string' &&
            typeof host.name === 'string' &&
            Array.isArray(host.directUrls),
        )
      ) {
        throw new Error('The saved host registry is invalid');
      }
      this.snapshot = {
        hosts: parsed.hosts,
        activeHostId: parsed.hosts.some((host) => host.id === parsed.activeHostId)
          ? parsed.activeHostId
          : (parsed.hosts[0]?.id ?? null),
      };
      for (const listener of this.listeners) listener();
    });
  }

  save(host: SavedHost, secrets: HostSecrets): Promise<void> {
    return this.enqueue(async () => {
      if (!host.id || !host.name.trim() || !secrets.apiKey)
        throw new Error('Host name and credentials are required');
      await this.storage.setItem(secretKey(host.id), JSON.stringify(secrets));
      const hosts = [...this.snapshot.hosts.filter((item) => item.id !== host.id), { ...host }];
      await this.publish({ hosts, activeHostId: host.id });
    });
  }

  activate(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.snapshot.hosts.some((host) => host.id === id)) throw new Error('Host not found');
      await this.publish({ ...this.snapshot, activeHostId: id });
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const hosts = this.snapshot.hosts.filter((host) => host.id !== id);
      await this.publish({
        hosts,
        activeHostId:
          this.snapshot.activeHostId === id ? (hosts[0]?.id ?? null) : this.snapshot.activeHostId,
      });
      await this.storage.removeItem(secretKey(id));
    });
  }

  async secrets(id: string): Promise<HostSecrets> {
    await this.pending;
    if (!this.snapshot.hosts.some((host) => host.id === id)) throw new Error('Host not found');
    const value = await this.storage.getItem(secretKey(id));
    if (!value) throw new Error('Credentials are missing. Pair this host again.');
    const secrets = JSON.parse(value) as HostSecrets;
    if (typeof secrets.apiKey !== 'string' || !secrets.apiKey)
      throw new Error('Saved credentials are invalid');
    return secrets;
  }
}

export function createMemoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}
