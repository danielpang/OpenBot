import { join } from 'node:path';

// The app icon: a Bot avatar on a dark plate, rendered by
// scripts/make-icon.mjs into build/ (electron-builder's build resources). A
// packaged app carries it as Contents/Resources/icon.icns and macOS shows it
// on its own. `electron-vite dev` runs the stock Electron binary, so the main
// process sets the same icon on the Dock, and on windows where the platform
// shows one, from build/icon.png.

export const APP_ICON_FILE = 'icon.png';

/** The icon to set at runtime: build/icon.png in development, none when packaged. */
export function devAppIconPath(options: {
  packaged: boolean;
  /** The directory of the main process bundle (dist/main). */
  mainDir: string;
}): string | undefined {
  return options.packaged ? undefined : join(options.mainDir, '../../build', APP_ICON_FILE);
}
