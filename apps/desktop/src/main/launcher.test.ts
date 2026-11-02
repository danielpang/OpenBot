import { describe, expect, it, vi } from 'vitest';
import type { StackStatus } from '../stack/manager.js';
import { fakeFetch, openBotsServer, type Answer } from './fake-fetch.js';
import {
  connectionHeader,
  createLauncher,
  describeConnection,
  type LauncherWindow,
} from './launcher.js';
import { createProfileStore, type ProfileFiles } from './profiles.js';

const PATH = '/user-data/profiles.json';
const LOCAL = 'http://localhost:3000';
const CLOUD = 'https://app.openbots.example';
const SELF = 'https://openbots.example.com';

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
  port: null,
};

function setup(
  options: {
    file?: object;
    cloudUrl?: string | null;
    routes?: Record<string, Answer | Answer[]>;
    hasLocalStack?: boolean;
    status?: StackStatus;
    /** Whether the window's open passes the server check (./opener.ts). */
    opens?: boolean;
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
  let n = 0;
  const profiles = createProfileStore({
    files,
    path: PATH,
    localUrl: async () => LOCAL,
    cloudUrl: options.cloudUrl ?? null,
    hasLocalStack: async () => options.hasLocalStack ?? false,
    newId: () => `p${++n}`,
  });
  // Every stack call is a spy, so a test can say a thin client never made one.
  const stack = {
    status: vi.fn(async () => options.status ?? running),
    start: vi.fn(async () => running),
    stop: vi.fn(async () => ({ ...running, services: [] })),
    refresh: vi.fn(async () => false),
    pendingUpgrade: vi.fn(async () => null as { from: string; to: string } | null),
  };
  const window = {
    openServer: vi.fn<LauncherWindow['openServer']>(async () => options.opens ?? true),
    showStart: vi.fn<LauncherWindow['showStart']>(async () => undefined),
    showWelcome: vi.fn<LauncherWindow['showWelcome']>(async () => undefined),
  };
  const fetch = fakeFetch(options.routes ?? {});
  const launcher = createLauncher({
    profiles,
    stack,
    fetch,
    cloudUrl: options.cloudUrl ?? null,
    window,
    wait: { sleep: async () => undefined, timeoutMs: 0 },
  });
  const stored = () => JSON.parse(data.get(PATH) ?? 'null') as unknown;
  const stackCalls = () => Object.values(stack).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
  return { launcher, profiles, stack, window, fetch, stored, stackCalls };
}

describe('first launch', () => {
  it('shows the three choices until one is made, without asking Docker', async () => {
    const { launcher, window, stackCalls } = setup();
    await expect(launcher.launch()).resolves.toBe('welcome');
    expect(window.showWelcome).toHaveBeenCalled();
    expect(window.openServer).not.toHaveBeenCalled();
    expect(stackCalls()).toBe(0);
    await expect(launcher.options()).resolves.toEqual({ cloudUrl: null, chosen: false });
  });

  it('keeps showing them after a failed setup on this Mac left its stack .env', async () => {
    const { launcher, stored } = setup();
    await launcher.launch();
    expect(stored()).toEqual({ activeId: 'local', chosen: false, profiles: [] });
    // The next launch, with the .env there, is not an install from before the choice.
    const later = setup({ file: stored() as object, hasLocalStack: true });
    await expect(later.launcher.launch()).resolves.toBe('welcome');
    expect((await later.profiles.list()).chosen).toBe(false);
  });

  it('skips the choices for an install that already has an active profile', async () => {
    const { launcher, window } = setup({ file: { activeId: 'local', profiles: [] } });
    await expect(launcher.launch()).resolves.toBe('server');
    expect(window.showWelcome).not.toHaveBeenCalled();
    expect(window.openServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }));
  });

  it('skips them for an install that set up the local stack before the choice existed', async () => {
    const { launcher, window } = setup({ hasLocalStack: true });
    await expect(launcher.launch()).resolves.toBe('server');
    expect(window.openServer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'local' }));
  });
});

