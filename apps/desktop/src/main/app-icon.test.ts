import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveParts } from '@openbots/avatars';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_ICON_FILE, devAppIconPath } from './app-icon.js';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface RenderedIcon {
  path: string;
  data: Buffer;
  size?: number;
}

// A runtime path keeps TypeScript from checking the plain JS script.
const script = join(desktopDir, 'scripts/make-icon.mjs');
const { renderIcons, ICON_AVATAR, ICONSET, BUILD_DIR, WEB_PUBLIC_DIR } = (await import(script)) as {
  renderIcons(): Promise<RenderedIcon[]>;
  ICON_AVATAR: { seed: string; shape: string; palette: string; eyes: string; accessory: string };
  ICONSET: { file: string; size: number }[];
  BUILD_DIR: string;
  WEB_PUBLIC_DIR: string;
};

describe('app icon', () => {
  it('is Pixel, the blue moon-shaped avatar with headphones, which its seed alone gives', () => {
    const { seed, ...parts } = ICON_AVATAR;
    expect(parts).toEqual({
      shape: 'bean',
      palette: 'sky',
      eyes: 'round',
      accessory: 'headphones',
    });
    expect(resolveParts({ seed })).toEqual(parts);
  });

  it('matches the committed files (run the app-icon script after changing it)', async () => {
    const icons = await renderIcons();
    expect(icons.map((i) => i.path).sort()).toEqual(
      [
        join(BUILD_DIR, 'icon.png'),
        join(BUILD_DIR, 'icon.svg'),
        join(WEB_PUBLIC_DIR, 'apple-touch-icon.png'),
        join(WEB_PUBLIC_DIR, 'favicon-32.png'),
        join(WEB_PUBLIC_DIR, 'favicon.svg'),
      ].sort(),
    );
    for (const icon of icons) {
      const committed = readFileSync(icon.path);
      if (icon.size) {
        // PNG signature, then IHDR: width and height.
        expect(committed.readUInt32BE(16)).toBe(icon.size);
        expect(committed.readUInt32BE(20)).toBe(icon.size);
      }
      expect(committed.equals(icon.data), icon.path).toBe(true);
    }
  });

  it('builds the .icns from a full iconset, 16 to 512 points at 1x and 2x', () => {
    expect(ICONSET.map((i) => [i.file, i.size])).toEqual([
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ]);
    const icns = readFileSync(join(BUILD_DIR, 'icon.icns'));
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    // ic10 is the 512@2x (1024 px) image.
    expect(icns.includes(Buffer.from('ic10', 'latin1'))).toBe(true);
  });

  it('is the icon electron-builder packages', () => {
    const builder = parse(readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8')) as {
      directories: { buildResources: string };
      mac: { icon: string };
    };
    expect(join(desktopDir, builder.directories.buildResources)).toBe(BUILD_DIR);
    expect(builder.mac.icon).toBe('build/icon.icns');
    expect(existsSync(join(desktopDir, builder.mac.icon))).toBe(true);
  });

  it('is set at runtime only in development, from build/icon.png', () => {
    expect(devAppIconPath({ packaged: true, mainDir: '/App/Resources/app/dist/main' })).toBe(
      undefined,
    );
    // In development the main bundle is dist/main.
    const dev = devAppIconPath({ packaged: false, mainDir: join(desktopDir, 'dist/main') });
    expect(dev).toBe(join(BUILD_DIR, APP_ICON_FILE));
    expect(existsSync(dev!)).toBe(true);
  });

  it('is the web UI favicon and apple-touch-icon', () => {
    const html = readFileSync(join(desktopDir, '../web/index.html'), 'utf8');
    const links = [...html.matchAll(/<link rel="(icon|apple-touch-icon)" href="\/([^"]+)"/g)];
    expect(links.map(([, rel, file]) => [rel, file])).toEqual([
      ['icon', 'favicon.svg'],
      ['icon', 'favicon-32.png'],
      ['apple-touch-icon', 'apple-touch-icon.png'],
    ]);
    for (const [, , file] of links) expect(existsSync(join(WEB_PUBLIC_DIR, file!))).toBe(true);
  });
});
