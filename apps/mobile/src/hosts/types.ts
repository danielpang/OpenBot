export interface SavedHost {
  id: string;
  name: string;
  kind: 'paired' | 'server' | 'account';
  directUrls: string[];
  relayUrl: string | null;
  serverPublicKey?: string;
  deviceId?: string;
  ownerId?: string;
  lastSeenAt?: string;
}

/** Secrets never appear in the observable host registry. */
export interface HostSecrets {
  apiKey: string;
  devicePrivateKey?: string;
  pushKey?: string;
}

export interface HostSnapshot {
  hosts: readonly SavedHost[];
  activeHostId: string | null;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
