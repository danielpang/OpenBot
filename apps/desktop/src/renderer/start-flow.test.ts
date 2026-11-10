import { describe, expect, it } from 'vitest';
import { NETWORK_CLASH } from '../stack/error-parts.js';
import { fakeBridge, local, port, ready, running, work } from './fake-bridge.js';
import {
  createStartFlow,
  MAX_LOG_LINES,
  OPENING_DOCKER,
  phaseOf,
  stackButtons,
  stackHealth,
  STARTING,
} from './start-flow.js';
import { stackView } from './stack-view.js';
import { PHASE_TEXT } from './welcome.js';

const welcomeQuery = new URLSearchParams('welcome=1');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the welcome screen flow', () => {
  it('offers the three choices on first launch, without saved connections', async () => {
    const flow = createStartFlow(fakeBridge(), welcomeQuery);
    await flow.start();
    const { welcome, saved, mode } = flow.store.get();
    expect(mode).toBe('welcome');
    expect(welcome.changing).toBe(false);
    expect(welcome.cloud).toEqual({
      enabled: false,
      note: 'OpenBots accounts are not available yet.',
    });
    expect(saved.visible).toBe(false);
  });

  it('says "Change connection" and lists saved servers once one was chosen', async () => {
    const bridge = fakeBridge({
      chosen: true,
      cloudUrl: 'https://app.openbots.example',
      profiles: { activeId: 'w', chosen: true, profiles: [local, work] },
    });
    const flow = createStartFlow(bridge, welcomeQuery);
    await flow.start();
    const { welcome, saved } = flow.store.get();
    expect(welcome.changing).toBe(true);
    expect(welcome.cloud.enabled).toBe(true);
    expect(saved).toEqual({ visible: true, profiles: [work], currentId: 'w' });
  });

  it('warns about plain http as the address is typed, and shows a failed check by the field', async () => {
    const bridge = fakeBridge();
    bridge.connect.server.mockRejectedValueOnce(
      new Error("Error invoking remote method 'openbots:connect:server': Error: No server there."),
    );
    const flow = createStartFlow(bridge, welcomeQuery);
    flow.welcome.setAddress('192.168.1.4:3000');
    expect(flow.store.get().welcome.warning).toMatch(/not encrypted/);
    const connecting = flow.welcome.connectServer();
    expect(flow.store.get().welcome.checking).toBe(true);
    await connecting;
    expect(bridge.connect.server).toHaveBeenCalledWith('192.168.1.4:3000');
    expect(flow.store.get().welcome.checking).toBe(false);
    expect(flow.store.get().error).toEqual({
      message: 'No server there.',
      detail: null,
      place: 'server',
    });
  });

  it('pairs with the link pasted, or opened on this Mac, and shows a failure by the field', async () => {
    const bridge = fakeBridge();
    bridge.connect.pair.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'openbots:connect:pair': Error: The link was already used or has expired.",
      ),
    );
    const flow = createStartFlow(
      bridge,
      new URLSearchParams({ welcome: '1', pair: 'openbots://pair#v=1' }),
    );
    expect(flow.store.get().welcome.pairLink).toBe('openbots://pair#v=1');
    flow.welcome.setPairLink('  openbots://pair#v=1&x  ');
    const pairing = flow.welcome.connectPair();
    expect(flow.store.get().welcome.pairing).toBe(true);
    await pairing;
    expect(bridge.connect.pair).toHaveBeenCalledWith('openbots://pair#v=1&x');
    expect(flow.store.get().welcome.pairing).toBe(false);
    expect(flow.store.get().error).toEqual({
      message: 'The link was already used or has expired.',
      detail: null,
      place: 'pair',
    });
    // Only the welcome screen takes a link from the query.
    const status = createStartFlow(bridge, new URLSearchParams({ pair: 'openbots://pair#v=1' }));
    expect(status.store.get().welcome.pairLink).toBe('');
  });

  it('shows each step of setting up This Mac, then opens it', async () => {
    const bridge = fakeBridge({
      status: { ...running, services: [] },
      phases: ['pulling', 'starting'],
    });
    const flow = createStartFlow(bridge, welcomeQuery);
    const seen: (string | null)[] = [];
    flow.store.subscribe(() => {
      const { local: setup } = flow.store.get().welcome;
      if (setup.kind === 'progress') seen.push(setup.phase);
    });
    await flow.welcome.setUpLocal();
    expect(seen).toEqual(['checking', 'pulling', 'starting', 'waiting']);
    expect(bridge.stack.start).toHaveBeenCalled();
    expect(bridge.connect.local).toHaveBeenCalled();
  });

  it('shows a download from the GitHub Release in the download step, with its percentage', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] }, phases: [] });
    bridge.stack.start.mockImplementationOnce(async () => {
      const listener = bridge.stack.onProgress.mock.calls[0]![0];
      listener('pulling');
      listener('pulling', {
        source: 'release',
        image: 'server',
        index: 1,
        count: 2,
        step: 'downloading',
        percent: 42,
      });
      listener('starting');
      return running;
    });
    const flow = createStartFlow(bridge, welcomeQuery);
    const seen: [string | null, string][] = [];
    flow.store.subscribe(() => {
      const { local: setup } = flow.store.get().welcome;
      if (setup.kind === 'progress') seen.push([setup.phase, setup.text]);
    });
    await flow.welcome.setUpLocal();
    expect(seen).toContainEqual([
      'pulling',
      'Downloading OpenBots: the server image (1 of 2), 42%',
    ]);
    expect(seen.map(([phase]) => phase)).not.toContain(null);
  });

  it('offers a free port when another app took the stack port, and moves to it', async () => {
    const bridge = fakeBridge({
      status: { ...running, services: [], port: { port: 3000, taken: true, free: 3001 } },
    });
    const flow = createStartFlow(bridge, welcomeQuery);
    await flow.welcome.setUpLocal();
    expect(flow.store.get().welcome.local).toMatchObject({ kind: 'port-taken', free: 3001 });
    await flow.welcome.usePort();
    expect(bridge.stack.changePort).toHaveBeenCalled();
  });

  it('offers a separate network when another stack holds the sandbox network, and moves to it', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(
      new Error(`${NETWORK_CLASH}\nfailed to set up container networking: Address already in use`),
    );
    const flow = createStartFlow(bridge, welcomeQuery);
    await flow.welcome.setUpLocal();
    expect(flow.store.get().welcome.local).toEqual({
      kind: 'network-clash',
      text: NETWORK_CLASH,
      detail: 'failed to set up container networking: Address already in use',
    });
    await flow.welcome.useOwnNetwork();
    expect(bridge.stack.stop).toHaveBeenCalled();
    expect(bridge.stack.useOwnNetwork).toHaveBeenCalled();
    expect(bridge.stack.start).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed pull output for "Show details"', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(
      new Error('Pulling the OpenBots images failed.\nmanifest unknown'),
    );
    const flow = createStartFlow(bridge, welcomeQuery);
    await flow.welcome.setUpLocal();
    expect(flow.store.get().welcome.local).toEqual({
      kind: 'failed',
      message: 'Pulling the OpenBots images failed.',
      detail: 'manifest unknown',
    });
  });

  it('asks to check again once Docker is opening', async () => {
    const bridge = fakeBridge({
      status: {
        docker: { state: 'stopped', cli: 'docker', installed: ['orbstack'], error: '' },
        services: [],
        upgrade: null,
        port: null,
      },
    });
    const flow = createStartFlow(bridge, welcomeQuery);
    await flow.welcome.setUpLocal();
    expect(flow.store.get().welcome.local).toMatchObject({ kind: 'docker-stopped' });
    await flow.welcome.openRuntime();
    expect(flow.store.get().welcome.local).toEqual({
      kind: 'docker-stopped',
      text: OPENING_DOCKER,
    });
  });
});

