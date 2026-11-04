import * as SecureStore from 'expo-secure-store';
import type { KeyValueStorage } from './types';

/** Device-only Keychain items; the push-key extension uses the same access group. */
export function createSecureHostStorage(accessGroup?: string): KeyValueStorage {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(accessGroup ? { accessGroup } : {}),
  };
  // SecureStore keys accept alphanumerics, dot, dash and underscore, not URI escapes.
  const keyFor = (key: string) =>
    `openbots.${Array.from(new TextEncoder().encode(key), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  let revision = 0;
  type Manifest = { v: 1; generation: string; chunks: number };
  const manifest = (raw: string | null): Manifest | null => {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Manifest;
      return value.v === 1 &&
        typeof value.generation === 'string' &&
        Number.isInteger(value.chunks) &&
        value.chunks > 0
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const clean = async (key: string, value: Manifest | null) => {
    if (!value) return;
    await Promise.all(
      Array.from({ length: value.chunks }, (_, index) =>
        SecureStore.deleteItemAsync(`${key}.${value.generation}.${index}`, options),
      ),
    );
  };
  return {
    async getItem(key) {
      const storageKey = keyFor(key);
      const raw = await SecureStore.getItemAsync(storageKey, options);
      const value = manifest(raw);
      if (!value) return raw;
      const chunks = await Promise.all(
        Array.from({ length: value.chunks }, (_, index) =>
          SecureStore.getItemAsync(`${storageKey}.${value.generation}.${index}`, options),
        ),
      );
      if (chunks.some((chunk) => chunk === null))
        throw new Error('Saved host data is incomplete. Pair this host again.');
      return chunks.join('');
    },
    async setItem(key, value) {
      const storageKey = keyFor(key);
      const previous = manifest(await SecureStore.getItemAsync(storageKey, options));
      // At most 1600 UTF-8 bytes per item, below older Keychain size limits.
      const chunks = value.match(/[\s\S]{1,400}/gu) ?? [''];
      const next: Manifest = {
        v: 1,
        generation: `${Date.now()}.${revision++}`,
        chunks: chunks.length,
      };
      try {
        await Promise.all(
          chunks.map((chunk, index) =>
            SecureStore.setItemAsync(`${storageKey}.${next.generation}.${index}`, chunk, options),
          ),
        );
        // Publishing the manifest last keeps the previous value readable on interrupted writes.
        await SecureStore.setItemAsync(storageKey, JSON.stringify(next), options);
      } catch (error) {
        await clean(storageKey, next).catch(() => {});
        throw error;
      }
      await clean(storageKey, previous).catch(() => {});
    },
    async removeItem(key) {
      const storageKey = keyFor(key);
      const previous = manifest(await SecureStore.getItemAsync(storageKey, options));
      await SecureStore.deleteItemAsync(storageKey, options);
      await clean(storageKey, previous);
    },
  };
}
