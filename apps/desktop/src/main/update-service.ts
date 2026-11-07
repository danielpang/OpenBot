import { app, autoUpdater as nativeUpdater, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { DesktopUpdates } from './updater.js';
import { updatePolicy } from './update-policy.js';

// Native Squirrel verifies and stages the signed ZIP before we commit to quit.
let staged = false;
nativeUpdater.on('update-downloaded', () => {
  staged = true;
});
function prepareInstall(): Promise<void> {
  if (staged) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      nativeUpdater.off('error', failed);
      nativeUpdater.off('update-downloaded', ready);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const timeout = setTimeout(
      () => failed(new Error('Timed out verifying the macOS update.')),
      120_000,
    );
    nativeUpdater.once('error', failed);
    nativeUpdater.once('update-downloaded', ready);
    try {
      nativeUpdater.checkForUpdates();
    } catch (error) {
      failed(error as Error);
    }
  });
}

export async function createUpdates(callbacks: {
  repository: string;
  changed(): void;
  shutdown(): Promise<void>;
  shutdownFailed(): void;
}) {
  const policy = await updatePolicy({
    packaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
    verifySignature: async () => {
      await promisify(execFile)(
        '/usr/bin/codesign',
        [
          '--verify',
          '--deep',
          '--strict',
          '-R',
          '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
          path.resolve(process.execPath, '../../..'),
        ],
        { timeout: 30_000 },
      );
    },
  });
  const message = async (message: string, detail: string) => {
    app.focus({ steal: true });
    await dialog.showMessageBox({ type: 'info', message, detail });
  };
  return new DesktopUpdates(
    electronUpdater.autoUpdater,
    {
      ...callbacks,
      prepareInstall,
      message,
      confirmRestart: async (version) => {
        app.focus({ steal: true });
        return (
          (
            await dialog.showMessageBox({
              type: 'question',
              buttons: ['Later', 'Restart and Update'],
              defaultId: 0,
              cancelId: 0,
              message: `Install OpenBots ${version}?`,
              detail:
                'OpenBots will restart. Your projects and settings are kept. Your Docker stack and agents on remote servers keep running. Any local stack upgrade is offered after relaunch.',
            })
          ).response === 1
        );
      },
    },
    policy.disabledReason,
    policy.manual
      ? {
          repository: callbacks.repository,
          confirmDownload: async (version) => {
            app.focus({ steal: true });
            return (
              (
                await dialog.showMessageBox({
                  type: 'info',
                  buttons: ['Later', 'Update'],
                  defaultId: 1,
                  cancelId: 0,
                  message: `OpenBots ${version} is available`,
                  detail:
                    'Download the installer in your browser. When ready, quit OpenBots with Cmd+Q, open the DMG, and drag OpenBots into Applications to replace the old app. Your settings and projects are kept. OpenBots keeps running until you quit.',
                })
              ).response === 1
            );
          },
          openDownload: async (url) => {
            // Older update manifests include only the ZIP. Check the derived DMG
            // before opening a browser rather than sending the owner to a 404.
            const response = await fetch(url, {
              method: 'HEAD',
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error('The release installer is not available yet.');
            await shell.openExternal(url);
          },
        }
      : undefined,
  );
}
