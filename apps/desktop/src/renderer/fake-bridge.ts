import { vi, type Mock } from 'vitest';
import type { ProfilesView } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import type { StackPhase, StackProgress, StackStatus } from '../stack/manager.js';

// A window.openbots for the app pages' tests: every call a mock, the stack
// reporting the phases a start goes through.

/** The bridge with each call a vitest mock of itself. */
export type FakeBridge = Fake<AppBridge>;
type Fake<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : Fake<T[K]>;
};

export const ready = {
  state: 'ready' as const,
  cli: 'docker',
  runtime: 'orbstack' as const,
  serverVersion: '27',
  composeVersion: '2.30',
};

export const port = { port: 3000, taken: false, free: null };

export const running: StackStatus = {
  docker: ready,
  services: [{ service: 'openbots', state: 'running', health: 'healthy' }],
  upgrade: null,
  port,
};

export const local = {
  id: 'local',
  name: 'This Mac',
  url: 'http://localhost:3000',
  kind: 'local' as const,
};
export const work = {
  id: 'w',
  name: 'Work',
  url: 'https://w.example.com',
  kind: 'remote' as const,
};

export function fakeBridge(
  options: {
    status?: StackStatus;
    phases?: StackPhase[];
    profiles?: ProfilesView;
    cloudUrl?: string | null;
    chosen?: boolean;
  } = {},
): FakeBridge {
  let progress: ((phase: StackPhase, progress?: StackProgress) => void) | undefined;
  const status = options.status ?? running;
  const run = async () => {
    for (const phase of options.phases ?? ['starting']) progress?.(phase);
    return running;
  };
  const profiles = options.profiles ?? {
    activeId: 'local',
    chosen: false,
    profiles: [local],
  };
  const bridge = {
    platform: { kind: 'desktop', os: 'darwin', version: '1.0.0', nativeNotifications: true },
    onNavigate: vi.fn(() => () => undefined),
    onNew: vi.fn(() => () => undefined),
    connection: {
      info: vi.fn(),
      change: vi.fn(async () => undefined),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      showLogs: vi.fn(async () => undefined),
    },
    connect: {
      options: vi.fn(async () => ({
        cloudUrl: options.cloudUrl ?? null,
        chosen: options.chosen ?? false,
      })),
      cloud: vi.fn(async () => undefined),
      check: vi.fn(),
      server: vi.fn(async (_url: string) => undefined),
      local: vi.fn(async () => undefined),
    },
    profiles: {
      list: vi.fn(async () => profiles),
      add: vi.fn(),
      remove: vi.fn(async () => profiles),
      open: vi.fn(async (_id: string) => undefined),
    },
    stack: {
      status: vi.fn(async () => status),
      start: vi.fn(run),
      stop: vi.fn(async () => status),
      upgrade: vi.fn(run),
      changePort: vi.fn(async () => ({ ...status, port })),
      useOwnNetwork: vi.fn(async () => status),
      startRuntime: vi.fn(async () => undefined),
      onProgress: vi.fn((listener: (phase: StackPhase, progress?: StackProgress) => void) => {
        progress = listener;
        return () => void (progress = undefined);
      }),
      tailLogs: vi.fn(
        async (
          _options: { tail?: number },
          onLine: (line: string) => void,
          _onExit?: (code: number | null) => void,
        ) => {
          onLine('openbots-1 | listening');
          onLine('postgres-1 | ready');
          return () => undefined;
        },
      ),
    },
    quickAsk: {
      bots: vi.fn(async () => [{ id: 'a', name: 'Ada' }]),
      send: vi.fn(async (botId: string) => ({ botId, seq: 1 })),
      close: vi.fn(),
    },
    pair: {
      relay: vi.fn(async () => ({
        local: true,
        sharedUrl: 'wss://relay.example',
        current: 'wss://relay.example',
      })),
      setRelay: vi.fn(async (url: string) => ({
        local: true,
        sharedUrl: 'wss://relay.example',
        current: url,
      })),
      code: vi.fn(async () => ({ link: 'openbots://pair#v=1', expiresAt: '', skewMs: 0 })),
      relayStatus: vi.fn(async () => ({ status: 'linked', error: null })),
      onPaired: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
  };
  return bridge as unknown as FakeBridge;
}
