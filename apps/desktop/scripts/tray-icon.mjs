// Renders the menu bar icon (N2) from resources/tray/tray.svg into the macOS
// template images the tray loads: trayTemplate.png (16 px) and
// trayTemplate@2x.png (32 px). The "Template" suffix tells macOS to tint the
// black-and-alpha image for a light or dark menu bar. The PNGs are committed;
// run `pnpm --filter @openbots/desktop tray-icon` after changing the SVG.
// src/main/tray-icon.test.ts checks that the committed files match.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TRAY_DIR = join(desktopDir, 'resources/tray');

/** The icons to write: one per backing scale factor. */
export const TRAY_ICONS = [
  { file: 'trayTemplate.png', size: 16 },
  { file: 'trayTemplate@2x.png', size: 32 },
];

// resvg-js is a dependency of packages/avatars (the avatar PNGs); borrow it
// rather than add a native module to the app.
const require = createRequire(join(desktopDir, '../../packages/avatars/package.json'));

/** Each icon's PNG bytes and its raw RGBA pixels. */
export function renderTrayIcons() {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = readFileSync(join(TRAY_DIR, 'tray.svg'), 'utf8');
  return TRAY_ICONS.map(({ file, size }) => {
    const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
    return { file, size, png: image.asPng(), pixels: image.pixels };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { file, png } of renderTrayIcons()) {
    writeFileSync(join(TRAY_DIR, file), png);
    console.log(`wrote resources/tray/${file}`);
  }
}
