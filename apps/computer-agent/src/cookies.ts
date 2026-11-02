import path from 'node:path';
import type { BrowserContext, Cookie } from 'playwright-core';
import type { Run } from './proc.js';
import { STORE } from './users.js';

// Shared browser logins (K1). Every Bot keeps its own screen and Chromium
// profile (K2), so Bots still browse in parallel, but the computer keeps one
// cookie store that every screen's Chromium reads from and writes back to.
// Logins carry over through cookies; what a site keeps only in the browser's
// local storage stays with the profile it was written in.
//
// The agent exports a screen's cookies over CDP after each browser and
// computer action, when the owner hands a screen back, every 30 seconds for
// running screens and when a screen stops. It merges them per cookie (name,
// domain, path): the newest write wins, removals included. A removal is
// found by diffing against the screen's previous export and kept as a
// tombstone until the cookie would have expired anyway, so a profile that
// was offline cannot bring it back. What changed goes into the other running
// screens at once; a screen whose browser opens gets the whole store.
//
// The store is on the state volume, in a directory only the store's own user
// may enter (users.ts): neither the Bots' commands nor the screens' users can
// read it (S-7). The agent reads and writes it through a short script run as
// that user, like the screens' private files.

export type CookieJar = Pick<BrowserContext, 'cookies' | 'addCookies' | 'clearCookies'>;

/** What identifies a cookie: a site may set the same name on another domain or path. */
export interface CookieId {
  name: string;
  domain: string;
  path: string;
}

export const cookieKey = (c: CookieId) => JSON.stringify([c.name, c.domain, c.path]);

/** How long a removal is remembered at least; longer when the cookie itself lived longer. */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often running screens are synced on their own. */
export const SYNC_INTERVAL_MS = 30_000;

/** A cookie, or the tombstone of a removed one (`cookie` unset), with when it was written. */
interface Entry {
  id: CookieId;
  cookie?: Cookie;
  at: number;
  /** A tombstone is dropped after this. */
  until?: number;
}

export interface StoreFile {
  version: 1;
  cookies: { cookie: Cookie; at: number }[];
  tombstones: (CookieId & { at: number; until: number })[];
}

const expiresAt = (c: Cookie) => (c.expires > 0 ? c.expires * 1000 : undefined);

/** True when `a` and `b` would behave the same; Chromium may report a fraction of a second. */
export function sameCookie(a: Cookie, b: Cookie): boolean {
  return (
    a.value === b.value &&
    Math.round(a.expires) === Math.round(b.expires) &&
    a.httpOnly === b.httpOnly &&
    a.secure === b.secure &&
    a.sameSite === b.sameSite &&
    a.partitionKey === b.partitionKey
  );
}

const idOf = ({ name, domain, path }: CookieId): CookieId => ({ name, domain, path });

function isCookie(value: unknown): value is Cookie {
  const c = value as Partial<Cookie> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.name === 'string' &&
    typeof c.value === 'string' &&
    typeof c.domain === 'string' &&
    typeof c.path === 'string' &&
    typeof c.expires === 'number'
  );
}

export class CookieStore {
  private readonly entries = new Map<string, Entry>();

  /** A store from its file; anything unreadable in it is left out. */
  static parse(text: string | undefined): CookieStore {
    const store = new CookieStore();
    if (!text) return store;
    let file: Partial<StoreFile>;
    try {
      file = JSON.parse(text) as Partial<StoreFile>;
    } catch {
      return store;
    }
    for (const entry of Array.isArray(file.cookies) ? file.cookies : []) {
      const { cookie, at } = (entry ?? {}) as Partial<StoreFile['cookies'][number]>;
      if (isCookie(cookie) && typeof at === 'number') {
        store.entries.set(cookieKey(cookie), { id: idOf(cookie), cookie, at });
      }
    }
    for (const t of Array.isArray(file.tombstones) ? file.tombstones : []) {
      if (typeof t?.name === 'string' && typeof t.at === 'number' && typeof t.until === 'number') {
        store.entries.set(cookieKey(t), { id: idOf(t), at: t.at, until: t.until });
      }
    }
    return store;
  }