describe('the status page flow', () => {
  it('says why the server did not open and reads This Mac stack', async () => {
    const bridge = fakeBridge({ profiles: { activeId: 'local', chosen: true, profiles: [local] } });
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local&error=refused'));
    await flow.start();
    const { status, error } = flow.store.get();
    expect(error).toEqual({
      message: 'Could not open the server: refused',
      detail: null,
      place: 'page',
    });
    expect(status.reason).toBe('refused');
    expect(status.profile).toEqual(local);
    expect(status.stack?.view.running).toBe(true);
    await flow.status.retry();
    expect(bridge.profiles.open).toHaveBeenCalledWith('local');
  });

  it('never asks Docker for a self-hosted server', async () => {
    const bridge = fakeBridge({ profiles: { activeId: 'w', chosen: true, profiles: [work] } });
    const flow = createStartFlow(bridge, new URLSearchParams('profile=w'));
    await flow.start();
    expect(flow.store.get().status.stack).toBeNull();
    expect(bridge.stack.status).not.toHaveBeenCalled();
  });

  it('shows what the stack is doing while it starts, then its status again', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local'));
    await flow.start();
    const starting = flow.status.start();
    expect(flow.store.get().status.busy).toBe(STARTING);
    await starting;
    expect(flow.store.get().status.busy).toBeNull();
    expect(bridge.profiles.open).toHaveBeenCalledWith('local');
  });

  it('starts a stopped stack itself after a failed load, and updates when asked to', async () => {
    const stopped = fakeBridge({ status: { ...running, services: [] } });
    await createStartFlow(
      stopped,
      new URLSearchParams('profile=local&error=x&autostart=1'),
    ).start();
    expect(stopped.stack.start).toHaveBeenCalled();

    const old = fakeBridge({ status: { ...running, upgrade: { from: '1.0.0', to: '1.1.0' } } });
    await createStartFlow(old, new URLSearchParams('profile=local&upgrade=1')).start();
    expect(old.stack.upgrade).toHaveBeenCalled();
  });

  it('moves the stack to a free port, then starts it there', async () => {
    const bridge = fakeBridge({
      status: { ...running, services: [], port: { port: 3000, taken: true, free: 3001 } },
    });
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local'));
    await flow.start();
    expect(flow.store.get().status.stack?.view.freePort).toBe(3001);
    await flow.status.usePort();
    expect(bridge.stack.changePort).toHaveBeenCalled();
    expect(bridge.stack.start).toHaveBeenCalled();
  });

  it('marks a network clash on the status page, and moves the stack to its own network', async () => {
    const bridge = fakeBridge({ status: { ...running, services: [] } });
    bridge.stack.start.mockRejectedValueOnce(new Error(`${NETWORK_CLASH}\nAddress already in use`));
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local'));
    await flow.start();
    await flow.status.start();
    expect(flow.store.get().error).toMatchObject({
      message: NETWORK_CLASH,
      place: 'stack',
      kind: 'network-clash',
    });
    await flow.status.useOwnNetwork();
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder.at(-1)!;
    expect(order(bridge.stack.stop)).toBeLessThan(order(bridge.stack.useOwnNetwork));
    expect(order(bridge.stack.useOwnNetwork)).toBeLessThan(order(bridge.stack.start));
    expect(bridge.profiles.open).toHaveBeenCalledWith('local');
  });

  it('keeps the output of a failed stack call for "Show details"', async () => {
    const bridge = fakeBridge();
    bridge.stack.stop.mockRejectedValueOnce(
      new Error('The OpenBots stack did not stop.\ncompose exited 1'),
    );
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local'));
    await flow.start();
    await flow.status.stop();
    expect(flow.store.get().error).toEqual({
      message: 'The OpenBots stack did not stop.',
      detail: 'compose exited 1',
      place: 'stack',
    });
  });

  it('follows the logs and stops following them', async () => {
    const bridge = fakeBridge();
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local&logs=1'));
    await flow.start();
    await flush();
    expect(flow.store.get().status.logs).toEqual({
      open: true,
      lines: ['openbots-1 | listening', 'postgres-1 | ready'],
    });
    await flow.status.toggleLogs();
    expect(flow.store.get().status.logs.open).toBe(false);
  });

  it('keeps only the last lines of a long log', async () => {
    const bridge = fakeBridge();
    bridge.stack.tailLogs.mockImplementationOnce(
      async (_options: { tail?: number }, onLine: (line: string) => void) => {
        for (let i = 0; i < MAX_LOG_LINES + 5; i++) onLine(`line ${i}`);
        return () => undefined;
      },
    );
    const flow = createStartFlow(bridge, new URLSearchParams('profile=local'));
    await flow.status.toggleLogs();
    const { lines } = flow.store.get().status.logs;
    expect(lines).toHaveLength(MAX_LOG_LINES);
    expect(lines.at(-1)).toBe(`line ${MAX_LOG_LINES + 4}`);
  });
});

