// Auto-update (plan 14.4) with electron-updater against the GitHub Releases
// electron-builder publishes (electron-builder.yml `publish`, latest-mac.yml).
// Squirrel.Mac installs only updates signed with the same Developer ID, so an
// unsigned dev build checks nothing (see RELEASING.md).

/** The slice of electron-updater's `autoUpdater` used here. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdaterOptions {
  autoUpdater: AutoUpdaterLike;
  /** False for `electron-vite dev` and unpackaged runs: there is nothing to update. */
  enabled: boolean;
  /** Tells the owner; `onClick` is set for the "restart to update" message. */
  notify(message: { title: string; body: string; onClick?: () => void }): void;
  log(message: string, error?: unknown): void;
  intervalMs?: number;
}

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createUpdater(options: UpdaterOptions) {
  const { autoUpdater, enabled, notify, log } = options;
  let manual = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', ({ version }) => {
    notify({
      title: `OpenBots ${version} is ready`,
      body: 'Click to restart and update now, or it installs when you quit.',
      onClick: () => autoUpdater.quitAndInstall(),
    });
  });
  autoUpdater.on('update-not-available', () => {
    if (manual) notify({ title: 'OpenBots is up to date', body: 'You have the latest version.' });
    manual = false;
  });
  autoUpdater.on('error', (error) => {
    log('update check failed', error);
    if (manual) notify({ title: 'Could not check for updates', body: error.message });
    manual = false;
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((error: unknown) => log('update check failed', error));

  return {
    start() {
      if (!enabled || timer) return;
      void check();
      timer = setInterval(() => void check(), options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    /** "Check for Updates…" in the tray: says the outcome either way. */
    checkNow() {
      if (!enabled) {
        notify({
          title: 'Updates are off',
          body: 'This is a development build; it does not update itself.',
        });
        return;
      }
      manual = true;
      void check();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
