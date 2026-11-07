import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  function emitter() {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const on = (event: string, listener: (value: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    };
    const off = (event: string, listener: (value: unknown) => void) => {
      for (const candidate of listeners.get(event) ?? []) {
        if (candidate === listener || Reflect.get(candidate, 'listener') === listener)
          listeners.get(event)?.delete(candidate);
      }
    };
    return {
      listeners,
      on,
      off,
      once: (event: string, listener: (value: unknown) => void) => {
        const once = (value: unknown) => {
          off(event, once);
          listener(value);
        };
        on(event, Object.assign(once, { listener }));
      },
      emit: (event: string, value: unknown) => {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(value);
      },
    };
  }
  return {
    driver: {
      ...emitter(),
      autoDownload: false,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      allowDowngrade: true,
      checkForUpdates: vi.fn<() => Promise<unknown>>(async () => null),
      quitAndInstall: vi.fn(),
    },
    native: { ...emitter(), checkForUpdates: vi.fn() },
    policy: vi.fn<() => Promise<{ manual?: boolean }>>(async () => ({})),
    dialog: vi.fn(async () => ({ response: 0 })),
    openExternal: vi.fn(async () => undefined),
  };
});
// Intentionally no Notification export: update-service must never request or use one.
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', focus: vi.fn() },
  autoUpdater: fixture.native,
  dialog: { showMessageBox: fixture.dialog },
  shell: { openExternal: fixture.openExternal },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: fixture.driver } }));
vi.mock('./update-policy.js', () => ({ updatePolicy: fixture.policy }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.driver.listeners.clear();
  fixture.native.listeners.clear();
  fixture.policy.mockResolvedValue({});
  fixture.dialog.mockResolvedValue({ response: 0 });
  fixture.driver.checkForUpdates.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const { createUpdates } = await import('./update-service.js');
  const callbacks = {
    repository: 'ada/OpenBots-fork',
    changed: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    shutdownFailed: vi.fn(),
  };
  const updates = await createUpdates(callbacks);
  return { updates, callbacks };
}

const release = {
  isUpdateAvailable: true,
  updateInfo: {
    version: '1.2.3',
    tag: 'v1.2.3',
    files: [{ url: 'OpenBots-1.2.3-universal-mac.zip', sha512: 'checksum' }],
  },
};

describe('Mac update service (Bento flow without OS notifications)', () => {
  it('defaults to Later without verifying, shutting down or installing', async () => {
    const { updates, callbacks } = await setup();
    fixture.driver.emit('update-downloaded', { version: '1.2.3' });
    await updates.check(true);
    expect(fixture.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Later', 'Restart and Update'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.native.checkForUpdates).not.toHaveBeenCalled();
    expect(callbacks.shutdown).not.toHaveBeenCalled();
    expect(fixture.driver.quitAndInstall).not.toHaveBeenCalled();
    expect(fixture.driver.autoInstallOnAppQuit).toBe(false);
    expect(updates.notice?.action).toBe('restart');
  });

  it('waits for native staging before shutting down and installing with consent', async () => {
    const { updates, callbacks } = await setup();
    fixture.dialog.mockResolvedValue({ response: 1 });
    fixture.driver.emit('update-downloaded', { version: '1.2.3' });
    const installing = updates.check(true);
    await vi.waitFor(() => expect(fixture.native.checkForUpdates).toHaveBeenCalledOnce());
    expect(callbacks.shutdown).not.toHaveBeenCalled();
    expect(fixture.driver.quitAndInstall).not.toHaveBeenCalled();
    fixture.native.emit('update-downloaded', {});
    await installing;
    expect(callbacks.shutdown).toHaveBeenCalledOnce();
    expect(fixture.driver.quitAndInstall).toHaveBeenCalledOnce();
    expect(fixture.native.listeners.get('error')?.size ?? 0).toBe(0);
  });

  it('preserves the running app and a retryable notice on native validation failure', async () => {
    const { updates, callbacks } = await setup();
    fixture.dialog.mockResolvedValue({ response: 1 });
    fixture.driver.emit('update-downloaded', { version: '1.2.3' });
    const installing = updates.check(true);
    await vi.waitFor(() => expect(fixture.native.checkForUpdates).toHaveBeenCalledOnce());
    fixture.native.emit('error', new Error('Signature verification failed'));
    await installing;
    expect(callbacks.shutdown).not.toHaveBeenCalled();
    expect(fixture.driver.quitAndInstall).not.toHaveBeenCalled();
    expect(callbacks.shutdownFailed).toHaveBeenCalledOnce();
    expect(updates.menu.label).toBe('Restart to Update...');
    expect(fixture.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Could not install the update' }),
    );
  });

  it('uses a verified universal DMG in the fork repository for unsigned builds', async () => {
    fixture.policy.mockResolvedValue({ manual: true });
    const { updates, callbacks } = await setup();
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    fixture.driver.checkForUpdates.mockResolvedValue(release);
    await updates.check();
    expect(updates.notice?.action).toBe('download');
    expect(fixture.dialog).not.toHaveBeenCalled();
    expect(fixture.driver.autoDownload).toBe(false);
    fixture.dialog.mockResolvedValue({ response: 1 });
    await updates.check(true);
    const url =
      'https://github.com/ada/OpenBots-fork/releases/download/v1.2.3/OpenBots-1.2.3-universal.dmg';
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'HEAD' }));
    expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(callbacks.shutdown).not.toHaveBeenCalled();
    expect(fixture.native.checkForUpdates).not.toHaveBeenCalled();
    expect(fixture.driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not send the owner to a missing installer and keeps the notice for retry', async () => {
    fixture.policy.mockResolvedValue({ manual: true });
    const { updates } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    fixture.driver.checkForUpdates.mockResolvedValue(release);
    fixture.dialog.mockResolvedValue({ response: 1 });
    await updates.check(true);
    expect(fixture.openExternal).not.toHaveBeenCalled();
    expect(updates.notice?.action).toBe('download');
    expect(fixture.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Could not check for updates' }),
    );
  });
});
