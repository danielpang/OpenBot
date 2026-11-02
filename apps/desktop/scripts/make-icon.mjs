// Renders the app icon from a Bot avatar (packages/avatars): Pixel from the
// openbots.sh landing page, the blue moon-shaped face with round eyes and
// headphones, on a dark plate that matches the app's
// dark background. The face is drawn by the avatars package's own generate(),
// so it stays the same drawing a Bot with these parts shows.
//
// Writes, all committed:
//   build/icon.svg     the 1024 master on Apple's icon grid (an 824 px plate,
//                      centred, with a soft shadow)
//   build/icon.png     the master at 1024 px (the Dock icon in development)
//   build/icon.icns    every size macOS asks for, built with iconutil (macOS only)
//   ../web/public/favicon.svg, favicon-32.png, apple-touch-icon.png
//                      the web UI's tab and home screen icons
//
// Run `pnpm --filter @openbots/desktop app-icon` after changing the avatar or
// the plate. src/main/app-icon.test.ts checks that the committed files match.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_DIR = join(desktopDir, 'build');
export const WEB_PUBLIC_DIR = join(desktopDir, '../web/public');

/**
 * The avatar: seed `OpenBots-2225` resolves to these parts on its own, and
 * pinning them keeps the icon the same if the catalogue's order changes.
 */
export const ICON_AVATAR = {
  seed: 'OpenBots-2225',
  shape: 'bean',
  palette: 'sky',
  eyes: 'round',
  accessory: 'headphones',
};

/** The app's dark background (packages/ui --background in dark mode, oklch(0.145 0 0)). */
const BACKGROUND = '#0a0a0a';
/** The plate is a touch lighter at the top so it reads on a dark Dock. */
const PLATE_TOP = '#1c1c1c';

const CANVAS = 1024;
/** Apple's macOS icon grid: an 824 px rounded square centred on the 1024 canvas. */
const PLATE = 824;
const PLATE_RADIUS = 185;
/** The face's width as a share of the plate. */
const FACE_SHARE = 0.72;
// The avatar's body is a circle at (32, 34), r 23, on a 64 unit grid.
const BODY = { cx: 32, cy: 34, r: 23 };

const n = (value) => Math.round(value * 100) / 100;

async function avatarSvg() {
  const path = join(desktopDir, '../../packages/avatars/src/generate.ts');
  const { module } = await runnerImport(path, { configFile: false, logLevel: 'silent' });
  return module.generate(ICON_AVATAR).svg;
}

/** The avatar's 64 unit SVG, scaled so its body is `face` px wide and centred on (cx, cy). */
function placeFace(avatar, face, cx, cy) {
  const scale = face / (BODY.r * 2);
  const at = `x="${n(cx - BODY.cx * scale)}" y="${n(cy - BODY.cy * scale)}" width="${n(64 * scale)}" height="${n(64 * scale)}"`;
  return avatar.replace('<svg ', `<svg ${at} `);
}

/**
 * The icon: a plate at (inset, inset), `size` wide with corner radius
 * `radius`, the face on it, and the drop shadow when `shadow` is set.
 */
function composeIcon(avatar, { inset, size, radius, shadow }) {
  const centre = inset + size / 2;
  const plate = `x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${radius}"`;
  const hairline = 3;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">` +
    '<defs>' +
    `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PLATE_TOP}"/><stop offset="1" stop-color="${BACKGROUND}"/></linearGradient>` +
    '<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".14"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".04"/></linearGradient>' +
    (shadow
      ? '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity=".35"/></filter>'
      : '') +
    '</defs>' +
    // The shadow is cast by a plain copy of the plate underneath: a gradient
    // under a filter renders in bands.
    (shadow ? `<rect ${plate} fill="#000000" filter="url(#shadow)"/>` : '') +
    `<rect ${plate} fill="url(#plate)"/>` +
    `<rect x="${inset + hairline / 2}" y="${inset + hairline / 2}" width="${size - hairline}" height="${size - hairline}" rx="${Math.max(0, radius - hairline / 2)}" fill="none" stroke="url(#rim)" stroke-width="${hairline}"/>` +
    placeFace(avatar, size * FACE_SHARE, centre, centre) +
    '</svg>'
  );
}

/** Every SVG source: the app icon and the web's two variants. */
export async function iconSources() {
  const avatar = await avatarSvg();
  const inset = (CANVAS - PLATE) / 2;
  return {
    // The Dock icon: Apple's grid, with room around the plate for its shadow.
    app: composeIcon(avatar, { inset, size: PLATE, radius: PLATE_RADIUS, shadow: true }),
    // A browser tab has no room to spare: the plate fills the box.
    favicon: composeIcon(avatar, {
      inset: 0,
      size: CANVAS,
      radius: (PLATE_RADIUS / PLATE) * CANVAS,
      shadow: false,
    }),
    // iOS rounds the corners itself and wants an opaque square.
    touch: composeIcon(avatar, { inset: 0, size: CANVAS, radius: 0, shadow: false }),
  };
}

// resvg-js is a dependency of packages/avatars (the avatar PNGs); borrow it
// rather than add a native module to the app.
const require = createRequire(join(desktopDir, '../../packages/avatars/package.json'));

/** Renders an SVG to a square PNG `size` px wide. */
export function renderPng(svg, size) {
  const { Resvg } = require('@resvg/resvg-js');
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
}

/** The PNGs an .iconset holds: 16 to 512 points, each at 1x and 2x. */
export const ICONSET = [16, 32, 128, 256, 512].flatMap((points) => [
  { file: `icon_${points}x${points}.png`, size: points },
  { file: `icon_${points}x${points}@2x.png`, size: points * 2 },
]);

/** The committed files and their bytes, apart from the .icns. */
export async function renderIcons() {
  const svg = await iconSources();
  return [
    { path: join(BUILD_DIR, 'icon.svg'), data: Buffer.from(svg.app) },
    { path: join(BUILD_DIR, 'icon.png'), data: renderPng(svg.app, 1024), size: 1024 },
    { path: join(WEB_PUBLIC_DIR, 'favicon.svg'), data: Buffer.from(svg.favicon) },
    { path: join(WEB_PUBLIC_DIR, 'favicon-32.png'), data: renderPng(svg.favicon, 32), size: 32 },
    {
      path: join(WEB_PUBLIC_DIR, 'apple-touch-icon.png'),
      data: renderPng(svg.touch, 180),
      size: 180,
    },
  ];
}

/** Builds build/icon.icns from an iconset rendered straight from the SVG at each size. */
async function writeIcns(svg) {
  const work = mkdtempSync(join(tmpdir(), 'openbots-icon-'));
  try {
    const iconset = join(work, 'icon.iconset');
    mkdirSync(iconset);
    for (const { file, size } of ICONSET) writeFileSync(join(iconset, file), renderPng(svg, size));
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(BUILD_DIR, 'icon.icns')]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { path, data } of await renderIcons()) {
    writeFileSync(path, data);
    console.log(`wrote ${path}`);
  }
  if (process.platform === 'darwin') {
    await writeIcns((await iconSources()).app);
    console.log(`wrote ${join(BUILD_DIR, 'icon.icns')}`);
  } else {
    console.warn('skipped build/icon.icns: iconutil needs macOS');
  }
}
