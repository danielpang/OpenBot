import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_CHANNELS, type PlatformInfo } from '../ipc.js';
import { STACK_CHANNELS, type IpcRendererLike } from '../stack/bridge.js';
import { createAppBridge, createWebBridge, isAppPage } from './bridge.js';

type Listener = (event: unknown, ...args: unknown[]) => void;

function fakeIpcRenderer() {
  const listeners = new Map<string, Set<Listener>>();
  const ipcRenderer = {
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    on: vi.fn((channel: string, listener: Listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
  } satisfies IpcRendererLike;
  const emit = (channel: string, ...args: unknown[]) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
  };
  return { ipcRenderer, emit, listeners };
}

const platform: PlatformInfo = {
  kind: 'desktop',
  os: 'darwin',
  version: '1.2.3',
  nativeNotifications: true,
};

describe('the web bridge', () => {
  it('exposes the platform context, navigation, the menu’s New, the connection and OAuth, nothing else', () => {
    const bridge = createWebBridge(fakeIpcRenderer().ipcRenderer, platform);
    expect(Object.keys(bridge).sort()).toEqual([
      'connection',
      'oauth',
      'onNavigate',
      'onNew',
      'platform',
    ]);
    expect(Object.keys(bridge.oauth).sort()).toEqual(['finished', 'open']);
    expect(Object.keys(bridge.connection).sort()).toEqual([
      'change',
      'info',
      'showLogs',
      'start',
      'stop',
    ]);
    expect(bridge.platform).toEqual(platform);
  });

  it('asks the main process about the connection, with no arguments from the page', async () => {
    const { ipcRenderer } = fakeIpcRenderer();
    const bridge = createWebBridge(ipcRenderer, platform);
    await bridge.connection.info();
    await bridge.connection.change();
    await bridge.connection.start();
    await bridge.connection.stop();
    await bridge.connection.showLogs();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.connectionInfo],
      [DESKTOP_CHANNELS.connectionChange],
      [DESKTOP_CHANNELS.connectionStart],
      [DESKTOP_CHANNELS.connectionStop],
      [DESKTOP_CHANNELS.connectionLogs],
    ]);
  });

  it('sends the sign-in URL as a string, and nothing with finished', async () => {
    const { ipcRenderer } = fakeIpcRenderer();
    const bridge = createWebBridge(ipcRenderer, platform);
    await bridge.oauth.open('https://mcp.example.com/authorize');
    await bridge.oauth.open({ toString: () => 'https://x.example.com' } as never);
    await bridge.oauth.finished();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.oauthOpen, 'https://mcp.example.com/authorize'],
      [DESKTOP_CHANNELS.oauthOpen, 'https://x.example.com'],
      [DESKTOP_CHANNELS.oauthFinished],
    ]);
  });

  it('hands out a copy of the platform context', () => {
    const bridge = createWebBridge(fakeIpcRenderer().ipcRenderer, platform);
    bridge.platform.nativeNotifications = false;
    expect(platform.nativeNotifications).toBe(true);
  });

  it('calls the New listener, with nothing from the message, until it unsubscribes', () => {
    const { ipcRenderer, emit, listeners } = fakeIpcRenderer();
    const bridge = createWebBridge(ipcRenderer, platform);
    const calls: unknown[][] = [];
    const off = bridge.onNew((...args: unknown[]) => calls.push(args));
    emit(DESKTOP_CHANNELS.newItem, 'ignored');
    off();
    emit(DESKTOP_CHANNELS.newItem);
    expect(calls).toEqual([[]]);
    expect(listeners.get(DESKTOP_CHANNELS.newItem)?.size).toBe(0);
  });

  it('passes app paths to the listener until it unsubscribes', () => {
    const { ipcRenderer, emit, listeners } = fakeIpcRenderer();
    const bridge = createWebBridge(ipcRenderer, platform);
    const seen: string[] = [];
    const off = bridge.onNavigate((path) => seen.push(path));
    emit(DESKTOP_CHANNELS.navigate, '/bots/b1?seq=4');
    // Never anything that leaves the server's origin.
    emit(DESKTOP_CHANNELS.navigate, 'https://evil.example.com');
    emit(DESKTOP_CHANNELS.navigate, '//evil.example.com/x');
    emit(DESKTOP_CHANNELS.navigate, 42);
    off();
    emit(DESKTOP_CHANNELS.navigate, '/bots/b2');
    expect(seen).toEqual(['/bots/b1?seq=4']);
    expect(listeners.get(DESKTOP_CHANNELS.navigate)?.size).toBe(0);
  });
});

