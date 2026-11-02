import { describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '../ipc.js';
import type { StackStatus } from '../stack/manager.js';
import { fakeFetch, openBotsServer, type Answer } from './fake-fetch.js';
import { createLauncher } from './launcher.js';
import { createOpener, type OpenerWindows } from './opener.js';
import { createProfileStore, type ProfileFiles } from './profiles.js';
import {
  createServerGate,
  LOCAL_STOPPED,
  NOT_OPENBOTS_SERVER,
  verifyServer,
} from './server-gate.js';

// The opener with the real gate, profiles and launcher; only the window,
// fetch and Docker are fakes. The window records every page it is given, so
// a test can say a server page never loaded.

const PATH = '/user-data/profiles.json';
const LOCAL = 'http://localhost:3000';
const CLOUD = 'https://app.openbots.example';
const SELF = 'https://openbots.example.com';
const BENTO = 'http://localhost:3000';

/** Another app's dev server on the stack's port: HTML on every path. */
function website(url: string): Record<string, Answer> {
  return {
    [`${url}/`]: { status: 200 },
    [`${url}/healthz`]: { status: 404 },
    [`${url}/api/v1/setup`]: { status: 404 },
    [`${url}/readyz`]: { status: 404 },
  };
}

const ready = {
  state: 'ready' as const,
  cli: 'docker',
  runtime: 'orbstack' as const,
  serverVersion: '27',
  composeVersion: '2.30',
};
const running: StackStatus = {
  docker: ready,
  services: [{ service: 'openbots', state: 'running', health: 'healthy' }],
  upgrade: null,
  port: { port: 3000, taken: false, free: null },
};
const stopped: StackStatus = { ...running, services: [] };
const portTaken: StackStatus = { ...stopped, port: { port: 3000, taken: true, free: 3001 } };

type Shown =
  | { page: 'server'; url: string }
  | { page: 'start'; profile: string; error: string }
  | { page: 'welcome' }
  | { page: 'navigate'; path: string };

interface FakeWindow {
  profile: ServerProfile;
  url: string | null;
}

function setup(
  options: {
    file?: object;
    hasLocalStack?: boolean;
    routes?: Record<string, Answer>;
    status?: StackStatus;
    cloudUrl?: string | null;
  } = {},
) {
  const data = new Map<string, string>();
  if (options.file) data.set(PATH, JSON.stringify(options.file));
  const files: ProfileFiles = {
    readFile: async (path) => {
      const text = data.get(path);
      if (text == null) throw new Error('ENOENT');
      return text;
    },
    writeFile: async (path, text) => void data.set(path, text),
  };
  const profiles = createProfileStore({
    files,
    path: PATH,
    localUrl: async () => LOCAL,
    cloudUrl: options.cloudUrl ?? null,
    hasLocalStack: async () => options.hasLocalStack ?? false,
    newId: () => 'p1',
  });
  const fetch = fakeFetch(options.routes ?? {});
  const stack = {
    status: vi.fn(async () => options.status ?? running),
    start: vi.fn(async () => running),
    stop: vi.fn(async () => stopped),
    refresh: vi.fn(async () => false),
    pendingUpgrade: vi.fn(async () => null),
  };
  const gate = createServerGate({
    verify: (profile) => verifyServer(profile, { fetch, stack }),
  });
  const verify = vi.spyOn(gate, 'verify');

  let current: FakeWindow | null = null;
  const shown: Shown[] = [];
  const windows: OpenerWindows<FakeWindow> = {
    forProfile: async (profile) => {
      if (current?.profile.id !== profile.id) current = { profile, url: null };
      current.profile = profile;
      return current;
    },
    showsServer: (window, profile) =>
      window.url != null && new URL(window.url).origin === new URL(profile.url).origin,
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(),
    load: async (window, url) => {
      window.url = url;
      shown.push({ page: 'server', url });
    },
    navigate: (_window, path) => void shown.push({ page: 'navigate', path }),
    showStart: async (window, profile, refusal) => {
      window.url = null;
      shown.push({ page: 'start', profile: profile.id, error: refusal.message });
    },
  };
  const opener = createOpener({ gate, windows });
  // As ./index.ts gives the launcher the window.
  const launcher = createLauncher({
    profiles,
    stack,
    fetch,
    cloudUrl: options.cloudUrl ?? null,
    wait: { sleep: async () => undefined, timeoutMs: 0 },
    window: {
      openServer: async (profile, path) => (await opener.open(profile, path)).opened,
      showStart: async () => undefined,
      showWelcome: async () => {
        const window = await windows.forProfile(await profiles.active());
        window.url = null;
        shown.push({ page: 'welcome' });
      },
    },
  });
  const servers = () => shown.filter((s) => s.page === 'server');
  return { opener, launcher, profiles, windows, verify, shown, servers, stack };
}

describe('the welcome screen', () => {
  it('never loads a server, even with one on the local port', async () => {
    const { launcher, shown, verify } = setup({ routes: website(BENTO) });
    await expect(launcher.launch()).resolves.toBe('welcome');
    expect(shown).toEqual([{ page: 'welcome' }]);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('This Mac', () => {
  it("refuses another app on the stack's port, as on the owner's Mac", async () => {
    // No profiles.json, a stack .env left by an earlier setup on port 3000,
    // no OpenBots containers, and a Next.js dev server holding port 3000.
    const { launcher, shown, servers, windows } = setup({
      hasLocalStack: true,
      routes: website(BENTO),
      status: portTaken,
    });
    await expect(launcher.launch()).resolves.toBe('start');
    expect(servers()).toEqual([]);
    expect(shown).toEqual([
      {
        page: 'start',
        profile: 'local',
        error: 'Port 3000 on this Mac is used by another app, not OpenBots.',
      },
    ]);
    expect(windows.signIn).not.toHaveBeenCalled();
  });

  it('shows the start page when the stack is stopped', async () => {
    const { opener, profiles, shown, servers } = setup({ status: stopped });
    await opener.open(await profiles.active());
    expect(servers()).toEqual([]);
    expect(shown).toEqual([{ page: 'start', profile: 'local', error: LOCAL_STOPPED }]);
  });

  it('opens the running stack once it answers as OpenBots', async () => {
    const { opener, profiles, shown, windows } = setup({ routes: openBotsServer(LOCAL) });
    await expect(opener.open(await profiles.active(), '/setup')).resolves.toMatchObject({
      opened: true,
    });
    expect(shown).toEqual([{ page: 'server', url: `${LOCAL}/setup` }]);
    expect(windows.signIn).toHaveBeenCalled();
  });
});

describe('a self-hosted server', () => {
  const remote = { id: 'a', name: 'Work', url: SELF, kind: 'remote' };

  it('is refused when its address does not answer as OpenBots', async () => {
    const { launcher, shown, servers, windows } = setup({
      file: { activeId: 'a', chosen: true, profiles: [remote] },
      routes: website(SELF),
    });
    await expect(launcher.launch()).resolves.toBe('start');
    expect(servers()).toEqual([]);
    expect(shown).toEqual([{ page: 'start', profile: 'a', error: NOT_OPENBOTS_SERVER }]);
    expect(windows.signOut).toHaveBeenCalled();
  });

  it('opens when it does', async () => {
    const { launcher, shown } = setup({
      file: { activeId: 'a', chosen: true, profiles: [remote] },
      routes: openBotsServer(SELF),
    });
    await expect(launcher.launch()).resolves.toBe('server');
    expect(shown).toEqual([{ page: 'server', url: `${SELF}/` }]);
  });
});

describe('every way into a server checks it first', () => {
  const remote = { id: 'a', name: 'Work', url: SELF, kind: 'remote' };
  const file = { activeId: 'a', chosen: true, profiles: [remote] };

  /** Each server page loaded only after a check of that server. */
  function checkedFirst(env: ReturnType<typeof setup>) {
    const loads = env.servers();
    expect(loads.length).toBeGreaterThan(0);
    expect(env.verify.mock.calls.length).toBeGreaterThanOrEqual(loads.length);
  }

  it('launch, and activate with no window (which launches)', async () => {
    const env = setup({ file, routes: openBotsServer(SELF) });
    await env.launcher.launch();
    checkedFirst(env);
  });

  it('the account, a self-hosted server and This Mac from the welcome screen', async () => {
    const cloud = setup({ cloudUrl: CLOUD, routes: openBotsServer(CLOUD) });
    await cloud.launcher.connectCloud();
    checkedFirst(cloud);
    expect(cloud.shown).toEqual([{ page: 'server', url: `${CLOUD}/sign-in` }]);

    const self = setup({ routes: openBotsServer(SELF) });
    await self.launcher.connectServer(SELF);
    checkedFirst(self);

    // The stack answers as OpenBots, but another app holds the port it should own.
    const mac = setup({ routes: openBotsServer(LOCAL), status: portTaken });
    await mac.launcher.connectLocal();
    expect(mac.servers()).toEqual([]);
    expect(mac.verify).toHaveBeenCalled();
  });

  it("the start page's Open, Try again and saved connections", async () => {
    const env = setup({ file, routes: website(SELF) });
    await env.opener.open(await env.profiles.setActive('a'));
    expect(env.servers()).toEqual([]);
    expect(env.verify).toHaveBeenCalledTimes(1);
  });

  it('the tray, deep links and notification clicks', async () => {
    const env = setup({ file, routes: website(SELF) });
    const profile = await env.profiles.active();
    await env.opener.openPath(profile, '/bots/b1');
    expect(env.servers()).toEqual([]);
    expect(env.shown).toEqual([{ page: 'start', profile: 'a', error: NOT_OPENBOTS_SERVER }]);
  });

  it('a link into a web app that is already open goes there in place', async () => {
    const env = setup({ file, routes: openBotsServer(SELF) });
    const profile = await env.profiles.active();
    await env.opener.openPath(profile, '/bots/b1');
    expect(env.shown).toEqual([{ page: 'server', url: `${SELF}/bots/b1` }]);
    await env.opener.openPath(profile, '/approvals');
    expect(env.shown.at(-1)).toEqual({ page: 'navigate', path: '/approvals' });
    expect(env.verify).toHaveBeenCalledTimes(1);
  });
});
