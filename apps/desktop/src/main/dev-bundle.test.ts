import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/dev.mjs: a development build runs from a copy of Electron's bundle
// named OpenBots, so macOS shows OpenBots in the menu bar and the Dock.

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { PLIST_CHANGES, DEV_APP_NAME, DEV_BUNDLE_ID } = (await import(
  resolve(desktopDir, 'scripts/dev.mjs')
)) as {
  PLIST_CHANGES: Record<string, string>;
  DEV_APP_NAME: string;
  DEV_BUNDLE_ID: string;
};

describe('development app bundle', () => {
  it('is named OpenBots, with the app icon and its own bundle ID', () => {
    expect(DEV_APP_NAME).toBe('OpenBots');
    expect(PLIST_CHANGES).toEqual({
      CFBundleName: 'OpenBots',
      CFBundleDisplayName: 'OpenBots',
      CFBundleIdentifier: DEV_BUNDLE_ID,
      CFBundleIconFile: 'icon.icns',
    });
    // Apart from the packaged app's, so macOS keeps their settings apart.
    expect(DEV_BUNDLE_ID).not.toBe('com.openbots.app');
  });

  it('is what pnpm dev runs, and stays out of git', () => {
    const pkg = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dev).toBe('node scripts/dev.mjs');
    expect(readFileSync(resolve(desktopDir, '.gitignore'), 'utf8')).toContain('/.dev/');
  });
});
