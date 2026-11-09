import { describe, expect, it, vi } from 'vitest';
import type { ProfilesView } from '../ipc.js';
import { NETWORK_CLASH } from '../stack/error-parts.js';
import type { StackPhase, StackStatus } from '../stack/manager.js';
import {
  addressWarning,
  CLOUD_UNAVAILABLE,
  cloudChoice,
  PHASE_TEXT,
  progressText,
  runLocalSetup,
  savedConnections,
  type LocalSetupView,
} from './welcome.js';

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

/** The bridge's stack and connect calls, with steps the fake stack reports as it goes. */
function fakeBridge(status: StackStatus, phases: StackPhase[] = ['pulling', 'starting']) {
  let progress: ((phase: StackPhase) => void) | undefined;
  const run = async () => {
    for (const phase of phases) progress?.(phase);
    return running;
  };
  const bridge = {
    stack: {
      status: vi.fn(async () => status),
      start: vi.fn(run),
      upgrade: vi.fn(run),
      changePort: vi.fn(async () => ({
        ...status,
        port: { port: 3001, taken: false, free: null },
      })),
      stop: vi.fn(async () => status),
      useOwnNetwork: vi.fn(async () => status),
      startRuntime: vi.fn(async () => undefined),
      tailLogs: vi.fn(async () => () => undefined),
      onProgress: vi.fn((listener: (phase: StackPhase) => void) => {
        progress = listener;
        return () => void (progress = undefined);
      }),
    },
    connect: {
      options: vi.fn(async () => ({ cloudUrl: null, chosen: false })),
      cloud: vi.fn(async () => undefined),
      check: vi.fn(async (url: string) => ({ url, setupRequired: true, warning: null })),
      server: vi.fn(async () => undefined),
      local: vi.fn(async () => undefined),
      pair: vi.fn(async () => undefined),
    },
  };
  return { bridge, listening: () => progress != null };
}

function fakeView() {
  const lines: string[] = [];
  const view: LocalSetupView = {
    progress: (text) => void lines.push(text),
    dockerMissing: vi.fn(),
    dockerStopped: vi.fn(),
    portTaken: vi.fn(),
    networkClash: vi.fn(),
    failed: vi.fn(),
  };
  return { view, lines };
}

describe('the welcome screen', () => {
  it('disables the account choice until the build names a hosted server', () => {
    expect(cloudChoice({ cloudUrl: null, chosen: false })).toEqual({
      enabled: false,
      note: 'OpenBots accounts are not available yet.',
    });
    expect(CLOUD_UNAVAILABLE).not.toMatch(/[–—]/);
    expect(cloudChoice({ cloudUrl: 'https://app.openbots.example', chosen: false })).toEqual({
      enabled: true,
      note: null,
    });
  });

  it('warns under the address field about plain http only', () => {
    expect(addressWarning('192.168.1.4:3000')).toMatch(/not encrypted/);
    expect(addressWarning('http://localhost:3000')).toMatch(/not encrypted/);
    expect(addressWarning('openbots.example.com')).toBeNull();
    // Half typed, or wrong: the error comes on Connect.
    expect(addressWarning('http://openbots.example.com')).toBeNull();
    expect(addressWarning('')).toBeNull();
  });

  it('lists saved servers, and This Mac only while it is the connection', () => {
    const view: ProfilesView = {
      activeId: 'a',
      chosen: true,
      profiles: [
        { id: 'local', name: 'This Mac', url: 'http://localhost:3000', kind: 'local' },
        { id: 'a', name: 'Work', url: 'https://w.example.com', kind: 'remote' },
      ],
    };
    expect(savedConnections(view).map((p) => p.id)).toEqual(['a']);
    expect(savedConnections({ ...view, activeId: 'local' }).map((p) => p.id)).toEqual([
      'local',
      'a',
    ]);
  });
});

