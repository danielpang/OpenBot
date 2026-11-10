import { randomUUID } from 'node:crypto';
import { isHostId } from '@openbots/tunnel';
import type { PairedServer, ProfileKind, ProfilesView, ServerProfile } from '../ipc.js';
import { parseServerAddress } from '../server-url.js';
import { parseRelayUrl } from './pairing.js';
import { FIRST_PORT } from '../stack/port.js';
import { envPort } from '../stack/manager.js';

// Server profiles (plan 14.4): the local stack, the hosted OpenBots server
// when the build names one, any self-hosted server, tunnel or remote URL, and
// the servers this Mac paired with through their relay (./paired.ts), whose
// URL is the loopback address of the app's proxy into the tunnel.
// Kept as JSON in the app's userData directory with whether the owner has
// chosen a connection yet; the session token of each profile lives apart from
// it, in ./tokens.ts.

export const LOCAL_PROFILE_ID = 'local';
export const CLOUD_PROFILE_ID = 'cloud';
export const DEFAULT_LOCAL_PORT = FIRST_PORT;

export interface ProfileFiles {
  /** Rejects when the file is missing. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * The URL of the local stack, from OPENBOTS_HTTP_PORT in its `.env` when set:
 * the free port the stack manager chose for it, read as Compose reads it.
 */
export function localServerUrl(envText?: string): string {
  return `http://localhost:${envText == null ? DEFAULT_LOCAL_PORT : envPort(envText)}`;
}

export function localProfile(url = localServerUrl()): ServerProfile {
  return { id: LOCAL_PROFILE_ID, name: 'This Mac', url, kind: 'local' };
}

/** The hosted OpenBots server; its URL comes from the build (./app-config.ts). */
export function cloudProfile(url: string): ServerProfile {
  return { id: CLOUD_PROFILE_ID, name: 'OpenBots account', url, kind: 'cloud' };
}

/**
 * A server URL as a profile stores it: http or https, the origin only, since
 * the server serves the web app at its root. Throws ProfileError otherwise.
 */
export function normalizeServerUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ProfileError('Enter a server URL, like https://openbots.example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProfileError('A server URL starts with http:// or https://.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProfileError('Leave the user name and password out of the server URL.');
  }
  return url.origin;
}

function isProfile(value: unknown): value is ServerProfile {
  const p = value as Partial<ServerProfile> | null;
  return (
    typeof p?.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.url === 'string' &&
    (p.kind === 'local' || p.kind === 'remote' || p.kind === 'paired')
  );
}

/** The loopback origin of a paired server's proxy: `http://127.0.0.1:<port>`. */
export function pairedProxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** A paired profile's port, or null when its URL is not a proxy's. */
export function pairedPort(url: string): number | null {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(url);
  const port = match ? Number(match[1]) : NaN;
  return port >= 1 && port <= 65535 ? port : null;
}

/** What a paired profile keeps from its pairing link, checked again when read from disk. */
function readPaired(value: unknown): PairedServer | null {
  const p = value as Partial<PairedServer> | null;
  if (
    typeof p?.hostId !== 'string' ||
    !isHostId(p.hostId) ||
    typeof p.serverKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.serverKey) ||
    typeof p.deviceId !== 'string' ||
    p.deviceId === ''
  ) {
    return null;
  }
  const relayUrl = parseRelayUrl(p.relayUrl);
  return relayUrl
    ? { hostId: p.hostId, relayUrl, serverKey: p.serverKey, deviceId: p.deviceId }
    : null;
}

/**
 * Reads stored profiles. A missing or unreadable file, or bad entries in it,
 * fall back to the local profile alone; the local profile is always first and
 * always follows the stack's current URL, and the cloud profile, when the
 * build names a hosted server, comes next. `chosen` is whether the owner has
 * picked a connection: a file from before the choice existed that names an
 * active profile counts as one, and an active profile that is gone (a cloud
 * profile in a build without one) does not.
 */
export function parseProfiles(
  text: string | undefined,
  localUrl: string,
  cloudUrl: string | null = null,
): ProfilesView {
  let stored: { activeId?: unknown; profiles?: unknown; chosen?: unknown } = {};
  try {
    stored = text ? (JSON.parse(text) as typeof stored) : {};
  } catch {
    stored = {};
  }
  const remotes: ServerProfile[] = [];
  for (const entry of Array.isArray(stored.profiles) ? stored.profiles : []) {
    if (!isProfile(entry) || entry.kind === 'local') continue;
    if (remotes.some((p) => p.id === entry.id)) continue;
    if (entry.kind === 'paired') {
      const paired = readPaired(entry.paired);
      if (paired && pairedPort(entry.url) != null) {
        remotes.push({ id: entry.id, name: entry.name, url: entry.url, kind: 'paired', paired });
      }
      continue;
    }
    try {
      const url = normalizeServerUrl(entry.url);
      remotes.push({ id: entry.id, name: entry.name, url, kind: entry.kind });
    } catch {
      // A hand-edited, unusable URL: drop the entry.
    }
  }
  const profiles = [
    localProfile(localUrl),
    ...(cloudUrl ? [cloudProfile(cloudUrl)] : []),
    ...remotes,
  ];
  const found =
    typeof stored.activeId === 'string' && profiles.some((p) => p.id === stored.activeId);
  const activeId = found ? (stored.activeId as string) : LOCAL_PROFILE_ID;
  const chosen =
    found && (stored.chosen === true || (stored.chosen === undefined && stored.activeId != null));
  return { activeId, profiles, chosen };
}

