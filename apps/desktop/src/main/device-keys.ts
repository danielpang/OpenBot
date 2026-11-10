import type { DeviceSecrets } from './paired.js';
import { createSealedStore, type SafeStorageLike, type TokenStoreOf } from './tokens.js';
import type { ProfileFiles } from './profiles.js';

// A paired server's device keys (./paired.ts): the API key the server gave
// this Mac and the static key it pinned. Sealed with safeStorage in
// `device-keys.json`, beside the session tokens, never in profiles.json.

export type DeviceKeyStore = TokenStoreOf<DeviceSecrets>;

export function isDeviceSecrets(value: unknown): value is DeviceSecrets {
  const secrets = value as Partial<DeviceSecrets> | null;
  return (
    typeof secrets?.apiKey === 'string' &&
    secrets.apiKey.startsWith('obk_') &&
    typeof secrets.staticKey === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(secrets.staticKey)
  );
}

export function createDeviceKeyStore(options: {
  safeStorage: SafeStorageLike;
  files: ProfileFiles;
  path: string;
}): DeviceKeyStore {
  return createSealedStore({ ...options, isValid: isDeviceSecrets });
}
