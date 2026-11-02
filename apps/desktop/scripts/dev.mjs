// `pnpm --filter @openbots/desktop dev`: runs electron-vite dev. On macOS it
// first makes .dev/OpenBots.app, a copy of Electron's own app bundle named
// OpenBots with the app icon, and points electron-vite at it
// (ELECTRON_EXEC_PATH). macOS takes the menu bar and Dock name and icon from
// the bundle, so without this a development build shows as "Electron". The
// packaged app is named by electron-builder and does not use this.
//
// The copy is made again when Electron's version or the icon changes.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktopDir, 'package.json'));

export const DEV_APP_NAME = 'OpenBots';
export const DEV_BUNDLE_ID = 'com.openbots.app.dev';

/** The Info.plist keys the copy changes, with their values. */
export const PLIST_CHANGES = {
  CFBundleName: DEV_APP_NAME,
  CFBundleDisplayName: DEV_APP_NAME,
  CFBundleIdentifier: DEV_BUNDLE_ID,
  CFBundleIconFile: 'icon.icns',
};

/** Makes .dev/OpenBots.app when it is missing or stale; returns its executable. */
function devBundle() {
  // The electron package exports the path to its executable,
  // .../Electron.app/Contents/MacOS/Electron.
  const electronExec = require('electron');
  const source = resolve(electronExec, '../../..');
  const version = require('electron/package.json').version;
  const icon = join(desktopDir, 'build/icon.icns');
  const stamp = `${version}:${readFileSync(icon).length}`;

  const target = join(desktopDir, '.dev', `${DEV_APP_NAME}.app`);
  const stampFile = join(desktopDir, '.dev', 'stamp');
  const exec = join(target, 'Contents/MacOS/Electron');
  if (existsSync(exec) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
    return exec;
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  // ditto keeps the bundle's symlinks, permissions and extended attributes.
  execFileSync('ditto', [source, target]);
  const plist = join(target, 'Contents/Info.plist');
  for (const [key, value] of Object.entries(PLIST_CHANGES)) {
    execFileSync('plutil', ['-replace', key, '-string', value, plist]);
  }
  copyFileSync(icon, join(target, 'Contents/Resources/icon.icns'));
  // Editing Info.plist breaks Electron's signature; Apple Silicon refuses to
  // launch a bundle whose signature does not match, so sign the copy ad hoc.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'ignore' });
  writeFileSync(stampFile, stamp);
  return exec;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env };
  if (process.platform === 'darwin' && !env.ELECTRON_EXEC_PATH) {
    try {
      env.ELECTRON_EXEC_PATH = devBundle();
    } catch (error) {
      console.warn(`Could not make ${DEV_APP_NAME}.app, running as Electron: ${error.message}`);
    }
  }
  const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
