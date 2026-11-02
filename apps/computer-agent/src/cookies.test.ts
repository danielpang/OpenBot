import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Cookie } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cookieKey,
  CookieStore,
  cookieStoreFile,
  CookieSync,
  mergeExport,
  readCookieStore,
  reconcile,
  TOMBSTONE_MS,
  writeCookieStore,
  type CookieId,
  type CookieJar,
} from './cookies.js';
import { run as runAsAgent } from './proc.js';
import { fakeRun } from './test-utils.js';
import { STORE } from './users.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

function cookie(name: string, value: string, more: Partial<Cookie> = {}): Cookie {
  return {
    name,
    value,
    domain: '.example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...more,
  };
}

const keyed = (cookies: Cookie[]) => new Map(cookies.map((c) => [cookieKey(c), c]));
const values = (cookies: Cookie[]) =>
  Object.fromEntries(cookies.map((c) => [`${c.name}@${c.domain}`, c.value]));

/** A Chromium profile's cookies, as Playwright's context sees them. */
class FakeJar implements CookieJar {
  readonly held = new Map<string, Cookie>();
  reads = 0;
  /** Cookies Chromium refuses to set, by name. */
  refuse = new Set<string>();

  constructor(cookies: Cookie[] = []) {
    for (const c of cookies) this.held.set(cookieKey(c), c);
  }

  async cookies() {
    this.reads++;
    return [...this.held.values()];
  }

  async addCookies(cookies: readonly Cookie[]) {
    if (cookies.some((c) => this.refuse.has(c.name))) throw new Error('Invalid cookie fields');
    for (const c of cookies) this.held.set(cookieKey(c), { ...c });
  }

  async clearCookies(filter: Partial<CookieId> = {}) {
    for (const [key, c] of this.held) {
      if (
        (filter.name === undefined || filter.name === c.name) &&
        (filter.domain === undefined || filter.domain === c.domain) &&
        (filter.path === undefined || filter.path === c.path)
      ) {
        this.held.delete(key);
      }
    }
  }

  /** What a site does in the page: sets or removes a cookie. */
  set(c: Cookie) {
    this.held.set(cookieKey(c), c);
  }

  remove(name: string, domain = '.example.com') {
    this.held.delete(cookieKey({ name, domain, path: '/' }));
  }

  value(name: string, domain = '.example.com') {
    return this.held.get(cookieKey({ name, domain, path: '/' }))?.value;
  }
}

