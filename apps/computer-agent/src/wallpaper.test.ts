import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradientPng } from './png.js';
import { run } from './proc.js';
import { fakeRun, tempHome } from './test-utils.js';
import { msUntilNextHour, Wallpaper, wallpaperColors, wallpaperLuminance } from './wallpaper.js';

const hours = Array.from({ length: 24 }, (_, h) => h);

describe('wallpaper colours (K5)', () => {
  it('is lightest in the morning and darkest at night', () => {
    const lum = hours.map(wallpaperLuminance);
    const brightest = lum.indexOf(Math.max(...lum));
    const darkest = lum.indexOf(Math.min(...lum));
    expect(brightest).toBeGreaterThanOrEqual(7);
    expect(brightest).toBeLessThanOrEqual(11);
    expect([21, 22, 23, 0, 1, 2, 3, 4]).toContain(darkest);
    expect(wallpaperLuminance(9)).toBeGreaterThan(wallpaperLuminance(15));
    expect(wallpaperLuminance(15)).toBeGreaterThan(wallpaperLuminance(20));
    expect(wallpaperLuminance(20)).toBeGreaterThan(wallpaperLuminance(23));
    expect(wallpaperLuminance(9)).toBeGreaterThan(wallpaperLuminance(23) * 5);
  });

  it('changes every hour and wraps around midnight', () => {
    const keys = hours.map((h) => JSON.stringify(wallpaperColors(h)));
    expect(new Set(keys).size).toBe(24);
    expect(wallpaperColors(24)).toEqual(wallpaperColors(0));
    expect(wallpaperColors(-1)).toEqual(wallpaperColors(23));
  });
});

describe('gradientPng', () => {
  it('encodes a valid RGB PNG of the requested size', () => {
    const png = gradientPng(4, 3, [0, 0, 0], [200, 100, 50]);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.subarray(12, 16).toString()).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString()).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(3 * (1 + 4 * 3));
    expect([...raw.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...raw.subarray(26, 30)]).toEqual([0, 200, 100, 50]);
    expect(png.subarray(-8, -4).toString()).toBe('IEND');
  });
});

describe('Wallpaper', () => {
  afterEach(() => vi.useRealTimers());

  it('counts down to the next full hour', () => {
    expect(msUntilNextHour(new Date(2026, 0, 1, 9, 59, 30))).toBe(30_000);
    expect(msUntilNextHour(new Date(2026, 0, 1, 23, 0, 0))).toBe(3_600_000);
  });

  it('re-applies at the top of every hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 6, 59, 0));
    const wallpaper = new Wallpaper({
      run: fakeRun().run,
      targets: () => [],
      place: () => ({ file: '/unused', x: {} }),
    });
    const hours: number[] = [];
    vi.spyOn(wallpaper, 'apply').mockImplementation(async () => {
      hours.push(new Date().getHours());
      return 0;
    });
    wallpaper.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hours).toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(hours).toEqual([7]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(hours).toEqual([7, 8]);
    wallpaper.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(hours).toEqual([7, 8]);
  });

  it('hands each screen a PNG at its size, written and shown by the screen user (S-7)', async () => {
    const fake = fakeRun();
    const wallpaper = new Wallpaper({
      run: fake.run,
      targets: () => [
        { n: 0, width: 8, height: 6 },
        { n: 1, width: 4, height: 4 },
      ],
      place: (t) => ({
        file: `/run/screen-${t.n}/wallpaper.png`,
        x: { env: { DISPLAY: `:${10 + t.n}` }, user: { uid: 2000 + t.n, gid: 2000 + t.n } },
      }),
    });
    expect(await wallpaper.apply(21)).toBe(21);
    expect(fake.calls.map((c) => [c.command, c.args.at(-1), c.env?.DISPLAY, c.user?.uid])).toEqual([
      ['/bin/sh', '/run/screen-0/wallpaper.png', ':10', 2000],
      ['/bin/sh', '/run/screen-1/wallpaper.png', ':11', 2001],
    ]);
    const png = Buffer.from(fake.calls[0]!.input as Uint8Array);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([8, 6]);
  });

  it('writes the PNG from stdin and then runs feh on it', async () => {
    const dir = await tempHome();
    const file = path.join(dir, 'wallpaper.png');
    // A feh that records what it was asked to show.
    await writeFile(path.join(dir, 'feh'), `#!/bin/sh\necho "$@" > ${dir}/feh.args\n`, {
      mode: 0o755,
    });
    const wallpaper = new Wallpaper({
      run,
      targets: () => [{ n: 0, width: 4, height: 2 }],
      place: () => ({ file, x: { env: { PATH: `${dir}:${process.env.PATH}` } } }),
    });
    await wallpaper.apply(9);
    expect((await readFile(file)).subarray(1, 4).toString()).toBe('PNG');
    expect((await readFile(path.join(dir, 'feh.args'), 'utf8')).trim()).toBe(
      `--no-fehbg --bg-fill ${file}`,
    );
  });
});