describe('Sign in to an OpenBots account', () => {
  it('is unavailable when the build names no hosted server', async () => {
    const { launcher, window, stored } = setup();
    await expect(launcher.connectCloud()).rejects.toThrow(
      'OpenBots accounts are not available yet.',
    );
    expect(window.openServer).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it("opens the hosted server's sign-in and remembers the choice", async () => {
    const { launcher, window, stored, stackCalls } = setup({ cloudUrl: CLOUD });
    await expect(launcher.options()).resolves.toEqual({ cloudUrl: CLOUD, chosen: false });
    await launcher.connectCloud();
    expect(window.openServer).toHaveBeenCalledWith(
      { id: 'cloud', name: 'OpenBots account', url: CLOUD, kind: 'cloud' },
      '/sign-in',
    );
    expect(stored()).toEqual({ activeId: 'cloud', chosen: true, profiles: [] });
    expect(stackCalls()).toBe(0);
  });
});

describe('Connect to a self-hosted server', () => {
  it('checks the server, saves it and opens its setup wizard when it has no user', async () => {
    const { launcher, window, stored, stackCalls } = setup({
      routes: openBotsServer(SELF, true),
    });
    await launcher.connectServer('openbots.example.com');
    const profile = { id: 'p1', name: 'openbots.example.com', url: SELF, kind: 'remote' };
    expect(window.openServer).toHaveBeenCalledWith(profile, '/setup');
    expect(stored()).toEqual({ activeId: 'p1', chosen: true, profiles: [profile] });
    expect(stackCalls()).toBe(0);
  });

  it('opens sign-in on a server that is set up', async () => {
    const { launcher, window } = setup({ routes: openBotsServer(SELF) });
    await launcher.connectServer(SELF);
    expect(window.openServer).toHaveBeenCalledWith(
      expect.objectContaining({ url: SELF }),
      '/sign-in',
    );
  });

  it('warns about plain http on a private network', async () => {
    const lan = 'http://192.168.1.4:3000';
    const { launcher } = setup({ routes: openBotsServer(lan) });
    await expect(launcher.checkServer('192.168.1.4:3000')).resolves.toEqual({
      url: lan,
      setupRequired: false,
      warning: 'This connection is not encrypted. Use http only on a network you trust.',
    });
  });

  it('saves nothing when the address is not an OpenBots server', async () => {
    const { launcher, window, stored } = setup({
      routes: { [`${SELF}/healthz`]: { status: 200 } },
    });
    await expect(launcher.connectServer(SELF)).rejects.toThrow(
      'openbots.example.com answered, but it is not an OpenBots server. Check the address.',
    );
    await expect(launcher.connectServer('http://openbots.example.com')).rejects.toThrow(
      /Use https/,
    );
    await expect(launcher.connectServer('https://down.example.com')).rejects.toThrow(
      /Could not reach down.example.com/,
    );
    expect(window.openServer).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });
});

describe('Run OpenBots on this Mac', () => {
  it('waits for /readyz, then opens the web app, which the app signs the owner in to', async () => {
    const { launcher, window, stored, fetch } = setup({
      routes: {
        ...openBotsServer(LOCAL, true),
        [`${LOCAL}/readyz`]: ['down', { status: 200, body: { status: 'ready' } }],
      },
    });
    // The page started the stack; a timeout of 0 still polls until the first answer.
    await expect(launcher.connectLocal()).rejects.toThrow(/not ready yet/);
    // A failed attempt saves no choice: the welcome screen still offers all three.
    expect(stored()).toBeNull();
    expect(window.openServer).not.toHaveBeenCalled();
    await launcher.connectLocal();
    expect(fetch.mock.calls.map(([url]) => url)).toContain(`${LOCAL}/readyz`);
    // Never /sign-in or /setup's account step: the web app goes on to setup itself.
    expect(window.openServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }));
    expect(stored()).toMatchObject({ activeId: 'local', chosen: true });
  });

  it('leaves the start page showing when the server did not pass its check', async () => {
    const { launcher, stack, window } = setup({
      file: { activeId: 'local', profiles: [] },
      opens: false,
    });
    stack.pendingUpgrade.mockResolvedValueOnce({ from: '1.0.0', to: '1.1.0' });
    await expect(launcher.launch()).resolves.toBe('start');
    expect(window.showStart).not.toHaveBeenCalled();
  });

  it('brings a running local stack up to date before opening it, and only a local one', async () => {
    const local = setup({ file: { activeId: 'local', profiles: [] } });
    await local.launcher.launch();
    expect(local.stack.refresh).toHaveBeenCalledOnce();
    expect(local.stack.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      local.window.openServer.mock.invocationCallOrder[0]!,
    );
    // A failed refresh still opens the app.
    local.stack.refresh.mockRejectedValueOnce(new Error('docker went away'));
    await expect(local.launcher.launch()).resolves.toBe('server');
  });

  it('moves an older stack to the app release on launch', async () => {
    const { launcher, stack, window } = setup({ file: { activeId: 'local', profiles: [] } });
    stack.pendingUpgrade.mockResolvedValueOnce({ from: '1.0.0', to: '1.1.0' });
    await expect(launcher.launch()).resolves.toBe('upgrade');
    expect(window.showStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'local' }), {
      upgrade: true,
    });
  });
});