function harness(jars: Record<number, FakeJar>, saved?: string) {
  let now = T0;
  const store = { text: saved };
  const errors: { error: unknown; screen?: number }[] = [];
  const running = new Set(Object.keys(jars).map(Number));
  const sync = new CookieSync({
    jar: async (n) => {
      const jar = jars[n];
      if (!jar || !running.has(n)) throw new Error(`Screen ${n} is not running`);
      return jar;
    },
    screens: () => [...running],
    load: async () => store.text,
    save: async (text) => {
      store.text = text;
    },
    now: () => now,
    onError: (error, screen) => errors.push({ error, screen }),
  });
  return {
    sync,
    store,
    errors,
    running,
    tick: (ms: number) => (now += ms),
    saved: () => CookieStore.parse(store.text),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CookieStore merge (K1)', () => {
  it('takes the newest write for a cookie, and ignores an older one', () => {
    const store = new CookieStore();
    expect(store.write(cookie('sid', 'a'), T0)).toBe(true);
    expect(store.write(cookie('sid', 'b'), T0 + 10)).toBe(true);
    expect(store.write(cookie('sid', 'stale'), T0 + 5)).toBe(false);
    expect(store.get(cookie('sid', ''))?.value).toBe('b');
    // The same cookie again changes nothing, whatever fraction of a second Chromium reports.
    expect(store.write(cookie('sid', 'b', { expires: -1.0000001 }), T0 + 20)).toBe(false);
  });

  it('keeps a cookie per name, domain and path', () => {
    const store = new CookieStore();
    store.write(cookie('sid', 'a'), T0);
    store.write(cookie('sid', 'b', { domain: 'other.org' }), T0);
    store.write(cookie('sid', 'c', { path: '/app' }), T0);
    expect(store.cookies()).toHaveLength(3);
  });

  it("folds a screen's export in: new and changed cookies, and removals found against its last export", () => {
    const store = new CookieStore();
    const last = keyed([cookie('sid', 'a'), cookie('theme', 'dark'), cookie('gone', 'x')]);
    for (const c of last.values()) store.write(c, T0);
    const changes = mergeExport(
      store,
      [cookie('sid', 'a'), cookie('theme', 'light'), cookie('new', '1')],
      last,
      T0 + 1000,
    );
    expect(values(changes.written)).toEqual({
      'theme@.example.com': 'light',
      'new@.example.com': '1',
    });
    expect(changes.removed).toEqual([{ name: 'gone', domain: '.example.com', path: '/' }]);
    expect(store.get({ name: 'gone', domain: '.example.com', path: '/' })).toBeNull();
    expect(values(store.cookies())).toEqual({
      'sid@.example.com': 'a',
      'theme@.example.com': 'light',
      'new@.example.com': '1',
    });
  });

  it('lets a newer removal win over a write, and a newer write over a removal', () => {
    const store = new CookieStore();
    store.write(cookie('sid', 'a'), T0);
    expect(store.remove(cookie('sid', 'a'), T0 + 10)).toBe(true);
    expect(store.write(cookie('sid', 'old'), T0 + 5)).toBe(false);
    expect(store.get(cookie('sid', ''))).toBeNull();
    expect(store.write(cookie('sid', 'again'), T0 + 20)).toBe(true);
    expect(store.get(cookie('sid', ''))?.value).toBe('again');
    expect(store.remove(cookie('sid', ''), T0 + 15)).toBe(false);
  });

  it('records no removal for a cookie that simply expired', () => {
    const store = new CookieStore();
    const short = cookie('short', 'x', { expires: (T0 + 500) / 1000 });
    store.write(short, T0);
    const changes = mergeExport(store, [], keyed([short]), T0 + 1000);
    expect(changes.removed).toEqual([]);
    expect(store.prune(T0 + 1000)).toBe(true);
    expect(store.get(short)).toBeUndefined();
  });

  it('keeps a tombstone until the cookie would have expired, and 30 days at least', () => {
    const store = new CookieStore();
    const year = cookie('long', 'x', { expires: (T0 + 365 * DAY) / 1000 });
    store.write(year, T0);
    store.write(cookie('session', 'y'), T0);
    store.remove(year, T0 + DAY);
    store.remove(cookie('session', ''), T0 + DAY);
    const [long, session] = store.toJSON().tombstones;
    expect(long).toMatchObject({ name: 'long', until: T0 + 365 * DAY });
    expect(session).toMatchObject({ name: 'session', until: T0 + DAY + TOMBSTONE_MS });

    expect(store.prune(T0 + DAY + TOMBSTONE_MS)).toBe(true);
    expect(store.get(cookie('session', ''))).toBeUndefined();
    expect(store.get(year)).toBeNull();
    store.prune(T0 + 365 * DAY);
    expect(store.toJSON().tombstones).toEqual([]);
  });

  it('round-trips through its file and leaves out what it cannot read', () => {
    const store = new CookieStore();
    store.write(cookie('sid', 'a'), T0);
    store.write(cookie('gone', 'b'), T0);
    store.remove(cookie('gone', ''), T0 + 1);
    const again = CookieStore.parse(JSON.stringify(store.toJSON()));
    expect(again.toJSON()).toEqual(store.toJSON());

    const mixed = JSON.stringify({
      version: 1,
      cookies: [{ cookie: { name: 'x' }, at: 1 }, { cookie: cookie('ok', 'v'), at: 2 }, null],
      tombstones: [{ name: 'y' }, 'nonsense'],
    });
    expect(values(CookieStore.parse(mixed).cookies())).toEqual({ 'ok@.example.com': 'v' });
    expect(CookieStore.parse('not json').cookies()).toEqual([]);
    expect(CookieStore.parse(undefined).cookies()).toEqual([]);
  });

  it('brings a profile that opens in line with the store, adopting what the store never saw', () => {
    const store = new CookieStore();
    store.write(cookie('sid', 'shared'), T0);
    store.write(cookie('extra', 'e'), T0);
    store.write(cookie('logout', 'l'), T0);
    store.remove(cookie('logout', ''), T0 + 1);
    const plan = reconcile(
      store,
      [cookie('sid', 'stale'), cookie('logout', 'l'), cookie('mine', 'm', { domain: 'own.org' })],
      T0 + 2,
    );
    expect(values(plan.add)).toEqual({ 'sid@.example.com': 'shared', 'extra@.example.com': 'e' });
    expect(plan.clear).toEqual([{ name: 'logout', domain: '.example.com', path: '/' }]);
    expect(values(plan.adopted)).toEqual({ 'mine@own.org': 'm' });
    expect(store.get(cookie('mine', '', { domain: 'own.org' }))?.value).toBe('m');
  });
});