  toJSON(): StoreFile {
    const file: StoreFile = { version: 1, cookies: [], tombstones: [] };
    for (const e of this.entries.values()) {
      if (e.cookie) file.cookies.push({ cookie: e.cookie, at: e.at });
      else file.tombstones.push({ ...e.id, at: e.at, until: e.until! });
    }
    return file;
  }

  /** The cookie under `id`, null for a tombstone, undefined when the store has never seen it. */
  get(id: CookieId): Cookie | null | undefined {
    const e = this.entries.get(cookieKey(id));
    return e ? (e.cookie ?? null) : undefined;
  }

  /** Every cookie the store holds, without the tombstones. */
  cookies(): Cookie[] {
    return [...this.entries.values()].flatMap((e) => (e.cookie ? [e.cookie] : []));
  }

  /** Records `cookie` as written at `at`; false when it changes nothing or a newer write stands. */
  write(cookie: Cookie, at: number): boolean {
    const key = cookieKey(cookie);
    const e = this.entries.get(key);
    if (e && e.at > at) return false;
    if (e?.cookie && sameCookie(e.cookie, cookie)) return false;
    this.entries.set(key, { id: idOf(cookie), cookie, at });
    return true;
  }

  /**
   * Records the removal of the cookie under `id` at `at`, as a tombstone kept
   * until the cookie would have expired, and `TOMBSTONE_MS` at least. False
   * when the store has no such cookie or a newer write stands.
   */
  remove(id: CookieId, at: number): boolean {
    const key = cookieKey(id);
    const e = this.entries.get(key);
    if (!e?.cookie || e.at > at) return false;
    const until = Math.max(expiresAt(e.cookie) ?? 0, at + TOMBSTONE_MS);
    this.entries.set(key, { id: idOf(id), at, until });
    return true;
  }

  /** Drops expired cookies and tombstones; true when anything went. */
  prune(now: number): boolean {
    let pruned = false;
    for (const [key, e] of this.entries) {
      const end = e.cookie ? expiresAt(e.cookie) : e.until;
      if (end !== undefined && end <= now) {
        this.entries.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }
}

/** What an export changed in the store. */
export interface Changes {
  written: Cookie[];
  removed: CookieId[];
}

const byKey = (cookies: Cookie[]) => new Map(cookies.map((c) => [cookieKey(c), c]));
const keysOf = (ids: CookieId[]) => new Map(ids.map((id) => [cookieKey(id), idOf(id)]));

/**
 * Folds a screen's export into the store. `current` is what its Chromium
 * holds now and `last` what it held at its previous export, so a cookie it
 * no longer holds was removed there, unless it simply expired. Returns what
 * changed in the store, for the other screens.
 */
export function mergeExport(
  store: CookieStore,
  current: Cookie[],
  last: Map<string, Cookie>,
  at: number,
): Changes {
  const changes: Changes = { written: [], removed: [] };
  const now = byKey(current);
  for (const [key, cookie] of now) {
    const before = last.get(key);
    if (before && sameCookie(before, cookie)) continue;
    if (store.write(cookie, at)) changes.written.push(cookie);
  }
  for (const [key, before] of last) {
    if (now.has(key)) continue;
    const end = expiresAt(before);
    if (end !== undefined && end <= at) continue;
    if (store.remove(before, at)) changes.removed.push(idOf(before));
  }
  return changes;
}

export interface Reconciled {
  /** Cookies to set in the profile: the store's, where it has a newer or missing one. */
  add: Cookie[];
  /** Cookies to remove from the profile: the store has their tombstones. */
  clear: CookieId[];
  /** The profile's cookies the store had never seen, now in it. */
  adopted: Cookie[];
}

/**
 * What makes a profile that just opened agree with the store. The store wins
 * for every cookie it knows; a cookie it has never seen, such as one from a
 * profile that was logged in before the store existed, joins it.
 */
export function reconcile(store: CookieStore, current: Cookie[], at: number): Reconciled {
  const plan: Reconciled = { add: [], clear: [], adopted: [] };
  const held = byKey(current);
  for (const cookie of held.values()) {
    const stored = store.get(cookie);
    if (stored === undefined) {
      if (store.write(cookie, at)) plan.adopted.push(cookie);
    } else if (stored === null) {
      plan.clear.push(idOf(cookie));
    } else if (!sameCookie(stored, cookie)) {
      plan.add.push(stored);
    }
  }
  for (const cookie of store.cookies()) {
    if (!held.has(cookieKey(cookie))) plan.add.push(cookie);
  }
  return plan;
}

export interface CookieSyncDeps {
  /** The cookies of running screen `n`'s Chromium; throws when it has none. */
  jar(n: number): Promise<CookieJar>;
  /** The screens running now. */
  screens(): number[];
  /** The persisted store, undefined when there is none yet. */
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown, screen?: number) => void;
}

export class CookieSync {
  private store = new CookieStore();
  /** Each open screen's cookies at its last export or load, by `cookieKey`. */
  private readonly last = new Map<number, Map<string, Cookie>>();
  /** Screens with a sync queued after an action, so a burst of actions syncs once. */
  private readonly queued = new Set<number>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: CookieSyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Reads the persisted store; call once before the first screen opens. */
  init(): Promise<void> {
    return this.enqueue(async () => {
      this.store = CookieStore.parse(await this.deps.load());
      if (this.store.prune(this.now())) await this.persist();
    });
  }

