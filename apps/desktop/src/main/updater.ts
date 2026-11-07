// Auto-update (plan 14.4) with electron-updater against GitHub Releases.
// Manual checks use an in-app dialog, not OS notifications that may be denied
// or hidden by Focus. Background checks remain quiet unless an update is ready.

export interface UpdateCheckResultLike {
  isUpdateAvailable: boolean;
  updateInfo: { version: string };
}

/** The slice of electron-updater's autoUpdater used here. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  quitAndInstall(): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateMessage {
  title: string;
  body: string;
  onClick?: () => void;
}

export interface UpdaterOptions {
  autoUpdater: AutoUpdaterLike;
  /** False for unpackaged runs: there is nothing to update. */
  enabled: boolean;
  /** Passive notification for a background download. */
  notify(message: UpdateMessage): void;
  /** Visible in-app result for an explicit menu click, independent of OS permissions. */
  report(message: UpdateMessage): void;
  log(message: string, error?: unknown): void;
  intervalMs?: number;
  checkTimeoutMs?: number;
}

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 30_000;

export function createUpdater(options: UpdaterOptions) {
  const { autoUpdater, enabled, notify, report, log } = options;
  let manual = false;
  let manualDownload = false;
  let downloadedVersion: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<UpdateCheckResultLike | null> | undefined;
  let manualCheck: Promise<void> | undefined;

  const ready = (version: string): UpdateMessage => ({
    title: `OpenBots ${version} is ready`,
    body: 'Restart to update now, or it installs when you quit.',
    onClick: () => autoUpdater.quitAndInstall(),
  });
  const failed = (error: unknown) => {
    log('update check failed', error);
    if (manual || manualDownload) {
      manual = false;
      manualDownload = false;
      report({
        title: 'Could not check for updates',
        body: error instanceof Error ? error.message : 'Please try again later.',
      });
    }
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', ({ version }) => {
    downloadedVersion = version;
    if (manualDownload || manual) {
      manual = false;
      manualDownload = false;
      report(ready(version));
    } else {
      notify(ready(version));
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (manual) {
      manual = false;
      report({ title: 'OpenBots is up to date', body: 'You have the latest version.' });
    }
  });
  autoUpdater.on('error', failed);

  // Join a running startup/periodic check instead of launching overlapping requests.
  const check = () => {
    if (inFlight) return inFlight;
    const pending = Promise.resolve().then(() => autoUpdater.checkForUpdates());
    inFlight = pending;
    // Use both handlers rather than an unobserved finally promise on rejection.
    void pending.then(
      () => {
        if (inFlight === pending) inFlight = undefined;
      },
      () => {
        if (inFlight === pending) inFlight = undefined;
      },
    );
    return pending;
  };

  return {
    start() {
      if (!enabled || timer) return;
      void check().catch(failed);
      timer = setInterval(
        () => void check().catch(failed),
        options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS,
      );
      timer.unref?.();
    },
    /** Every explicit check reports an outcome, including skipped checks and rejections. */
    checkNow(): Promise<void> {
      if (manualCheck) return manualCheck;
      if (!enabled) {
        report({
          title: 'Updates are off',
          body: 'This is a development build; it does not update itself.',
        });
        return Promise.resolve();
      }
      if (downloadedVersion) {
        report(ready(downloadedVersion));
        return Promise.resolve();
      }
      manual = true;
      manualCheck = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error('The update check timed out. Check your connection and try again.'),
                  ),
                options.checkTimeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
              );
            }),
          ]);
          // An event may already have reported the outcome.
          if (!manual) return;
          manual = false;
          if (!result) {
            report({
              title: 'Updates are unavailable',
              body: 'This build cannot check for updates. Install an official OpenBots release to enable automatic updates.',
            });
          } else if (result.isUpdateAvailable) {
            manualDownload = true;
            report({
              title: `OpenBots ${result.updateInfo.version} is available`,
              body: 'The update is downloading. You will be asked to restart when it is ready.',
            });
          } else {
            report({ title: 'OpenBots is up to date', body: 'You have the latest version.' });
          }
        } catch (error) {
          failed(error);
        } finally {
          if (timeout) clearTimeout(timeout);
          manual = false;
          manualCheck = undefined;
        }
      })();
      return manualCheck;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
