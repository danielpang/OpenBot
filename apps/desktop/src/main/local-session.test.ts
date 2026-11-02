import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '../ipc.js';
import {
  createLocalSignIn,
  DEFAULT_OWNER_NAME,
  isSignInPath,
  LOCAL_TOKEN_HEADER,
  needsLocalSignIn,
  ownerName,
  sessionFromSetCookie,
  type LocalFetch,
} from './local-session.js';
import { createOpener } from './opener.js';
import type { ServerGate } from './server-gate.js';

const URL_ = 'http://localhost:3000';
const TOKEN = 'tOkEn_'.repeat(7);
const COOKIE = 'better-auth.session_token=abc.sig; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax';

const local: ServerProfile = { id: 'local', name: 'This Mac', url: URL_, kind: 'local' };
const remote: ServerProfile = {
  id: 'r1',
  name: 'Self-hosted',
  url: 'https://openbots.example.com',
  kind: 'remote',
};

type Answer = { status: number; setCookie?: string[] } | 'down';

/** Answers /api/v1/me and /api/v1/local/session from the table; records each call. */
function server(answers: { me?: Answer; session?: Answer | Answer[] }) {
  let sessions = 0;
  const fetch = vi.fn<LocalFetch>(async (url) => {
    const path = new URL(url).pathname;
    let answer: Answer | undefined;
    if (path === '/api/v1/me') answer = answers.me;
    if (path === '/api/v1/local/session') {
      const list = Array.isArray(answers.session) ? answers.session : [answers.session];
      answer = list[Math.min(sessions++, list.length - 1)];
    }
    if (answer == null || answer === 'down') throw new TypeError('fetch failed');
    const { status, setCookie = [] } = answer;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { getSetCookie: () => setCookie },
    };
  });
  return fetch;
}

function signIn(fetch: LocalFetch, extra: Partial<Parameters<typeof createLocalSignIn>[0]> = {}) {
  const log = vi.fn<(message: string) => void>();
  const signer = createLocalSignIn({
    fetch,
    token: async () => TOKEN,
    name: async () => 'Ada Lovelace',
    log,
    ...extra,
  });
  return { signer, log };
}

describe('sessionFromSetCookie', () => {
  it('picks the better-auth session cookie, either form', () => {
    expect(sessionFromSetCookie(['other=1; Path=/', COOKIE])).toEqual({
      name: 'better-auth.session_token',
      value: 'abc.sig',
    });
    expect(sessionFromSetCookie(['__Secure-better-auth.session_token=x; Secure'])).toEqual({
      name: '__Secure-better-auth.session_token',
      value: 'x',
    });
    expect(sessionFromSetCookie(['better-auth.session_token=; Max-Age=0'])).toBeNull();
    expect(sessionFromSetCookie([])).toBeNull();
  });
});

describe('the sign-in pages on This Mac', () => {
  it('are /sign-in and /sign-up, with or without a query', () => {
    for (const path of ['/sign-in', '/sign-in?signup=closed', '/sign-up', '/sign-up?invite=x']) {
      expect(isSignInPath(path), path).toBe(true);
    }
    for (const path of ['/', '/settings/general', '/sign-inx', '/setup']) {
      expect(isSignInPath(path), path).toBe(false);
    }
  });

  it('mean a new local sign-in on This Mac only, never for a remote server or another site', () => {
    expect(needsLocalSignIn(local, `${URL_}/sign-in`)).toBe(true);
    expect(needsLocalSignIn(local, `${URL_}/sign-up?invite=x`)).toBe(true);
    expect(needsLocalSignIn(local, `${URL_}/bots/1`)).toBe(false);
    expect(needsLocalSignIn(local, 'https://github.com/sign-in')).toBe(false);
    expect(needsLocalSignIn(remote, `${remote.url}/sign-in`)).toBe(false);
  });
});

describe('ownerName', () => {
  it("is the macOS user's full name, else Me", async () => {
    expect(await ownerName(async () => 'Ada Lovelace\n')).toBe('Ada Lovelace');
    expect(await ownerName(async () => '  \n')).toBe(DEFAULT_OWNER_NAME);
    expect(await ownerName(async () => Promise.reject(new Error('no id')))).toBe('Me');
  });
});

