import { describe, expect, it, vi } from 'vitest';
import {
  createStackBridge,
  errorParts,
  parseProgress,
  registerStackIpc,
  STACK_CHANNELS,
  type IpcInvokeEvent,
  type IpcMainLike,
  type IpcRendererLike,
  type IpcSender,
} from './bridge.js';
import { isNetworkClash, NETWORK_CLASH } from './error-parts.js';
import { StackError, type StackManager, type StackProgress } from './manager.js';

type Handler = Parameters<IpcMainLike['handle']>[1];

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
  };
  const invoke = (channel: string, event: IpcInvokeEvent, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!(event, ...args));
  return { ipcMain, handlers, invoke };
}

function fakeSender() {
  let onDestroyed: (() => void) | undefined;
  const sender = {
    sent: [] as unknown[][],
    send: vi.fn((...args: unknown[]) => void sender.sent.push(args)),
    isDestroyed: () => false,
    once: (_event: 'destroyed', listener: () => void) => void (onDestroyed = listener),
    destroy: () => onDestroyed?.(),
  };
  return sender satisfies IpcSender;
}

function fakeManager(overrides: Partial<StackManager> = {}): StackManager {
  const status = {
    docker: { state: 'missing' as const, installed: [] },
    services: [],
    upgrade: null,
    port: null,
  };
  return {
    status: vi.fn(async () => status),
    start: vi.fn(async () => status),
    stop: vi.fn(async () => status),
    refresh: vi.fn(async () => false),
    upgrade: vi.fn(async () => status),
    changePort: vi.fn(async () => status),
    useOwnNetwork: vi.fn(async () => status),
    pendingUpgrade: vi.fn(async () => null),
    localToken: vi.fn(async () => 'never-sent'),
    startRuntime: vi.fn(async () => undefined),
    tailLogs: vi.fn(async () => ({ stop: vi.fn() })),
    ...overrides,
  };
}

describe('stack progress', () => {
  it('sends the steps of a start or update to the page that asked', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const manager = fakeManager({
      upgrade: vi.fn(async (onPhase) => {
        onPhase?.('pulling');
        onPhase?.('starting');
        return {
          docker: { state: 'missing' as const, installed: [] },
          services: [],
          upgrade: null,
          port: null,
        };
      }),
    });
    registerStackIpc(ipcMain, manager, () => true);
    const sender = fakeSender();
    await invoke(STACK_CHANNELS.upgrade, { sender });
    expect(sender.sent).toEqual([
      [STACK_CHANNELS.progress, 'pulling'],
      [STACK_CHANNELS.progress, 'starting'],
    ]);
  });

  it('passes only known steps to the listener until it unsubscribes', () => {
    const listeners = new Set<(event: unknown, ...args: unknown[]) => void>();
    const ipcRenderer: IpcRendererLike = {
      invoke: async () => undefined,
      on: (_channel, listener) => listeners.add(listener),
      removeListener: (_channel, listener) => listeners.delete(listener),
    };
    const seen: string[] = [];
    const off = createStackBridge(ipcRenderer).onProgress((phase) => seen.push(phase));
    for (const listener of listeners) {
      listener({}, 'pulling');
      listener({}, 'rm -rf');
      listener({}, 'starting');
    }
    off();
    expect(seen).toEqual(['pulling', 'starting']);
    expect(listeners.size).toBe(0);
  });
});

describe('release download progress', () => {
  const progress: StackProgress = {
    source: 'release',
    image: 'computer',
    index: 2,
    count: 3,
    step: 'downloading',
    percent: 42,
  };

  it('sends the GitHub Release download with its step', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const manager = fakeManager({
      start: vi.fn(async (onPhase) => {
        onPhase?.('pulling');
        onPhase?.('pulling', progress);
        return {
          docker: { state: 'missing' as const, installed: [] },
          services: [],
          upgrade: null,
          port: null,
        };
      }),
    });
    registerStackIpc(ipcMain, manager, () => true);
    const sender = fakeSender();
    await invoke(STACK_CHANNELS.start, { sender });
    expect(sender.sent).toEqual([
      [STACK_CHANNELS.progress, 'pulling'],
      [STACK_CHANNELS.progress, 'pulling', progress],
    ]);
  });

  it('hands the page a well formed progress, and drops anything else', () => {
    const listeners = new Set<(event: unknown, ...args: unknown[]) => void>();
    const ipcRenderer: IpcRendererLike = {
      invoke: async () => undefined,
      on: (_channel, listener) => listeners.add(listener),
      removeListener: (_channel, listener) => listeners.delete(listener),
    };
    const seen: unknown[][] = [];
    createStackBridge(ipcRenderer).onProgress((...args) => seen.push(args));
    for (const listener of listeners) {
      listener({}, 'pulling', progress);
      listener({}, 'pulling', { ...progress, percent: 101 });
      listener({}, 'pulling', { ...progress, image: '../etc' });
    }
    expect(seen).toEqual([['pulling', progress], ['pulling'], ['pulling']]);
    expect(parseProgress({ ...progress, step: 'loading', percent: null })).toEqual({
      ...progress,
      step: 'loading',
      percent: null,
    });
    expect(parseProgress('pulling')).toBeUndefined();
  });
});