describe('the app bridge', () => {
  it('adds profiles, the ways to connect, the stack, quick ask and pairing to the web bridge', () => {
    const bridge = createAppBridge(fakeIpcRenderer().ipcRenderer, platform);
    expect(Object.keys(bridge).sort()).toEqual([
      'connect',
      'connection',
      'oauth',
      'onNavigate',
      'onNew',
      'pair',
      'platform',
      'profiles',
      'quickAsk',
      'stack',
    ]);
    expect(Object.keys(bridge.profiles).sort()).toEqual(['add', 'list', 'open', 'remove']);
    expect(Object.keys(bridge.connect).sort()).toEqual([
      'check',
      'cloud',
      'local',
      'options',
      'server',
    ]);
    expect(Object.keys(bridge.quickAsk).sort()).toEqual(['bots', 'close', 'send']);
    expect(Object.keys(bridge.stack).sort()).toEqual([
      'changePort',
      'onProgress',
      'start',
      'startRuntime',
      'status',
      'stop',
      'tailLogs',
      'upgrade',
      'useOwnNetwork',
    ]);
  });

  it('invokes one channel per call with only the expected arguments', async () => {
    const { ipcRenderer } = fakeIpcRenderer();
    const bridge = createAppBridge(ipcRenderer, platform);
    await bridge.profiles.list();
    await bridge.profiles.add({ name: 'Work', url: 'https://w.example.com', extra: 1 } as never);
    await bridge.profiles.remove('p1');
    await bridge.profiles.open('p1');
    await bridge.quickAsk.bots();
    await bridge.quickAsk.send('b1', 'hello');
    bridge.quickAsk.close();
    await bridge.stack.start();
    await bridge.connect.options();
    await bridge.connect.cloud();
    await bridge.connect.check('w.example.com');
    await bridge.connect.server('w.example.com');
    await bridge.connect.local();
    await bridge.pair.relay();
    await bridge.pair.setRelay('wss://mine.example');
    await bridge.pair.code();
    await bridge.pair.relayStatus();
    bridge.pair.close();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.profilesList],
      [DESKTOP_CHANNELS.profilesAdd, { name: 'Work', url: 'https://w.example.com' }],
      [DESKTOP_CHANNELS.profilesRemove, 'p1'],
      [DESKTOP_CHANNELS.profilesOpen, 'p1'],
      [DESKTOP_CHANNELS.quickAskBots],
      [DESKTOP_CHANNELS.quickAskSend, 'b1', 'hello'],
      [DESKTOP_CHANNELS.quickAskClose],
      [STACK_CHANNELS.start],
      [DESKTOP_CHANNELS.connectOptions],
      [DESKTOP_CHANNELS.connectCloud],
      [DESKTOP_CHANNELS.connectCheck, 'w.example.com'],
      [DESKTOP_CHANNELS.connectServer, 'w.example.com'],
      [DESKTOP_CHANNELS.connectLocal],
      [DESKTOP_CHANNELS.pairRelay],
      [DESKTOP_CHANNELS.pairSetRelay, 'wss://mine.example'],
      [DESKTOP_CHANNELS.pairCode],
      [DESKTOP_CHANNELS.pairRelayStatus],
      [DESKTOP_CHANNELS.pairClose],
    ]);
  });

  it('returns what the main process answers', async () => {
    const { ipcRenderer } = fakeIpcRenderer();
    ipcRenderer.invoke.mockResolvedValueOnce({ botId: 'b1', seq: 12 });
    const bridge = createAppBridge(ipcRenderer, platform);
    await expect(bridge.quickAsk.send('b1', 'hi')).resolves.toEqual({ botId: 'b1', seq: 12 });
  });
});

describe('isAppPage', () => {
  it('is the bundle, or the renderer dev server', () => {
    expect(
      isAppPage(
        'file:///Applications/OpenBots.app/Contents/Resources/app.asar/dist/renderer/index.html',
        undefined,
      ),
    ).toBe(true);
    expect(isAppPage('http://localhost:5174/index.html?x=1', 'http://localhost:5174')).toBe(true);
  });

  it('is never a server page', () => {
    expect(isAppPage('http://localhost:3000/bots', undefined)).toBe(false);
    expect(isAppPage('http://localhost:3000/bots', 'http://localhost:5174')).toBe(false);
    expect(isAppPage('https://openbots.example.com/', '')).toBe(false);
    expect(isAppPage('not a url', 'http://localhost:5174')).toBe(false);
  });
});
