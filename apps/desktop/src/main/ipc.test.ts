import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_CHANNELS } from '../ipc.js';
import type { IpcInvokeEvent, IpcMainLike } from '../stack/bridge.js';
import { registerDesktopIpc, type DesktopHandlers } from './ipc.js';

type Handler = Parameters<IpcMainLike['handle']>[1];

const info = {
  kind: 'remote' as const,
  label: 'Self-hosted',
  host: 'x.example.com',
  url: 'https://x.example.com',
};

function setup(trusted = true, serverPage = false) {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
  };
  const desktop: DesktopHandlers = {
    listProfiles: vi.fn(async () => ({ activeId: 'local', profiles: [], chosen: true })),
    addProfile: vi.fn(async (input) => ({
      id: 'p1',
      name: input.name ?? 'x',
      url: input.url,
      kind: 'remote' as const,
    })),
    removeProfile: vi.fn(async () => ({ activeId: 'local', profiles: [], chosen: true })),
    openProfile: vi.fn(async () => undefined),
    connectOptions: vi.fn(async () => ({ cloudUrl: null, chosen: false })),
    connectCloud: vi.fn(async () => undefined),
    checkServer: vi.fn(async (url) => ({ url, setupRequired: false, warning: null })),
    connectServer: vi.fn(async () => undefined),
    connectLocal: vi.fn(async () => undefined),
    connectionInfo: vi.fn(async () => info),
    changeConnection: vi.fn(async () => undefined),
    startLocal: vi.fn(async () => info),
    stopLocal: vi.fn(async () => undefined),
    showLocalLogs: vi.fn(async () => undefined),
    openOAuth: vi.fn(async () => undefined),
    oauthFinished: vi.fn(),
    quickAskBots: vi.fn(async () => []),
    quickAsk: vi.fn(async (botId) => ({ botId, seq: 1 })),
    closeQuickAsk: vi.fn(),
  };
  registerDesktopIpc(
    ipcMain,
    desktop,
    () => trusted,
    () => serverPage,
  );
  const event = { sender: {} } as IpcInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!(event, ...args));
  return { handlers, desktop, invoke };
}

describe('registerDesktopIpc', () => {
  it('registers every channel the app bridge invokes', () => {
    const { handlers } = setup();
    // navigate and newItem go from main to the page; nothing invokes them.
    const sent: string[] = [DESKTOP_CHANNELS.navigate, DESKTOP_CHANNELS.newItem];
    for (const channel of Object.values(DESKTOP_CHANNELS)) {
      if (sent.includes(channel)) continue;
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('refuses untrusted windows before any handler runs', async () => {
    const { desktop, invoke } = setup(false);
    await expect(
      invoke(DESKTOP_CHANNELS.profilesAdd, { url: 'https://x.example.com' }),
    ).rejects.toThrow(/may not use/);
    await expect(invoke(DESKTOP_CHANNELS.quickAskSend, 'b1', 'hi')).rejects.toThrow(/may not use/);
    expect(desktop.addProfile).not.toHaveBeenCalled();
    expect(desktop.quickAsk).not.toHaveBeenCalled();
  });

  it("answers the active server's page on the connection channels only", async () => {
    const { desktop, invoke } = setup(false, true);
    await expect(invoke(DESKTOP_CHANNELS.connectionInfo)).resolves.toEqual(info);
    await invoke(DESKTOP_CHANNELS.connectionChange);
    await invoke(DESKTOP_CHANNELS.connectionStart);
    await invoke(DESKTOP_CHANNELS.connectionStop);
    await invoke(DESKTOP_CHANNELS.connectionLogs);
    expect(desktop.changeConnection).toHaveBeenCalled();
    expect(desktop.startLocal).toHaveBeenCalled();
    // The welcome screen's channels and the profiles stay the app's own.
    for (const channel of [
      DESKTOP_CHANNELS.connectOptions,
      DESKTOP_CHANNELS.connectCloud,
      DESKTOP_CHANNELS.connectServer,
      DESKTOP_CHANNELS.connectLocal,
      DESKTOP_CHANNELS.profilesList,
    ]) {
      await expect(invoke(channel, 'https://x.example.com')).rejects.toThrow(/may not use/);
    }
    expect(desktop.connectServer).not.toHaveBeenCalled();
  });

  it("lets the active server's page open a sign-in in the browser and come back", async () => {
    const { desktop, invoke } = setup(false, true);
    await invoke(DESKTOP_CHANNELS.oauthOpen, 'https://mcp.example.com/authorize');
    await invoke(DESKTOP_CHANNELS.oauthFinished);
    expect(desktop.openOAuth).toHaveBeenCalledWith('https://mcp.example.com/authorize');
    expect(desktop.oauthFinished).toHaveBeenCalled();
    await expect(invoke(DESKTOP_CHANNELS.oauthOpen, 42)).rejects.toThrow(/must be text/);
  });

  it('refuses the sign-in channels to any other page', async () => {
    const { desktop, invoke } = setup(false, false);
    await expect(invoke(DESKTOP_CHANNELS.oauthOpen, 'https://x.example.com')).rejects.toThrow(
      /may not use/,
    );
    await expect(invoke(DESKTOP_CHANNELS.oauthFinished)).rejects.toThrow(/may not use/);
    expect(desktop.openOAuth).not.toHaveBeenCalled();
    expect(desktop.oauthFinished).not.toHaveBeenCalled();
  });

  it('refuses the connection channels to any other page', async () => {
    const { desktop, invoke } = setup(false, false);
    await expect(invoke(DESKTOP_CHANNELS.connectionInfo)).rejects.toThrow(/may not use/);
    await expect(invoke(DESKTOP_CHANNELS.connectionStop)).rejects.toThrow(/may not use/);
    expect(desktop.stopLocal).not.toHaveBeenCalled();
  });

  it('checks argument types', async () => {
    const { invoke } = setup();
    await expect(invoke(DESKTOP_CHANNELS.profilesAdd, { url: 3 })).rejects.toThrow(/must be text/);
    await expect(invoke(DESKTOP_CHANNELS.profilesOpen, {})).rejects.toThrow(/must be text/);
    await expect(invoke(DESKTOP_CHANNELS.connectServer, 7)).rejects.toThrow(/must be text/);
    await expect(invoke(DESKTOP_CHANNELS.connectCheck, null)).rejects.toThrow(/must be text/);
    await expect(invoke(DESKTOP_CHANNELS.quickAskSend, 'b1', '   ')).rejects.toThrow(
      /Type a message/,
    );
    await expect(invoke(DESKTOP_CHANNELS.quickAskSend, 'b1', 'x'.repeat(100_001))).rejects.toThrow(
      /too long/,
    );
  });

  it('passes trimmed, typed arguments on', async () => {
    const { desktop, invoke } = setup();
    await invoke(DESKTOP_CHANNELS.profilesAdd, { name: 7, url: 'https://x.example.com' });
    expect(desktop.addProfile).toHaveBeenCalledWith({ url: 'https://x.example.com' });
    await expect(invoke(DESKTOP_CHANNELS.quickAskSend, 'b1', '  hello  ')).resolves.toEqual({
      botId: 'b1',
      seq: 1,
    });
    expect(desktop.quickAsk).toHaveBeenCalledWith('b1', 'hello');
  });
});
