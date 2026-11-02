import { describe, expect, it, vi } from 'vitest';
import { createUpdater, type AutoUpdaterLike } from './updater.js';

function fakeAutoUpdater() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn(
      (event: string, listener: (...args: never[]) => void) => void listeners.set(event, listener),
    ),
    emit: (event: string, ...args: unknown[]) =>
      (listeners.get(event) as (...a: unknown[]) => void)(...args),
  };
  return updater as typeof updater & AutoUpdaterLike;
}

describe('updater', () => {
  it('downloads in the background and offers a restart', () => {
    const autoUpdater = fakeAutoUpdater();
    const notify = vi.fn();
    const updater = createUpdater({
      autoUpdater,
      enabled: true,
      notify,
      log: vi.fn(),
      intervalMs: 1_000_000,
    });
    expect(autoUpdater.autoDownload).toBe(true);
    updater.start();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit('update-downloaded', { version: '1.1.0' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'OpenBots 1.1.0 is ready' }),
    );
    notify.mock.calls[0]![0].onClick();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    updater.stop();
  });

  it('only says "up to date" when the owner asked', () => {
    const autoUpdater = fakeAutoUpdater();
    const notify = vi.fn();
    const updater = createUpdater({ autoUpdater, enabled: true, notify, log: vi.fn() });
    autoUpdater.emit('update-not-available');
    expect(notify).not.toHaveBeenCalled();
    updater.checkNow();
    autoUpdater.emit('update-not-available');
    expect(notify).toHaveBeenCalledWith({
      title: 'OpenBots is up to date',
      body: 'You have the latest version.',
    });
  });

  it('checks nothing in a development build', () => {
    const autoUpdater = fakeAutoUpdater();
    const notify = vi.fn();
    const updater = createUpdater({ autoUpdater, enabled: false, notify, log: vi.fn() });
    updater.start();
    updater.checkNow();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updates are off' }));
  });
});