  /** Every cookie the store holds. */
  cookies(): Cookie[] {
    return this.store.cookies();
  }

  /** Screen `n`'s Chromium has just started: it gets the store, and adds what only it had. */
  open(n: number): Promise<void> {
    return this.enqueue(() => this.load(n), n);
  }

  /**
   * Exports screen `n`, or every running screen, and spreads what changed.
   * Resolves to the screens that synced.
   */
  async sync(n?: number): Promise<number[]> {
    const synced: number[] = [];
    await this.enqueue(async () => {
      for (const screen of n === undefined ? this.deps.screens() : [n]) {
        try {
          await this.exportScreen(screen);
          synced.push(screen);
        } catch (error) {
          this.deps.onError?.(error, screen);
        }
      }
    });
    return synced;
  }

  /** After a browser or computer action on screen `n`; resolves once the sync ran. */
  afterAction(n: number): Promise<void> {
    if (this.queued.has(n)) return this.queue;
    this.queued.add(n);
    return this.enqueue(async () => {
      this.queued.delete(n);
      await this.exportScreen(n);
    }, n);
  }

  /** Screen `n` is about to stop: a last export, then it is forgotten until it opens again. */
  close(n: number): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (this.last.has(n)) await this.exportScreen(n);
      } finally {
        this.last.delete(n);
      }
    }, n);
  }

  /** Resolves once everything queued so far has run. */
  idle(): Promise<void> {
    return this.queue;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.sync(), this.deps.intervalMs ?? SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One thing at a time, so two screens' exports never interleave. */
  private enqueue(task: () => Promise<void>, screen?: number): Promise<void> {
    const next = this.queue
      .then(task)
      .catch((error: unknown) => this.deps.onError?.(error, screen));
    this.queue = next;
    return next;
  }

  private async load(n: number): Promise<void> {
    const jar = await this.deps.jar(n);
    const at = this.now();
    const pruned = this.store.prune(at);
    const current = await jar.cookies();
    const plan = reconcile(this.store, current, at);
    const held = byKey(current);
    for (const id of plan.clear) {
      await jar.clearCookies(id);
      held.delete(cookieKey(id));
    }
    for (const cookie of await addAll(jar, plan.add)) held.set(cookieKey(cookie), cookie);
    this.last.set(n, held);
    if (plan.adopted.length > 0) await this.spread(n, keysOf(plan.adopted), at);
    if (pruned || plan.adopted.length > 0) await this.persist();
  }

  private async exportScreen(n: number): Promise<void> {
    if (!this.last.has(n)) return this.load(n);
    const at = this.now();
    const changed = await this.fold(n, at);
    const pruned = this.store.prune(at);
    if (changed.size === 0) {
      if (pruned) await this.persist();
      return;
    }
    await this.spread(n, changed, at);
    await this.persist();
  }

  /** Merges what screen `n` changed since its last export; returns the keys the store took. */
  private async fold(n: number, at: number): Promise<Map<string, CookieId>> {
    const jar = await this.deps.jar(n);
    const current = await jar.cookies();
    const changes = mergeExport(this.store, current, this.last.get(n) ?? new Map(), at);
    this.last.set(n, byKey(current));
    return keysOf([...changes.written, ...changes.removed]);
  }

  /**
   * Brings every open, running screen in line with the store for the cookies
   * `from` changed. Each other screen is exported first, so a change of its
   * own it had not exported yet is merged, not overwritten; whatever that
   * changes goes everywhere too.
   */
  private async spread(from: number, changed: Map<string, CookieId>, at: number): Promise<void> {
    const running = new Set(this.deps.screens());
    const reached = [from];
    for (const n of this.last.keys()) {
      if (n === from || !running.has(n)) continue;
      try {
        for (const [key, id] of await this.fold(n, at)) changed.set(key, id);
        reached.push(n);
      } catch (error) {
        this.deps.onError?.(error, n);
      }
    }
    for (const n of reached) {
      const held = this.last.get(n)!;
      const add: Cookie[] = [];
      const clear: CookieId[] = [];
      for (const [key, id] of changed) {
        const stored = this.store.get(id);
        const have = held.get(key);
        if (stored && !(have && sameCookie(have, stored))) add.push(stored);
        else if (!stored && have) clear.push(id);
      }
      if (add.length === 0 && clear.length === 0) continue;
      try {
        const jar = await this.deps.jar(n);
        for (const id of clear) {
          await jar.clearCookies(id);
          held.delete(cookieKey(id));
        }
        for (const cookie of await addAll(jar, add)) held.set(cookieKey(cookie), cookie);
      } catch (error) {
        this.deps.onError?.(error, n);
      }
    }
  }

  private async persist(): Promise<void> {
    await this.deps.save(JSON.stringify(this.store.toJSON()));
  }
}