describe('Run OpenBots on this Mac', () => {
  it('says how to install Docker when neither runtime is there, and starts nothing', async () => {
    const { bridge } = fakeBridge({
      docker: { state: 'missing', installed: [] },
      services: [],
      upgrade: null,
      port: null,
    });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('missing');
    expect(view.dockerMissing).toHaveBeenCalled();
    expect(bridge.stack.start).not.toHaveBeenCalled();
    expect(bridge.stack.upgrade).not.toHaveBeenCalled();
    expect(bridge.connect.local).not.toHaveBeenCalled();
  });

  it('offers to open Docker when it is installed but not running', async () => {
    const { bridge } = fakeBridge({
      docker: {
        state: 'stopped',
        cli: 'docker',
        installed: ['orbstack', 'docker-desktop'],
        error: '',
      },
      services: [],
      upgrade: null,
      port: null,
    });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('stopped');
    expect(view.dockerStopped).toHaveBeenCalledWith(
      'Docker is not running. Open OrbStack or Docker Desktop, then check again.',
    );
  });

  it('starts on first setup, downloading as its own step, then waits and opens the server', async () => {
    const { bridge, listening } = fakeBridge({
      docker: ready,
      services: [],
      upgrade: null,
      port: null,
    });
    const { view, lines } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('opened');
    // A start pulls only what this Mac lacks; an update would always pull.
    expect(bridge.stack.start).toHaveBeenCalled();
    expect(bridge.stack.upgrade).not.toHaveBeenCalled();
    expect(bridge.connect.local).toHaveBeenCalled();
    expect(lines).toEqual([
      PHASE_TEXT.checking,
      PHASE_TEXT.pulling,
      PHASE_TEXT.starting,
      PHASE_TEXT.waiting,
    ]);
    expect(listening()).toBe(false);
  });

  it('starts a stack that has services without pulling', async () => {
    const { bridge } = fakeBridge(
      {
        docker: ready,
        services: [{ service: 'openbots', state: 'exited', health: '' }],
        upgrade: null,
        port: null,
      },
      ['starting'],
    );
    const { view, lines } = fakeView();
    await runLocalSetup(bridge, view);
    expect(bridge.stack.start).toHaveBeenCalled();
    expect(bridge.stack.upgrade).not.toHaveBeenCalled();
    expect(lines).not.toContain(PHASE_TEXT.pulling);
  });

  it('shows why a start failed, and stops listening', async () => {
    const { bridge, listening } = fakeBridge({
      docker: ready,
      services: [],
      upgrade: null,
      port: null,
    });
    bridge.stack.start.mockRejectedValueOnce(new Error('The OpenBots stack did not start.'));
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('failed');
    expect(view.failed).toHaveBeenCalledWith('The OpenBots stack did not start.', null);
    expect(bridge.connect.local).not.toHaveBeenCalled();
    expect(listening()).toBe(false);
  });

  it('says plainly that the images are not published, with the pull output behind details', async () => {
    const { bridge } = fakeBridge({ docker: ready, services: [], upgrade: null, port: null });
    bridge.stack.start.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'openbots:stack:start': Error: The OpenBots images for this version are not published yet, or are not public. Connect to a self-hosted server instead, or build the images from source.\n openbots Error error from registry: denied\n",
      ),
    );
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('failed');
    expect(view.failed).toHaveBeenCalledWith(
      expect.stringMatching(/^The OpenBots images for this version are not published yet/),
      'openbots Error error from registry: denied',
    );
    // The choice is saved only once the server opens: the welcome screen stays usable.
    expect(bridge.connect.local).not.toHaveBeenCalled();
  });

  it('stops before starting when another app took the stack port, and offers a free one', async () => {
    const { bridge } = fakeBridge({
      docker: ready,
      services: [],
      upgrade: null,
      port: { port: 3000, taken: true, free: 3001 },
    });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('port-taken');
    expect(view.portTaken).toHaveBeenCalledWith(
      'Port 3000 is in use by another app. OpenBots can use port 3001 instead.',
      3001,
    );
    expect(bridge.stack.start).not.toHaveBeenCalled();
    expect(bridge.connect.local).not.toHaveBeenCalled();
  });

  it('moves to the free port when asked, then starts there', async () => {
    const { bridge } = fakeBridge({
      docker: ready,
      services: [],
      upgrade: null,
      port: { port: 3000, taken: true, free: 3001 },
    });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view, { movePort: true })).resolves.toBe('opened');
    expect(bridge.stack.changePort).toHaveBeenCalled();
    expect(bridge.stack.start).toHaveBeenCalled();
    expect(view.portTaken).not.toHaveBeenCalled();
  });

  it('offers a separate network when another OpenBots stack holds the sandbox network', async () => {
    const { bridge } = fakeBridge({ docker: ready, services: [], upgrade: null, port: null });
    bridge.stack.start.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'openbots:stack:start': Error: ${NETWORK_CLASH}\nfailed to set up container networking: Address already in use`,
      ),
    );
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('network-clash');
    expect(view.networkClash).toHaveBeenCalledWith(
      NETWORK_CLASH,
      'failed to set up container networking: Address already in use',
    );
    expect(view.failed).not.toHaveBeenCalled();
    expect(bridge.connect.local).not.toHaveBeenCalled();
  });

  it('stops its own stack and moves it to a network of its own when asked, then starts', async () => {
    const { bridge } = fakeBridge({ docker: ready, services: [], upgrade: null, port: null });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view, { ownNetwork: true })).resolves.toBe('opened');
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    expect(order(bridge.stack.stop)).toBeLessThan(order(bridge.stack.useOwnNetwork));
    expect(order(bridge.stack.useOwnNetwork)).toBeLessThan(order(bridge.stack.start));
    expect(bridge.connect.local).toHaveBeenCalled();
  });

  it('says to update Docker without Compose v2', async () => {
    const { bridge } = fakeBridge({
      docker: { state: 'no-compose', cli: 'docker', runtime: 'other', serverVersion: '20' },
      services: [],
      upgrade: null,
      port: null,
    });
    const { view } = fakeView();
    await expect(runLocalSetup(bridge, view)).resolves.toBe('failed');
    expect(view.failed).toHaveBeenCalledWith(expect.stringMatching(/Compose v2/), null);
  });
});

describe('the setup copy', () => {
  it('keeps the copy free of dashes used as pauses', () => {
    for (const text of Object.values(PHASE_TEXT)) expect(text).not.toMatch(/[–—]/);
  });

  it('names the image and how far its download is while it comes from the GitHub Release', () => {
    const base = { source: 'release', index: 2, count: 3 } as const;
    expect(progressText('pulling')).toBe(PHASE_TEXT.pulling);
    expect(
      progressText('pulling', { ...base, image: 'computer', step: 'downloading', percent: 7 }),
    ).toBe('Downloading OpenBots: the computer image (2 of 3), 7%');
    expect(
      progressText('pulling', {
        ...base,
        count: 1,
        index: 1,
        image: 'sandbox-firewall',
        step: 'downloading',
        percent: null,
      }),
    ).toBe('Downloading OpenBots: the sandbox firewall image');
    const loading = progressText('pulling', {
      ...base,
      image: 'server',
      step: 'loading',
      percent: null,
    });
    expect(loading).toBe('Downloading OpenBots: installing the server image (2 of 3)…');
    expect(loading).not.toMatch(/[–—]| - /);
  });
});
