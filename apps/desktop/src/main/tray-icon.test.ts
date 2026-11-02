import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRAY_ICON_FILE, trayIconPath, trayTitle } from './tray-icon.js';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface TrayIcon {
  file: string;
  size: number;
  png: Buffer;
  pixels: Buffer;
}

// A runtime path keeps TypeScript from checking the plain JS script.
const script = join(desktopDir, 'scripts/tray-icon.mjs');
const { renderTrayIcons, TRAY_DIR } = (await import(script)) as {
  renderTrayIcons(): TrayIcon[];
  TRAY_DIR: string;
};

describe('tray icon', () => {
  const icons = renderTrayIcons();

  it('is a 1x and 2x pair of template images named the way macOS expects', () => {
    expect(icons.map((i) => [i.file, i.size])).toEqual([
      ['trayTemplate.png', 16],
      ['trayTemplate@2x.png', 32],
    ]);
    expect(TRAY_ICON_FILE).toBe('trayTemplate.png');
  });

  it('matches the committed PNGs (run the tray-icon script after editing the SVG)', () => {
    for (const icon of icons) {
      const committed = readFileSync(join(TRAY_DIR, icon.file));
      // PNG signature, then IHDR: width and height.
      expect(committed.readUInt32BE(16)).toBe(icon.size);
      expect(committed.readUInt32BE(20)).toBe(icon.size);
      expect(committed.equals(icon.png)).toBe(true);
    }
  });

  it('is black and alpha only, with something drawn', () => {
    for (const { pixels, size } of icons) {
      expect(pixels.length).toBe(size * size * 4);
      let drawn = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] === 0) continue;
        drawn++;
        expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([0, 0, 0]);
      }
      expect(drawn).toBeGreaterThan((size * size) / 4);
    }
  });

  it('is packaged where the main process looks for it', () => {
    const builder = parse(readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8')) as {
      extraResources: { from: string; to: string; filter?: string[] }[];
    };
    const entry = builder.extraResources.find((r) => r.to === 'tray');
    expect(entry).toMatchObject({ from: 'resources/tray' });
    for (const icon of icons)
      expect(existsSync(join(desktopDir, entry!.from, icon.file))).toBe(true);
    expect(trayIconPath({ packaged: true, resourcesPath: '/App/Resources', mainDir: '' })).toBe(
      '/App/Resources/tray/trayTemplate.png',
    );
    // In development the main bundle is dist/main.
    const dev = trayIconPath({
      packaged: false,
      resourcesPath: '',
      mainDir: join(desktopDir, 'dist/main'),
    });
    expect(dev).toBe(join(TRAY_DIR, TRAY_ICON_FILE));
  });

  it('shows the pending count beside the icon, and the glyph without one', () => {
    expect(trayTitle(0, true)).toBe('');
    expect(trayTitle(3, true)).toBe('3');
    expect(trayTitle(0, false)).toBe('◉');
    expect(trayTitle(2, false)).toBe('◉ 2');
  });
});