describe('later launches', () => {
  const remote = { id: 'a', name: 'Work', url: SELF, kind: 'remote' };

  it('open the chosen connection directly', async () => {
    const { launcher, window } = setup({
      file: { activeId: 'a', chosen: true, profiles: [remote] },
    });
    await expect(launcher.launch()).resolves.toBe('server');
    expect(window.openServer).toHaveBeenCalledWith(remote);
  });

  it('Change connection shows the choices and keeps every saved profile', async () => {
    const { launcher, profiles, window, stored } = setup({
      file: { activeId: 'a', chosen: true, profiles: [remote] },
    });
    const before = stored();
    await launcher.changeConnection();
    expect(window.showWelcome).toHaveBeenCalled();
    expect(stored()).toEqual(before);
    expect((await profiles.list()).profiles.map((p) => p.id)).toEqual(['local', 'a']);
    await expect(launcher.options()).resolves.toMatchObject({ chosen: true });
  });
});

describe('thin clients', () => {
  const remote = { id: 'a', name: 'Work', url: SELF, kind: 'remote' };

  for (const [kind, file, cloudUrl] of [
    ['a self-hosted server', { activeId: 'a', chosen: true, profiles: [remote] }, null],
    ['an OpenBots account', { activeId: 'cloud', chosen: true, profiles: [] }, CLOUD],
  ] as const) {
    it(`never call the stack manager for ${kind}`, async () => {
      const { launcher, stackCalls, window } = setup({ file, cloudUrl });
      await launcher.launch();
      const info = await launcher.info();
      expect(info.stack).toBeUndefined();
      await expect(launcher.startLocal()).rejects.toThrow(/Only a connection to This Mac/);
      await expect(launcher.stopLocal()).rejects.toThrow(/Only a connection to This Mac/);
      await expect(launcher.showLocalLogs()).rejects.toThrow(/Only a connection to This Mac/);
      await launcher.changeConnection();
      expect(window.showStart).not.toHaveBeenCalled();
      expect(stackCalls()).toBe(0);
    });
  }
});

describe('connection info', () => {
  it('describes each kind with its host', async () => {
    const { launcher } = setup({
      file: { activeId: 'cloud', chosen: true, profiles: [] },
      cloudUrl: CLOUD,
    });
    await expect(launcher.info()).resolves.toEqual({
      kind: 'cloud',
      label: 'OpenBots account',
      host: 'app.openbots.example',
      url: CLOUD,
    });
    expect(
      describeConnection({
        id: 'a',
        name: 'Work',
        url: 'https://w.example.com:8443',
        kind: 'remote',
      }),
    ).toMatchObject({ label: 'Self-hosted', host: 'w.example.com:8443' });
    expect(connectionHeader({ id: 'local', name: 'This Mac', url: LOCAL, kind: 'local' })).toBe(
      'This Mac (localhost:3000)',
    );
  });

  it("adds the local stack's state for This Mac", async () => {
    const file = { activeId: 'local', chosen: true, profiles: [] };
    expect((await setup({ file }).launcher.info()).stack).toEqual({
      state: 'running',
      text: 'Running on OrbStack.',
    });
    const stopped = setup({
      file,
      status: { docker: ready, services: [], upgrade: null, port: null },
    });
    expect((await stopped.launcher.info()).stack).toMatchObject({ state: 'stopped' });
    const unhealthy = setup({
      file,
      status: {
        docker: ready,
        services: [
          { service: 'openbots', state: 'running', health: 'unhealthy' },
          { service: 'redis', state: 'exited', health: '' },
        ],
        upgrade: null,
        port: null,
      },
    });
    expect((await unhealthy.launcher.info()).stack).toMatchObject({ state: 'unhealthy' });
    const noDocker = setup({
      file,
      status: {
        docker: { state: 'missing', installed: [] },
        services: [],
        upgrade: null,
        port: null,
      },
    });
    expect((await noDocker.launcher.info()).stack).toMatchObject({ state: 'stopped' });
  });

  it("starts, stops and shows the logs of This Mac's stack", async () => {
    const { launcher, stack, window } = setup({
      file: { activeId: 'local', chosen: true, profiles: [] },
    });
    await expect(launcher.startLocal()).resolves.toMatchObject({ stack: { state: 'running' } });
    expect(stack.start).toHaveBeenCalled();
    await launcher.stopLocal();
    expect(stack.stop).toHaveBeenCalled();
    expect(window.showStart).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'local' }));
    await launcher.showLocalLogs();
    expect(window.showStart).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'local' }), {
      logs: true,
    });
  });
});