describe('createLocalSignIn', () => {
  it('keeps a saved session the server still takes, without a new one', async () => {
    const fetch = server({ me: { status: 200 } });
    const stored = { name: 'better-auth.session_token', value: 'saved' };
    expect(await signIn(fetch).signer.ensure(URL_, stored)).toBe(stored);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].headers).toEqual({ cookie: 'better-auth.session_token=saved' });
  });

  it('trades the token for a session, in a header and never in the URL, with no Origin', async () => {
    const fetch = server({ me: { status: 401 }, session: { status: 200, setCookie: [COOKIE] } });
    const stored = { name: 'better-auth.session_token', value: 'expired' };
    const session = await signIn(fetch).signer.ensure(URL_, stored);
    expect(session).toEqual({ name: 'better-auth.session_token', value: 'abc.sig' });
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(url).toBe(`${URL_}/api/v1/local/session`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      [LOCAL_TOKEN_HEADER]: TOKEN,
      'content-type': 'application/json',
    });
    expect(Object.keys(init.headers!).map((h) => h.toLowerCase())).not.toContain('origin');
    expect(JSON.parse(init.body!)).toEqual({ name: 'Ada Lovelace' });
  });

  it('signs in at once without a saved session', async () => {
    const fetch = server({ session: { status: 200, setCookie: [COOKIE] } });
    expect(await signIn(fetch).signer.ensure(URL_, undefined)).toMatchObject({ value: 'abc.sig' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly without a token, or on a server with no local sign-in', async () => {
    const none = server({});
    expect(
      await signIn(none, { token: async () => null }).signer.ensure(URL_, undefined),
    ).toBeNull();
    expect(none).not.toHaveBeenCalled();
    const older = server({ session: { status: 404 } });
    const { signer, log } = signIn(older);
    expect(await signer.ensure(URL_, undefined)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a refusal or a failure without the token', async () => {
    for (const answer of [{ status: 401 }, { status: 500 }, 'down' as const]) {
      const { signer, log } = signIn(server({ session: answer }));
      expect(await signer.ensure(URL_, undefined)).toBeNull();
      expect(log).toHaveBeenCalled();
      for (const [message] of log.mock.calls) expect(message).not.toContain(TOKEN);
    }
  });

  it('renews at most once per interval, so a refusing server cannot loop the window', async () => {
    let now = 0;
    const fetch = server({ session: [{ status: 401 }, { status: 200, setCookie: [COOKIE] }] });
    const { signer } = signIn(fetch, { now: () => now, renewIntervalMs: 10_000 });
    expect(await signer.renew(URL_)).toBeNull();
    now = 5_000;
    expect(await signer.renew(URL_)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 10_000;
    expect(await signer.renew(URL_)).toMatchObject({ value: 'abc.sig' });
  });

  it('hands a fresh session out once more within the interval, then stops', async () => {
    let now = 0;
    const fetch = server({ session: { status: 200, setCookie: [COOKIE] } });
    const { signer } = signIn(fetch, { now: () => now });
    // The main connection's 401 renews first; the window's /sign-in right after reuses it.
    expect(await signer.renew(URL_)).toMatchObject({ value: 'abc.sig' });
    now = 1_000;
    expect(await signer.renew(URL_)).toMatchObject({ value: 'abc.sig' });
    // A third ask in the interval (the reload landed on /sign-in again) gets nothing: no loop.
    expect(await signer.renew(URL_)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('opening This Mac', () => {
  it('signs in before the web app loads', async () => {
    const steps: string[] = [];
    const fetch = server({ session: { status: 200, setCookie: [COOKIE] } });
    const { signer } = signIn(fetch);
    const gate: ServerGate = {
      verify: async () => ({ ok: true, setupRequired: true }),
      admit: async () => null,
    };
    const opener = createOpener<string>({
      gate,
      windows: {
        forProfile: async () => 'window',
        showsServer: () => false,
        signIn: async (profile) => {
          const session = await signer.ensure(profile.url, undefined);
          steps.push(`cookie ${session?.value}`);
        },
        signOut: () => undefined,
        load: async (_window, url) => void steps.push(`load ${url}`),
        navigate: () => undefined,
        showStart: async () => undefined,
      },
    });
    await opener.open(local);
    expect(steps).toEqual(['cookie abc.sig', `load ${URL_}/`]);
  });
});

describe('the token stays in the main process', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('is never part of what the preload, the renderer or the IPC see', () => {
    for (const path of [
      '../preload/index.ts',
      '../preload/bridge.ts',
      '../stack/bridge.ts',
      '../ipc.ts',
      './ipc.ts',
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(/localToken|LOCAL_TOKEN/);
    }
  });

  it('is read in the main process only to sign in, never put in a URL or the window', () => {
    const main = read('./index.ts');
    const uses = main.split('\n').filter((line) => /localToken|LOCAL_TOKEN/.test(line));
    expect(uses.map((line) => line.trim())).toEqual([
      '? (process.env.OPENBOTS_LOCAL_TOKEN ?? null)',
      ': stack.localToken(),',
    ]);
    expect(main).not.toMatch(/additionalArguments[^\]]*[Tt]oken/);
  });
});
