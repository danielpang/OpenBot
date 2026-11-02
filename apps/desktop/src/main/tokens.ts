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

export interface TokenStore {
  get(profileId: string): Promise<SessionToken | undefined>;
  set(profileId: string, token: SessionToken): Promise<void>;
  clear(profileId: string): Promise<void>;
}

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
  // Without encryption (no Keychain access) tokens stay in memory only, and
  // the owner signs in again after a restart. Nothing is written in the clear.
  const memory = new Map<string, SessionToken>();
  let chain: Promise<unknown> = Promise.resolve();
  const available = () => safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  const seal = async (token: SessionToken) =>
    (await safeStorage.encryptStringAsync(JSON.stringify(token))).toString('base64');

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
      let token: SessionToken;
      let reseal: boolean;
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          Buffer.from(sealed, 'base64'),
        );
        token = JSON.parse(result) as SessionToken;
        reseal = shouldReEncrypt;
      } catch {
        // Sealed by another Keychain (a restored backup): sign in again.
        return undefined;
      }
      if (typeof token.name !== 'string' || typeof token.value !== 'string') return undefined;
      memory.set(profileId, token);
      if (reseal) {
        const next = await seal(token);
        await update((stored) => {
          stored[profileId] = next;
        });
      }
      return token;
    },

    async set(profileId, token) {
      const held = memory.get(profileId);
      memory.set(profileId, token);
      if (held?.name === token.name && held.value === token.value) return;
      if (!(await available())) return;
      const sealed = await seal(token);
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
