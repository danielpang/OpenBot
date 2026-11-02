import { describe, expect, it } from 'vitest';
import type { ProfileFiles } from './profiles.js';
import {
  cookieHeader,
  createTokenStore,
  isSessionCookie,
  sessionCookieChange,
  type SafeStorageLike,
} from './tokens.js';

// Stands in for safeStorage: reversible, and visibly not the plain text.
function fakeSafeStorage(available = true, rotated = false): SafeStorageLike & { calls: number } {
  const storage = {
    calls: 0,
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (text: string) => {
      storage.calls++;
      return Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`);
    },
    decryptStringAsync: async (sealed: Buffer) => {
      const text = sealed.toString();
      if (!text.startsWith('sealed:')) throw new Error('not ours');
      return { result: Buffer.from(text.slice(7), 'hex').toString(), shouldReEncrypt: rotated };
    },
  };
  return storage;
}

function memoryFiles() {
  const data = new Map<string, string>();
  const files: ProfileFiles = {
    readFile: async (path) => {
      const text = data.get(path);
      if (text == null) throw new Error('ENOENT');
      return text;
    },
    writeFile: async (path, text) => void data.set(path, text),
  };
  return { files, data };
}

const PATH = '/user-data/tokens.json';
const token = { name: 'better-auth.session_token', value: 'abc.signature' };

describe('token store', () => {
  it('stores the token sealed, never in the clear', async () => {
    const { files, data } = memoryFiles();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH });
    await tokens.set('local', token);
    const written = data.get(PATH)!;
    expect(written).not.toContain('abc.signature');
    expect(Object.keys(JSON.parse(written))).toEqual(['local']);
    // A new process (a restart) reads it back through safeStorage.
    const again = createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH });
    expect(await again.get('local')).toEqual(token);
    expect(await again.get('other')).toBeUndefined();
  });

  it('seals the token again when the key rotated', async () => {
    const { files } = memoryFiles();
    await createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH }).set(
      'local',
      token,
    );
    const safeStorage = fakeSafeStorage(true, true);
    expect(await createTokenStore({ safeStorage, files, path: PATH }).get('local')).toEqual(token);
    expect(safeStorage.calls).toBe(1);
  });

  it('does not re-encrypt an unchanged token', async () => {
    const { files } = memoryFiles();
    const safeStorage = fakeSafeStorage();
    const tokens = createTokenStore({ safeStorage, files, path: PATH });
    await tokens.set('local', token);
    await tokens.set('local', { ...token });
    expect(safeStorage.calls).toBe(1);
  });

  it('clears one profile and keeps the others', async () => {
    const { files, data } = memoryFiles();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH });
    await Promise.all([tokens.set('local', token), tokens.set('work', { ...token, value: 'w' })]);
    await tokens.clear('local');
    expect(await tokens.get('local')).toBeUndefined();
    expect(Object.keys(JSON.parse(data.get(PATH)!))).toEqual(['work']);
  });

  it('keeps tokens in memory only without encryption', async () => {
    const { files, data } = memoryFiles();
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(false), files, path: PATH });
    await tokens.set('local', token);
    expect(await tokens.get('local')).toEqual(token);
    expect(data.size).toBe(0);
  });

  it('treats a token it cannot decrypt, or a corrupt file, as signed out', async () => {
    const { files, data } = memoryFiles();
    data.set(
      PATH,
      JSON.stringify({ local: Buffer.from('from another keychain').toString('base64') }),
    );
    const tokens = createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH });
    expect(await tokens.get('local')).toBeUndefined();
    data.set(PATH, 'not json');
    expect(
      await createTokenStore({ safeStorage: fakeSafeStorage(), files, path: PATH }).get('local'),
    ).toBeUndefined();
  });
});

describe('session cookie changes', () => {
  it('knows better-auth session cookies, secure or not', () => {
    expect(isSessionCookie('better-auth.session_token')).toBe(true);
    expect(isSessionCookie('__Secure-better-auth.session_token')).toBe(true);
    expect(isSessionCookie('better-auth.session_data')).toBe(false);
    expect(isSessionCookie('other')).toBe(false);
  });

  it('stores a new session and moves a persistent cookie into memory', () => {
    expect(sessionCookieChange({ ...token, session: false }, 'inserted', false)).toEqual({
      action: 'store',
      token,
      rehome: true,
    });
    expect(sessionCookieChange({ ...token, session: true }, 'inserted', false)).toEqual({
      action: 'store',
      token,
      rehome: false,
    });
  });

  it('clears on sign-out and expiry, not on an overwrite', () => {
    expect(sessionCookieChange(token, 'overwrite', true)).toEqual({ action: 'ignore' });
    expect(sessionCookieChange(token, 'explicit', true)).toEqual({ action: 'clear' });
    expect(sessionCookieChange(token, 'expired', true)).toEqual({ action: 'clear' });
    expect(sessionCookieChange(token, 'expired-overwrite', true)).toEqual({ action: 'clear' });
    expect(sessionCookieChange({ ...token, value: '' }, 'inserted', false)).toEqual({
      action: 'clear',
    });
  });

  it('ignores other cookies', () => {
    expect(sessionCookieChange({ name: 'theme', value: 'dark' }, 'inserted', false)).toEqual({
      action: 'ignore',
    });
  });

  it('sends the token as a Cookie header', () => {
    expect(cookieHeader(token)).toBe('better-auth.session_token=abc.signature');
  });
});