export interface ProfileStore {
  list(): Promise<ProfilesView>;
  active(): Promise<ServerProfile>;
  add(input: { name?: string; url: string }): Promise<ServerProfile>;
  /**
   * Saves a server this Mac paired with. Pairing the same server again
   * (the same host id) updates its profile, keeping its id and address.
   */
  addPaired(input: { name: string; url: string; paired: PairedServer }): Promise<ServerProfile>;
  /** A paired profile's proxy moved to another port. */
  setUrl(id: string, url: string): Promise<ServerProfile>;
  /** The local and cloud profiles cannot be removed; removing the active one activates local. */
  remove(id: string): Promise<ProfilesView>;
  /** Makes the profile active, which is also the owner's choice of connection. */
  setActive(id: string): Promise<ServerProfile>;
  /**
   * Writes the file, with no connection chosen, when there is none yet: the
   * welcome screen is showing, so a stack `.env` that a failed "Run OpenBots
   * on this Mac" leaves behind is not later read as a choice of This Mac.
   */
  recordNoChoice(): Promise<void>;
}

export interface ProfileStoreOptions {
  files: ProfileFiles;
  /** `profiles.json` in userData. */
  path: string;
  /** The local stack's URL; read each time, since its `.env` can change. */
  localUrl?: () => Promise<string>;
  /** The hosted OpenBots server's URL from the build, or null when it has none. */
  cloudUrl?: string | null;
  /**
   * An install from before the first-run choice may have no profiles file but
   * a local stack it set up: that is a choice of This Mac.
   */
  hasLocalStack?: () => Promise<boolean>;
  newId?: () => string;
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const { files, path } = options;
  const localUrl = options.localUrl ?? (async () => localServerUrl());
  const newId = options.newId ?? randomUUID;
  const cloudUrl = options.cloudUrl ?? null;
  const hasLocalStack = options.hasLocalStack ?? (async () => false);
  // Writes go one after another so two quick changes cannot lose one.
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<ProfilesView> {
    const text = await files.readFile(path).catch(() => undefined);
    const view = parseProfiles(text, await localUrl(), cloudUrl);
    if (text === undefined && (await hasLocalStack().catch(() => false))) {
      return { ...view, chosen: true };
    }
    return view;
  }

  async function write(view: ProfilesView): Promise<void> {
    // The local and cloud profiles' URLs come from the stack and the build; store only the rest.
    const remotes = view.profiles.filter((p) => p.kind === 'remote' || p.kind === 'paired');
    await files.writeFile(
      path,
      `${JSON.stringify({ activeId: view.activeId, chosen: view.chosen, profiles: remotes }, null, 2)}\n`,
    );
  }

  function update<T>(fn: (view: ProfilesView) => { view?: ProfilesView; result: T }): Promise<T> {
    const next = chain.then(async () => {
      const { view, result } = fn(await read());
      if (view) await write(view);
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  const find = (view: ProfilesView, id: string) => view.profiles.find((p) => p.id === id);

  return {
    list: read,

    async active() {
      const view = await read();
      return find(view, view.activeId)!;
    },

    async add({ name, url }) {
      let normalized: string;
      try {
        normalized = parseServerAddress(url).url;
      } catch (error) {
        throw new ProfileError(error instanceof Error ? error.message : String(error));
      }
      return update((view) => {
        const existing = view.profiles.find((p) => p.kind !== 'paired' && p.url === normalized);
        if (existing) return { result: existing };
        const kind: ProfileKind = 'remote';
        const profile = {
          id: newId(),
          name: name?.trim() || new URL(normalized).host,
          url: normalized,
          kind,
        };
        return { view: { ...view, profiles: [...view.profiles, profile] }, result: profile };
      });
    },

    async addPaired({ name, url, paired }) {
      if (pairedPort(url) == null)
        throw new ProfileError('A paired server needs its proxy address.');
      return update((view) => {
        const existing = view.profiles.find(
          (p) => p.kind === 'paired' && p.paired?.hostId === paired.hostId,
        );
        const profile: ServerProfile = {
          id: existing?.id ?? newId(),
          name: name.trim() || 'OpenBots',
          url: existing?.url ?? url,
          kind: 'paired',
          paired,
        };
        const profiles = existing
          ? view.profiles.map((p) => (p.id === existing.id ? profile : p))
          : [...view.profiles, profile];
        return { view: { ...view, profiles }, result: profile };
      });
    },

    setUrl(id, url) {
      return update((view) => {
        const profile = find(view, id);
        if (profile?.kind !== 'paired' || pairedPort(url) == null) {
          throw new ProfileError('Only a paired server moves to another address.');
        }
        if (profile.url === url) return { result: profile };
        const moved = { ...profile, url };
        const profiles = view.profiles.map((p) => (p.id === id ? moved : p));
        return { view: { ...view, profiles }, result: moved };
      });
    },

    remove(id) {
      return update((view) => {
        if (id === LOCAL_PROFILE_ID) throw new ProfileError('The local profile cannot be removed.');
        if (id === CLOUD_PROFILE_ID)
          throw new ProfileError('The OpenBots account cannot be removed.');
        if (!find(view, id)) return { result: view };
        const next = {
          ...view,
          activeId: view.activeId === id ? LOCAL_PROFILE_ID : view.activeId,
          profiles: view.profiles.filter((p) => p.id !== id),
        };
        return { view: next, result: next };
      });
    },

    setActive(id) {
      return update((view) => {
        const profile = find(view, id);
        if (!profile) throw new ProfileError('No such server profile.');
        return { view: { ...view, activeId: id, chosen: true }, result: profile };
      });
    },

    recordNoChoice() {
      const next = chain.then(async () => {
        if ((await files.readFile(path).catch(() => undefined)) !== undefined) return;
        await write({ ...parseProfiles(undefined, await localUrl(), cloudUrl), chosen: false });
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