describe('stack controls', () => {
  it('offers Start, Update, Use port and Stop as the stack allows, and nothing while busy', () => {
    const stopped = stackView({ ...running, services: [] });
    expect(stackButtons(stopped, false)).toMatchObject({ start: true, stop: false, open: false });
    const old = stackView({ ...running, upgrade: { from: '1', to: '2' } });
    expect(stackButtons(old, false)).toMatchObject({ start: false, update: true, open: true });
    const taken = stackView({
      ...running,
      services: [],
      port: { port: 3000, taken: true, free: 3001 },
    });
    expect(stackButtons(taken, false)).toMatchObject({ port: true, start: false });
    expect(Object.values(stackButtons(stopped, true)).every((shown) => !shown)).toBe(true);
  });

  it('names the stack health as the connection indicator does', () => {
    expect(stackHealth(stackView(running))).toBe('running');
    expect(stackHealth(stackView({ ...running, services: [] }))).toBe('stopped');
    const unhealthy = { service: 'openbots', state: 'running', health: 'unhealthy' };
    expect(
      stackHealth(stackView({ docker: ready, services: [unhealthy], upgrade: null, port })),
    ).toBe('unhealthy');
  });

  it('knows which step a progress line belongs to', () => {
    expect(phaseOf(PHASE_TEXT.pulling)).toBe('pulling');
    expect(phaseOf('Something else')).toBeNull();
  });
});
