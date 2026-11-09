import type { ProfileFiles } from './profiles.js';

// The session token per server profile (plan 14.4), encrypted with Electron's
// safeStorage, which the macOS Keychain backs. The token is better-auth's
// session cookie: the shell keeps it out of Chromium's on-disk cookie store
// (see `sessionCookieChange`) and puts it back into the profile's session when
// a window opens. The main process sends it too, for its own connection.

/** The slice of Electron's `safeStorage` used here (its async API). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  /** `shouldReEncrypt`: the key rotated; seal the result again. */
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface SessionToken {
  /** The cookie name, `better-auth.session_token` or its `__Secure-` form on https. */
  name: string;
  value: string;
}

export interface TokenStoreOf<T> {
  get(profileId: string): Promise<T | undefined>;
  set(profileId: string, value: T): Promise<void>;
  clear(profileId: string): Promise<void>;
}

export type TokenStore = TokenStoreOf<SessionToken>;

export interface TokenStoreOptions {
  safeStorage: SafeStorageLike;
  files: ProfileFiles;
  /** `tokens.json` in userData: profile id → base64 of the encrypted token. */
  path: string;
}

const SESSION_COOKIE = /^(__Secure-)?better-auth\.session_token$/;

export function isSessionCookie(name: string): boolean {
  return SESSION_COOKIE.test(name);
}

export function createTokenStore({ safeStorage, files, path }: TokenStoreOptions): TokenStore {
  return createSealedStore<SessionToken>({
    safeStorage,
    files,
    path,
    isValid: (value): value is SessionToken => {
      const token = value as Partial<SessionToken> | null;
      return typeof token?.name === 'string' && typeof token.value === 'string';
    },
    same: (a, b) => a.name === b.name && a.value === b.value,
  });
}

export interface SealedStoreOptions<T> {
  safeStorage: SafeStorageLike;
  files: ProfileFiles;
  /** A JSON file in userData: profile id → base64 of the encrypted value. */
  path: string;
  /** Whether what a file unsealed is a value; anything else reads as missing. */
  isValid(value: unknown): value is T;
  /** Two values are the same, so setting one again writes nothing. */
  same?(a: T, b: T): boolean;
}

/**
 * Values per profile, each sealed with safeStorage, in one file: the session
 * tokens here, a paired server's device keys in ./device-keys.ts.
 */
export function createSealedStore<T>(options: SealedStoreOptions<T>): TokenStoreOf<T> {
  const { safeStorage, files, path, isValid } = options;
  const same = options.same ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  // Without encryption (no Keychain access) values stay in memory only, and
  // the owner signs in (or pairs) again after a restart. Nothing is written in the clear.
  const memory = new Map<string, T>();
  let chain: Promise<unknown> = Promise.resolve();
  const available = () => safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  const seal = async (value: T) =>
    (await safeStorage.encryptStringAsync(JSON.stringify(value))).toString('base64');

  async function read(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await files.readFile(path)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  function update(fn: (stored: Record<string, string>) => void): Promise<void> {
    const next = chain.then(async () => {
      const stored = await read();
      fn(stored);
      await files.writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
    });
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    async get(profileId) {
      const held = memory.get(profileId);
      if (held || !(await available())) return held;
      const sealed = (await read())[profileId];
      if (typeof sealed !== 'string') return undefined;
      let value: unknown;
      let reseal: boolean;
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          Buffer.from(sealed, 'base64'),
        );
        value = JSON.parse(result) as unknown;
        reseal = shouldReEncrypt;
      } catch {
        // Sealed by another Keychain (a restored backup): sign in again.
        return undefined;
      }
      if (!isValid(value)) return undefined;
      memory.set(profileId, value);
      if (reseal) {
        const next = await seal(value);
        await update((stored) => {
          stored[profileId] = next;
        });
      }
      return value;
    },

    async set(profileId, value) {
      const held = memory.get(profileId);
      memory.set(profileId, value);
      if (held !== undefined && same(held, value)) return;
      if (!(await available())) return;
      const sealed = await seal(value);
      await update((stored) => {
        stored[profileId] = sealed;
      });
    },

    async clear(profileId) {
      memory.delete(profileId);
      if (!(await available())) return;
      await update((stored) => {
        delete stored[profileId];
      });
    },
  };
}

/** The fields of an Electron `Cookie` this module reads. */
export interface CookieLike {
  name: string;
  value: string;
  /** True for a cookie without an expiry, which Chromium never writes to disk. */
  session?: boolean;
}

/** Electron's `cookies` `changed` causes. */
export type CookieChangeCause =
  | 'inserted'
  | 'inserted-no-change-overwrite'
  | 'inserted-no-value-change-overwrite'
  | 'explicit'
  | 'overwrite'
  | 'expired'
  | 'evicted'
  | 'expired-overwrite';

export type CookieAction =
  | { action: 'ignore' }
  | { action: 'clear' }
  /** `rehome`: set it again as a session cookie so Chromium does not persist it. */
  | { action: 'store'; token: SessionToken; rehome: boolean };

/** What a change to a profile session's cookies means for the token store. */
export function sessionCookieChange(
  cookie: CookieLike,
  cause: CookieChangeCause,
  removed: boolean,
): CookieAction {
  if (!isSessionCookie(cookie.name)) return { action: 'ignore' };
  if (removed) {
    // An overwrite removes the old cookie before the new one arrives.
    return cause === 'overwrite' ? { action: 'ignore' } : { action: 'clear' };
  }
  if (cookie.value === '') return { action: 'clear' };
  return {
    action: 'store',
    token: { name: cookie.name, value: cookie.value },
    rehome: cookie.session !== true,
  };
}

/** The Cookie header the main process sends for a token. */
export function cookieHeader(token: SessionToken): string {
  return `${token.name}=${token.value}`;
}