describe('registerStackIpc', () => {
  it('registers every channel the bridge invokes', () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerStackIpc(ipcMain, fakeManager(), () => true);
    for (const channel of [
      STACK_CHANNELS.status,
      STACK_CHANNELS.start,
      STACK_CHANNELS.stop,
      STACK_CHANNELS.upgrade,
      STACK_CHANNELS.changePort,
      STACK_CHANNELS.useOwnNetwork,
      STACK_CHANNELS.startRuntime,
      STACK_CHANNELS.logsStart,
      STACK_CHANNELS.logsStop,
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('rejects untrusted senders before touching the manager', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const manager = fakeManager();
    registerStackIpc(ipcMain, manager, () => false);
    await expect(invoke(STACK_CHANNELS.start, { sender: fakeSender() })).rejects.toThrow(
      /may not manage/,
    );
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('carries the StackError detail across IPC', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const manager = fakeManager({
      start: async () => {
        throw new StackError('The OpenBots stack did not start.', 'port 3000 is already allocated');
      },
    });
    registerStackIpc(ipcMain, manager, () => true);
    await expect(invoke(STACK_CHANNELS.start, { sender: fakeSender() })).rejects.toThrow(
      'The OpenBots stack did not start.\nport 3000 is already allocated',
    );
  });

  it('only passes known runtimes through', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const manager = fakeManager();
    registerStackIpc(ipcMain, manager, () => true);
    await invoke(STACK_CHANNELS.startRuntime, { sender: fakeSender() }, 'orbstack');
    await invoke(STACK_CHANNELS.startRuntime, { sender: fakeSender() }, '; rm -rf /');
    expect(manager.startRuntime).toHaveBeenNthCalledWith(1, 'orbstack');
    expect(manager.startRuntime).toHaveBeenNthCalledWith(2, undefined);
  });

  it('streams log lines to the sender, clamps the tail and stops when the window closes', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const stop = vi.fn();
    let emit: (line: string) => void = () => undefined;
    const manager = fakeManager({
      tailLogs: vi.fn(async (_options, onLine) => {
        emit = onLine;
        return { stop };
      }),
    });
    registerStackIpc(ipcMain, manager, () => true);
    const sender = fakeSender();

    const id = await invoke(STACK_CHANNELS.logsStart, { sender }, 1e9);
    expect(manager.tailLogs).toHaveBeenCalledWith(
      { tail: 5000 },
      expect.any(Function),
      expect.any(Function),
    );
    emit('openbots-1 | ready');
    expect(sender.sent).toEqual([[STACK_CHANNELS.logsLine, id, 'openbots-1 | ready']]);

    sender.destroy();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops a tail by id', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    const stop = vi.fn();
    registerStackIpc(ipcMain, fakeManager({ tailLogs: async () => ({ stop }) }), () => true);
    const sender = fakeSender();
    const id = await invoke(STACK_CHANNELS.logsStart, { sender }, 10);
    await invoke(STACK_CHANNELS.logsStop, { sender }, id);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('createStackBridge', () => {
  function fakeIpcRenderer(onInvoke: (channel: string, ...args: unknown[]) => unknown) {
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const ipcRenderer: IpcRendererLike = {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => onInvoke(channel, ...args)),
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(listener);
      },
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    };
    const emit = (channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
    };
    return { ipcRenderer, emit, listeners };
  }

  it('invokes the stack channels', async () => {
    const { ipcRenderer } = fakeIpcRenderer(() => 'ok');
    const bridge = createStackBridge(ipcRenderer);
    await bridge.status();
    await bridge.start();
    await bridge.stop();
    await bridge.upgrade();
    await bridge.changePort();
    await bridge.useOwnNetwork();
    await bridge.startRuntime('docker-desktop');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.status);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.start);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.stop);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.upgrade);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.changePort);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.useOwnNetwork);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.startRuntime, 'docker-desktop');
  });

  it('delivers only its own tail lines, including ones sent before the id arrived', async () => {
    let emitEarly: () => void = () => undefined;
    const { ipcRenderer, emit, listeners } = fakeIpcRenderer((channel) => {
      if (channel === STACK_CHANNELS.logsStart) emitEarly();
      return channel === STACK_CHANNELS.logsStart ? 'tail-7' : undefined;
    });
    emitEarly = () => {
      emit(STACK_CHANNELS.logsLine, 'tail-7', 'early line');
      emit(STACK_CHANNELS.logsLine, 'tail-3', 'someone else');
    };
    const lines: string[] = [];
    const unsubscribe = await createStackBridge(ipcRenderer).tailLogs({ tail: 20 }, (l) =>
      lines.push(l),
    );
    emit(STACK_CHANNELS.logsLine, 'tail-7', 'later line');
    emit(STACK_CHANNELS.logsLine, 'tail-3', 'not mine');
    expect(lines).toEqual(['early line', 'later line']);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.logsStart, 20);

    unsubscribe();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(STACK_CHANNELS.logsStop, 'tail-7');
    expect(listeners.get(STACK_CHANNELS.logsLine)?.size).toBe(0);
  });

  it('reports the tail exiting and removes its listeners', async () => {
    const { ipcRenderer, emit, listeners } = fakeIpcRenderer(() => 'tail-1');
    const onExit = vi.fn();
    const unsubscribe = await createStackBridge(ipcRenderer).tailLogs({}, () => undefined, onExit);
    emit(STACK_CHANNELS.logsExit, 'tail-1', 0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(listeners.get(STACK_CHANNELS.logsExit)?.size).toBe(0);
    unsubscribe();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(STACK_CHANNELS.logsStop, 'tail-1');
  });
});

