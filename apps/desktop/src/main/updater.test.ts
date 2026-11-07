import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdater, type AutoUpdaterLike, type UpdateCheckResultLike } from './updater.js';

function fakeAutoUpdater() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn<AutoUpdaterLike['checkForUpdates']>(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    })),
    quitAndInstall: vi.fn(),
    on: vi.fn(
      (event: string, listener: (...args: never[]) => void) => void listeners.set(event, listener),
    ),
    emit: (event: string, ...args: unknown[]) =>
      (listeners.get(event) as (...a: unknown[]) => void)(...args),
  };
  return updater as typeof updater & AutoUpdaterLike;
}

function setup(enabled = true) {
  const autoUpdater = fakeAutoUpdater();
  const notify = vi.fn();
  const report = vi.fn();
  const log = vi.fn();
  const updater = createUpdater({
    autoUpdater,
    enabled,
    notify,
    report,
    log,
    intervalMs: 1_000_000,
    checkTimeoutMs: 1000,
  });
  return { updater, autoUpdater, notify, report, log };
}

afterEach(() => vi.useRealTimers());

describe('updater', () => {
  it('downloads in the background and offers a restart notification', async () => {
    const { updater, autoUpdater, notify, report } = setup();
    expect(autoUpdater.autoDownload).toBe(true);
    updater.start();
    await Promise.resolve();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit('update-downloaded', { version: '1.1.0' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'OpenBots 1.1.0 is ready' }),
    );
    expect(report).not.toHaveBeenCalled();
    notify.mock.calls[0]![0].onClick();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    updater.stop();
  });

  it('shows an in-app up-to-date result without relying on an updater event or OS notifications', async () => {
    const { updater, notify, report } = setup();
    await updater.checkNow();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      title: 'OpenBots is up to date',
      body: 'You have the latest version.',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not duplicate an up-to-date event and promise result', async () => {
    const { updater, autoUpdater, report } = setup();
    const checked = updater.checkNow();
    autoUpdater.emit('update-not-available');
    await checked;
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports rejected checks even when no error event is emitted', async () => {
    const { updater, autoUpdater, report } = setup();
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network unavailable'));
    await updater.checkNow();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      title: 'Could not check for updates',
      body: 'Network unavailable',
    });
  });

  it('does not duplicate an error event and rejected promise', async () => {
    const { updater, autoUpdater, report } = setup();
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      const error = new Error('No release metadata');
      autoUpdater.emit('error', error);
      throw error;
    });
    await updater.checkNow();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('explains skipped checks and development builds in-app', async () => {
    const disabled = setup(false);
    disabled.updater.start();
    await disabled.updater.checkNow();
    expect(disabled.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(disabled.report).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updates are off' }),
    );
    const skipped = setup();
    skipped.autoUpdater.checkForUpdates.mockResolvedValueOnce(null);
    await skipped.updater.checkNow();
    expect(skipped.report).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updates are unavailable' }),
    );
  });

  it('reports an available update and offers an in-app restart after download', async () => {
    const { updater, autoUpdater, report, notify } = setup();
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0' },
    });
    await updater.checkNow();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'OpenBots 1.2.0 is available' }),
    );
    autoUpdater.emit('update-downloaded', { version: '1.2.0' });
    expect(notify).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'OpenBots 1.2.0 is ready' }),
    );
    report.mock.calls.at(-1)![0].onClick();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    await updater.checkNow();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'OpenBots 1.2.0 is ready' }),
    );
  });

  it('reports download errors after a manual check', async () => {
    const { updater, autoUpdater, report } = setup();
    autoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0' },
    });
    await updater.checkNow();
    autoUpdater.emit('error', new Error('Download failed'));
    expect(report).toHaveBeenLastCalledWith({
      title: 'Could not check for updates',
      body: 'Download failed',
    });
  });

  it('keeps background no-update results and failures quiet', async () => {
    const { updater, autoUpdater, notify, report } = setup();
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Offline'));
    updater.start();
    await vi.waitFor(() => expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce());
    autoUpdater.emit('error', new Error('Offline'));
    autoUpdater.emit('update-not-available');
    expect(report).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    updater.stop();
  });

  it('joins a startup check and coalesces repeated menu clicks', async () => {
    const { updater, autoUpdater, report } = setup();
    let resolve!: (result: UpdateCheckResultLike) => void;
    autoUpdater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    updater.start();
    const first = updater.checkNow();
    const second = updater.checkNow();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
    await first;
    expect(report).toHaveBeenCalledOnce();
    updater.stop();
  });

  it('reports a hung check instead of leaving a manual click silent forever', async () => {
    vi.useFakeTimers();
    const { updater, autoUpdater, report } = setup();
    autoUpdater.checkForUpdates.mockImplementationOnce(() => new Promise(() => {}));
    const pending = updater.checkNow();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not check for updates',
        body: expect.stringContaining('timed out'),
      }),
    );
  });
});