/**
 * Sets `cookies` in `jar`, one at a time when Chromium refuses the batch, so
 * one cookie it will not take does not hold back the rest. Returns those set.
 */
async function addAll(jar: CookieJar, cookies: Cookie[]): Promise<Cookie[]> {
  if (cookies.length === 0) return [];
  try {
    await jar.addCookies(cookies);
    return cookies;
  } catch {
    const added: Cookie[] = [];
    for (const cookie of cookies) {
      try {
        await jar.addCookies([cookie]);
        added.push(cookie);
      } catch {
        // Refused, e.g. SameSite=None without Secure; the store keeps it.
      }
    }
    return added;
  }
}

/** Where the store is kept: its own user's directory on the state volume (privileges.ts). */
export const cookieStoreDir = (stateDir: string) => path.join(stateDir, 'cookies');
export const cookieStoreFile = (stateDir: string) =>
  path.join(cookieStoreDir(stateDir), 'store.json');

// Run as the store's user with node. Argument: the store file. Prints it,
// or nothing when there is none yet.
const READ_SCRIPT = `const fs = require('node:fs');
try {
  process.stdout.write(fs.readFileSync(process.argv[1]));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}`;

// Run as the store's user with node. Argument: the store file. Stdin: the
// new store, which replaces the old one whole. The directory is there in the
// image (privileges.ts); an agent without the helper makes its own.
const WRITE_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[1];
const data = fs.readFileSync(0);
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file + '.openbots', data, { mode: 0o600 });
fs.renameSync(file + '.openbots', file);`;

/** Reads the persisted store as its own user. */
export async function readCookieStore(run: Run, stateDir: string): Promise<string | undefined> {
  const { stdout } = await run(process.execPath, ['-e', READ_SCRIPT, cookieStoreFile(stateDir)], {
    user: STORE,
  });
  return stdout.length > 0 ? stdout.toString('utf8') : undefined;
}

/** Replaces the persisted store as its own user. */
export async function writeCookieStore(run: Run, stateDir: string, text: string): Promise<void> {
  await run(process.execPath, ['-e', WRITE_SCRIPT, cookieStoreFile(stateDir)], {
    user: STORE,
    input: text,
  });
}
