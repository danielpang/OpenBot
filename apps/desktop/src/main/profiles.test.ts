import { describe, expect, it } from 'vitest';
import {
  CLOUD_PROFILE_ID,
  createProfileStore,
  LOCAL_PROFILE_ID,
  localServerUrl,
  normalizeServerUrl,
  parseProfiles,
  ProfileError,
  type ProfileFiles,
} from './profiles.js';

function memoryFiles(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const files: ProfileFiles = {
    readFile: async (path) => {
      const text = data.get(path);
      if (text == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (path, text) => void data.set(path, text),
  };
  return { files, data };
}

const PATH = '/user-data/profiles.json';

function store(
  initial?: Record<string, string>,
  localUrl = 'http://localhost:3000',
  extra: { cloudUrl?: string | null; hasLocalStack?: () => Promise<boolean> } = {},
) {
  const { files, data } = memoryFiles(initial);
  let n = 0;
  const profiles = createProfileStore({
    files,
    path: PATH,
    localUrl: async () => localUrl,
    newId: () => `p${++n}`,
    ...extra,
  });
  return { profiles, data };
}

describe('server URLs', () => {
  it('keeps the origin of an http or https URL', () => {
    expect(normalizeServerUrl('https://openbots.example.com/some/path?x=1')).toBe(
      'https://openbots.example.com',
    );
    expect(normalizeServerUrl(' http://192.168.1.4:3000 ')).toBe('http://192.168.1.4:3000');
    expect(normalizeServerUrl('openbots.example.com')).toBe('https://openbots.example.com');
  });

  it('rejects other schemes, credentials and garbage', () => {
    expect(() => normalizeServerUrl('file:///etc/passwd')).toThrow(ProfileError);
    expect(() => normalizeServerUrl('javascript://alert(1)')).toThrow(ProfileError);
    expect(() => normalizeServerUrl('https://me:secret@openbots.example.com')).toThrow(/user name/);
    expect(() => normalizeServerUrl('http://')).toThrow(ProfileError);
  });

  it('reads the local port from the stack .env', () => {
    expect(localServerUrl()).toBe('http://localhost:3000');
    expect(localServerUrl('OPENBOTS_HTTP_PORT=8080\n')).toBe('http://localhost:8080');
    expect(localServerUrl('# OPENBOTS_HTTP_PORT=9\nOPENBOTS_HTTP_PORT="4000"\n')).toBe(
      'http://localhost:4000',
    );
    expect(localServerUrl('OPENBOTS_HTTP_PORT=99999\n')).toBe('http://localhost:3000');
    // As Compose reads .env: the last line wins.
    expect(localServerUrl('OPENBOTS_HTTP_PORT=3000\nOPENBOTS_HTTP_PORT=3002\n')).toBe(
      'http://localhost:3002',
    );
  });
});

describe('parseProfiles', () => {
  it('falls back to the local profile alone', () => {
    for (const text of [undefined, '', 'not json', '[]', '{"profiles": 3}']) {
      expect(parseProfiles(text, 'http://localhost:3000')).toEqual({
        activeId: LOCAL_PROFILE_ID,
        profiles: [{ id: 'local', name: 'This Mac', url: 'http://localhost:3000', kind: 'local' }],
        chosen: false,
      });
    }
  });

  it('drops bad, duplicate and local entries and an unknown active id', () => {
    const text = JSON.stringify({
      activeId: 'gone',
      profiles: [
        { id: 'a', name: 'Work', url: 'https://work.example.com/', kind: 'remote' },
        { id: 'a', name: 'Again', url: 'https://again.example.com', kind: 'remote' },
        { id: 'local', name: 'Old local', url: 'http://localhost:1', kind: 'local' },
        { id: 'b', name: 'Bad', url: 'ftp://x', kind: 'remote' },
        { id: 'c', name: 3, url: 'https://c.example.com', kind: 'remote' },
      ],
    });
    const view = parseProfiles(text, 'http://localhost:3001');
    expect(view.activeId).toBe('local');
    expect(view.profiles).toEqual([
      { id: 'local', name: 'This Mac', url: 'http://localhost:3001', kind: 'local' },
      { id: 'a', name: 'Work', url: 'https://work.example.com', kind: 'remote' },
    ]);
    // The active profile is gone, so the owner chooses again.
    expect(view.chosen).toBe(false);
  });

  it('counts a file from before the choice existed that names an active profile as chosen', () => {
    const old = JSON.stringify({ activeId: 'local', profiles: [] });
    expect(parseProfiles(old, 'http://localhost:3000').chosen).toBe(true);
    const remote = JSON.stringify({
      activeId: 'a',
      profiles: [{ id: 'a', name: 'Work', url: 'https://w.example.com', kind: 'remote' }],
    });
    expect(parseProfiles(remote, 'http://localhost:3000')).toMatchObject({
      activeId: 'a',
      chosen: true,
    });
    const unchosen = JSON.stringify({ activeId: 'local', chosen: false, profiles: [] });
    expect(parseProfiles(unchosen, 'http://localhost:3000').chosen).toBe(false);
  });

  it('adds the cloud profile only when the build names a hosted server', () => {
    const text = JSON.stringify({ activeId: 'cloud', chosen: true, profiles: [] });
    expect(parseProfiles(text, 'http://localhost:3000', 'https://app.openbots.example')).toEqual({
      activeId: CLOUD_PROFILE_ID,
      chosen: true,
      profiles: [
        { id: 'local', name: 'This Mac', url: 'http://localhost:3000', kind: 'local' },
        {
          id: 'cloud',
          name: 'OpenBots account',
          url: 'https://app.openbots.example',
          kind: 'cloud',
        },
      ],
    });
    // A build without one falls back, and the owner chooses again.
    expect(parseProfiles(text, 'http://localhost:3000', null)).toMatchObject({
      activeId: 'local',
      chosen: false,
    });
  });
});

describe('profile store', () => {
  it('starts with the local profile active and no connection chosen', async () => {
    const { profiles } = store();
    expect((await profiles.active()).id).toBe('local');
    expect(await profiles.list()).toMatchObject({ chosen: false });
    expect((await profiles.list()).profiles).toHaveLength(1);
  });

  it('persists the choice when a profile is made active', async () => {
    const { profiles, data } = store();
    await profiles.setActive('local');
    expect(JSON.parse(data.get(PATH)!)).toEqual({ activeId: 'local', chosen: true, profiles: [] });
    expect((await profiles.list()).chosen).toBe(true);
  });

  it('migrates an install that set up the local stack before profiles.json existed', async () => {
    const withStack = store(undefined, undefined, { hasLocalStack: async () => true });
    expect(await withStack.profiles.list()).toMatchObject({ activeId: 'local', chosen: true });
    const without = store(undefined, undefined, { hasLocalStack: async () => false });
    expect((await without.profiles.list()).chosen).toBe(false);
    // A file wins over the stack: a choice reset there stays reset.
    const file = { [PATH]: JSON.stringify({ activeId: 'local', chosen: false, profiles: [] }) };
    const reset = store(file, undefined, { hasLocalStack: async () => true });
    expect((await reset.profiles.list()).chosen).toBe(false);
  });

  it('records that no connection is chosen, so a later stack .env is not a choice', async () => {
    let hasStack = false;
    const { profiles, data } = store(undefined, undefined, { hasLocalStack: async () => hasStack });
    await profiles.recordNoChoice();
    expect(JSON.parse(data.get(PATH)!)).toEqual({ activeId: 'local', chosen: false, profiles: [] });
    // "Run OpenBots on this Mac" wrote the stack's .env, then failed.
    hasStack = true;
    expect((await profiles.list()).chosen).toBe(false);
    // A file that is there already stays as it is.
    await profiles.setActive('local');
    await profiles.recordNoChoice();
    expect((await profiles.list()).chosen).toBe(true);
  });

  it('keeps the cloud profile out of the file and refuses to remove it', async () => {
    const { profiles, data } = store(undefined, undefined, {
      cloudUrl: 'https://app.openbots.example',
    });
    const cloud = await profiles.setActive('cloud');
    expect(cloud).toMatchObject({ kind: 'cloud', url: 'https://app.openbots.example' });
    expect(JSON.parse(data.get(PATH)!)).toEqual({ activeId: 'cloud', chosen: true, profiles: [] });
    await expect(profiles.remove('cloud')).rejects.toThrow(/cannot be removed/);
  });

  it('adds, activates and persists a remote profile', async () => {
    const { profiles, data } = store();
    const added = await profiles.add({ url: 'https://openbots.example.com/app' });
    expect(added).toEqual({
      id: 'p1',
      name: 'openbots.example.com',
      url: 'https://openbots.example.com',
      kind: 'remote',
    });
    await profiles.setActive('p1');
    expect((await profiles.active()).url).toBe('https://openbots.example.com');
    // The local profile's URL is not stored: it follows the stack.
    expect(JSON.parse(data.get(PATH)!)).toEqual({
      activeId: 'p1',
      chosen: true,
      profiles: [added],
    });
  });

  it('does not add the same server twice', async () => {
    const { profiles } = store();
    const first = await profiles.add({ name: 'Work', url: 'https://w.example.com' });
    const second = await profiles.add({ name: 'Other', url: 'https://w.example.com/' });
    expect(second).toEqual(first);
    expect((await profiles.list()).profiles).toHaveLength(2);
  });

  it('keeps every write when changes come quickly', async () => {
    const { profiles } = store();
    await Promise.all([
      profiles.add({ url: 'https://a.example.com' }),
      profiles.add({ url: 'https://b.example.com' }),
      profiles.add({ url: 'https://c.example.com' }),
    ]);
    expect((await profiles.list()).profiles.map((p) => p.url)).toEqual([
      'http://localhost:3000',
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('removing the active profile activates local; local cannot be removed', async () => {
    const { profiles } = store();
    await profiles.add({ url: 'https://a.example.com' });
    await profiles.setActive('p1');
    const view = await profiles.remove('p1');
    expect(view.activeId).toBe('local');
    expect(view.profiles.map((p) => p.id)).toEqual(['local']);
    await expect(profiles.remove('local')).rejects.toThrow(/cannot be removed/);
    await expect(profiles.setActive('nope')).rejects.toThrow(ProfileError);
  });

  it('rejects an unusable URL without writing', async () => {
    const { profiles, data } = store();
    await expect(profiles.add({ url: 'file:///x' })).rejects.toThrow(ProfileError);
    // Plain http only for this Mac or a private network.
    await expect(profiles.add({ url: 'http://openbots.example.com' })).rejects.toThrow(/https/);
    expect(data.has(PATH)).toBe(false);
  });

  it('gives the local profile the stack URL it reads now', async () => {
    const { profiles } = store(undefined, 'http://localhost:8080');
    expect((await profiles.active()).url).toBe('http://localhost:8080');
  });
});
