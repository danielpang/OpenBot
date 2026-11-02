import { join } from 'node:path';

// The menu bar icon (N2): a macOS template image, black and alpha, which
// macOS tints for a light or dark menu bar. nativeImage loads the @2x file
// next to it on a Retina screen. resources/tray holds the PNGs, rendered from
// tray.svg by scripts/tray-icon.mjs; electron-builder copies them to
// Contents/Resources/tray.

export const TRAY_ICON_FILE = 'trayTemplate.png';

/** Where the icon is: in the app bundle, or in the source tree in development. */
export function trayIconPath(options: {
  packaged: boolean;
  resourcesPath: string;
  /** The directory of the main process bundle (dist/main). */
  mainDir: string;
}): string {
  return options.packaged
    ? join(options.resourcesPath, 'tray', TRAY_ICON_FILE)
    : join(options.mainDir, '../../resources/tray', TRAY_ICON_FILE);
}

/** The text beside the icon: the pending count, or the glyph when the icon did not load. */
export function trayTitle(pending: number, hasIcon: boolean): string {
  if (hasIcon) return pending > 0 ? String(pending) : '';
  return pending > 0 ? `◉ ${pending}` : '◉';
}