describe('errorParts', () => {
  it("drops Electron's prefix and splits the sentence from the output", () => {
    expect(
      errorParts(
        new Error(
          "Error invoking remote method 'openbots:stack:upgrade': Error: Pulling the OpenBots images failed.\nline 1\nline 2",
        ),
      ),
    ).toEqual({
      message: 'Pulling the OpenBots images failed.',
      detail: 'line 1\nline 2',
      kind: null,
    });
    expect(errorParts(new Error('Docker is not running.'))).toEqual({
      message: 'Docker is not running.',
      detail: null,
      kind: null,
    });
    expect(errorParts('plain')).toEqual({ message: 'plain', detail: null, kind: null });
  });

  it('marks a network clash, so the page can offer a separate network', () => {
    expect(
      errorParts(
        new Error(
          `Error invoking remote method 'openbots:stack:start': Error: ${NETWORK_CLASH}\nAddress already in use`,
        ),
      ),
    ).toEqual({ message: NETWORK_CLASH, detail: 'Address already in use', kind: 'network-clash' });
    // The output alone does not make a clash: the manager chose the sentence.
    expect(
      errorParts(new Error('The OpenBots stack did not start.\nAddress already in use')).kind,
    ).toBeNull();
  });

  it('says the clash plainly, with no dashes', () => {
    expect(NETWORK_CLASH).not.toMatch(/[\u2013\u2014]| - /);
  });
});

describe('isNetworkClash', () => {
  const ADDRESS =
    'Error response from daemon: failed to set up container networking: Address already in use';
  const WARNING =
    'level=warning msg="a network with name openbots-sbx exists but was not created for project \\"openbots-app\\". Set `external: true` to use an existing network"';

  it("tells the sandbox network's clashes", () => {
    expect(isNetworkClash(ADDRESS)).toBe(true);
    expect(isNetworkClash(WARNING)).toBe(true);
    expect(
      isNetworkClash(
        'failed to create network openbots-app-sandbox-254: Error response from daemon: invalid pool request: Pool overlaps with other one on this address space',
      ),
    ).toBe(true);
  });

  it('leaves the warning out when asked for the strong signs only', () => {
    expect(isNetworkClash(WARNING, { stronglyOnly: true })).toBe(false);
    expect(isNetworkClash(`${WARNING}\n${ADDRESS}`, { stronglyOnly: true })).toBe(true);
  });

  it("does not take the web port's bind failure for one", () => {
    for (const output of [
      'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint openbots-app-openbots-1 (abc): Bind for 0.0.0.0:3000 failed: port is already allocated',
      'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint openbots-app-openbots-1 (abc): listen tcp4 0.0.0.0:3000: bind: address already in use',
    ]) {
      expect(isNetworkClash(output)).toBe(false);
    }
  });
});