describe('CookieSync (K1)', () => {
  it('loads the store into a profile when its browser opens', async () => {
    const saved = new CookieStore();
    saved.write(cookie('sid', 'shared'), T0);
    const fresh = new FakeJar();
    const { sync } = harness({ 1: fresh }, JSON.stringify(saved.toJSON()));
    await sync.init();
    await sync.open(1);
    expect(fresh.value('sid')).toBe('shared');
  });

  it('spreads a login on one screen to the other screens, and a logout too', async () => {
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync, tick, saved } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);

    a.set(cookie('sid', 'logged-in'));
    tick(1000);
    await sync.afterAction(1);
    expect(b.value('sid')).toBe('logged-in');
    expect(saved().get(cookie('sid', ''))?.value).toBe('logged-in');

    b.remove('sid');
    tick(1000);
    await sync.afterAction(2);
    expect(a.value('sid')).toBeUndefined();
    expect(saved().get(cookie('sid', ''))).toBeNull();
    // A's export afterwards sees no change of its own to bring it back.
    tick(1000);
    await sync.sync(1);
    expect(b.value('sid')).toBeUndefined();
  });

  it('lets the newest write win when two screens change one cookie', async () => {
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync, tick } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);
    a.set(cookie('pref', 'from-a'));
    tick(1000);
    await sync.sync(1);
    b.set(cookie('pref', 'from-b'));
    tick(1000);
    await sync.sync(2);
    expect([a.value('pref'), b.value('pref')]).toEqual(['from-b', 'from-b']);
    tick(1000);
    await sync.sync();
    expect([a.value('pref'), b.value('pref')]).toEqual(['from-b', 'from-b']);
  });

  it("reads another screen's own changes before it pushes into it, so none is lost", async () => {
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync, tick, saved } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);
    a.set(cookie('sid', 'a-login'));
    b.set(cookie('cart', 'b-cart'));
    b.set(cookie('pref', 'b-pref'));
    a.set(cookie('pref', 'a-pref'));
    tick(1000);
    await sync.afterAction(1);
    for (const jar of [a, b]) {
      expect([jar.value('sid'), jar.value('cart')]).toEqual(['a-login', 'b-cart']);
    }
    // Seen at the same moment, one value wins on both screens and in the store.
    expect(a.value('pref')).toBe(b.value('pref'));
    expect(saved().get(cookie('pref', ''))?.value).toBe(a.value('pref'));
  });

  it('clears a cookie removed elsewhere from a profile that was offline, and adopts its own logins', async () => {
    const a = new FakeJar([cookie('sid', 'old')]);
    const b = new FakeJar();
    const first = harness({ 1: a });
    await first.sync.init();
    await first.sync.open(1);
    a.remove('sid');
    first.tick(1000);
    await first.sync.close(1);

    // The agent restarts; screen 2's profile still holds the removed cookie,
    // and a login the store never saw.
    b.set(cookie('sid', 'old'));
    b.set(cookie('own', 'login', { domain: 'own.org' }));
    const second = harness({ 2: b, 1: a }, first.store.text);
    second.running.delete(1);
    await second.sync.init();
    await second.sync.open(2);
    expect(b.value('sid')).toBeUndefined();
    expect(b.value('own', 'own.org')).toBe('login');
    expect(second.saved().get(cookie('own', '', { domain: 'own.org' }))?.value).toBe('login');
  });

  it('syncs once for a burst of actions on one screen', async () => {
    const a = new FakeJar();
    const { sync } = harness({ 1: a });
    await sync.init();
    await sync.open(1);
    const reads = a.reads;
    await Promise.all([sync.afterAction(1), sync.afterAction(1), sync.afterAction(1)]);
    expect(a.reads - reads).toBe(1);
  });

  it('opens a screen it has not seen on its first sync', async () => {
    const saved = new CookieStore();
    saved.write(cookie('sid', 'shared'), T0);
    const a = new FakeJar();
    const { sync } = harness({ 1: a }, JSON.stringify(saved.toJSON()));
    await sync.init();
    await sync.afterAction(1);
    expect(a.value('sid')).toBe('shared');
  });

  it('exports a screen that stops, then leaves it out until it opens again', async () => {
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync, tick, running } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);
    a.set(cookie('sid', 'before-stop'));
    tick(1000);
    await sync.close(1);
    running.delete(1);
    expect(b.value('sid')).toBe('before-stop');

    b.set(cookie('sid', 'while-stopped'));
    tick(1000);
    await sync.sync(2);
    expect(a.value('sid')).toBe('before-stop');
    running.add(1);
    await sync.open(1);
    expect(a.value('sid')).toBe('while-stopped');
  });

  it('syncs every running screen on a timer', async () => {
    vi.useFakeTimers();
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);
    sync.start();
    a.set(cookie('sid', 'timer'));
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(b.value('sid')).toBe('timer');
    sync.stop();
    a.set(cookie('sid', 'after-stop'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.value('sid')).toBe('timer');
  });

  it('sets the cookies Chromium takes when it refuses one of them', async () => {
    const saved = new CookieStore();
    saved.write(cookie('good', 'g'), T0);
    saved.write(cookie('bad', 'b', { sameSite: 'None', secure: false }), T0);
    const a = new FakeJar();
    a.refuse.add('bad');
    const { sync } = harness({ 1: a }, JSON.stringify(saved.toJSON()));
    await sync.init();
    await sync.open(1);
    expect(a.value('good')).toBe('g');
    expect(a.value('bad')).toBeUndefined();
  });

  it('reports a screen whose browser it cannot reach and syncs the others', async () => {
    const a = new FakeJar();
    const b = new FakeJar();
    const { sync, errors, running } = harness({ 1: a, 2: b });
    await sync.init();
    await sync.open(1);
    await sync.open(2);
    running.add(3);
    a.set(cookie('sid', 'x'));
    expect(await sync.sync()).toEqual([1, 2]);
    expect(b.value('sid')).toBe('x');
    expect(errors.map((e) => e.screen)).toEqual([3]);
  });

  it('persists only when the store changed', async () => {
    const a = new FakeJar();
    const save = vi.fn(async () => {});
    const sync = new CookieSync({
      jar: async () => a,
      screens: () => [1],
      load: async () => undefined,
      save,
    });
    await sync.init();
    await sync.open(1);
    await sync.sync(1);
    expect(save).not.toHaveBeenCalled();
    a.set(cookie('sid', 'x'));
    await sync.sync(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('the cookie store file (K1, S-7)', () => {
  it("reads and writes the store as the store's own user, the data on stdin", async () => {
    const { run, calls } = fakeRun(() => '{"version":1}');
    expect(await readCookieStore(run, '/var/lib/openbots')).toBe('{"version":1}');
    await writeCookieStore(run, '/var/lib/openbots', '{"version":1,"cookies":[]}');
    expect(calls.map((c) => [c.user, c.args.at(-1)])).toEqual([
      [STORE, '/var/lib/openbots/cookies/store.json'],
      [STORE, '/var/lib/openbots/cookies/store.json'],
    ]);
    expect(calls[1]!.input).toBe('{"version":1,"cookies":[]}');
    // The cookies never go on a command line.
    expect(calls[1]!.args.join(' ')).not.toContain('cookies":[]');
  });

  it('keeps the store in a private directory, replacing it whole, and reads nothing before the first write', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'openbots-state-'));
    expect(await readCookieStore(runAsAgent, stateDir)).toBeUndefined();
    await writeCookieStore(runAsAgent, stateDir, 'first');
    await writeCookieStore(runAsAgent, stateDir, 'second');
    const file = cookieStoreFile(stateDir);
    expect(await readFile(file, 'utf8')).toBe('second');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readCookieStore(runAsAgent, stateDir)).toBe('second');
  });
});
