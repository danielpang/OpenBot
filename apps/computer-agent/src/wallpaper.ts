import { gradientPng, type Rgb } from './png.js';
import type { Run, RunOptions } from './proc.js';

// K5: the wallpaper shifts through the day, lightest in the morning and
// darkest at night, so the screen reads as the Bot's space. Each hour gets a
// vertical gradient interpolated between these keyframes.

const KEYFRAMES: { hour: number; top: string; bottom: string }[] = [
  { hour: 0, top: '#0b1026', bottom: '#1a1f3d' }, // night
  { hour: 4, top: '#141a3a', bottom: '#2a2350' },
  { hour: 6, top: '#f4a988', bottom: '#ffd9b8' }, // dawn
  { hour: 8, top: '#d6ecff', bottom: '#fff7e8' }, // morning, the lightest
  { hour: 11, top: '#c4e2ff', bottom: '#f3f8ff' },
  { hour: 14, top: '#9fcbf0', bottom: '#e1ecf8' }, // day
  { hour: 17, top: '#e3a77e', bottom: '#f2d3b6' }, // late afternoon
  { hour: 19, top: '#5e437f', bottom: '#c27b70' }, // dusk
  { hour: 21, top: '#1b2150', bottom: '#352f5e' }, // evening
];

const hex = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

export function wallpaperColors(hour: number): { top: Rgb; bottom: Rgb } {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  let i = KEYFRAMES.length - 1;
  while (KEYFRAMES[i]!.hour > h) i--;
  const from = KEYFRAMES[i]!;
  const to = KEYFRAMES[(i + 1) % KEYFRAMES.length]!;
  const span = (to.hour - from.hour + 24) % 24 || 24;
  const t = (h - from.hour) / span;
  return {
    top: mix(hex(from.top), hex(to.top), t),
    bottom: mix(hex(from.bottom), hex(to.bottom), t),
  };
}

/** Relative luminance (0..1) of the gradient's average colour. */
export function wallpaperLuminance(hour: number): number {
  const { top, bottom } = wallpaperColors(hour);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  return (lum(top) + lum(bottom)) / 2;
}

export function msUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setMinutes(60, 0, 0);
  return next.getTime() - now.getTime();
}

export interface WallpaperTarget {
  n: number;
  width: number;
  height: number;
}

// The PNG reaches feh over stdin, written into the screen's own directory
// by the screen's user (S-7): a file the agent wrote, any Bot's command
// could replace, and so put its own words on another Bot's screen.
const SHOW_SCRIPT = 'cat > "$1" && exec feh --no-fehbg --bg-fill "$1"';

export class Wallpaper {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: {
      run: Run;
      targets: () => WallpaperTarget[];
      /** Where screen `t` keeps its wallpaper, and how feh reaches its display. */
      place: (t: WallpaperTarget) => { file: string; x: RunOptions };
      now?: () => Date;
      onError?: (err: unknown) => void;
    },
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Sets the wallpaper for `hour` (default: now) on the given screens. */
  async apply(hour = this.now().getHours(), targets = this.opts.targets()): Promise<number> {
    const { top, bottom } = wallpaperColors(hour);
    for (const t of targets) {
      const { file, x } = this.opts.place(t);
      await this.opts.run('/bin/sh', ['-c', SHOW_SCRIPT, 'sh', file], {
        ...x,
        input: gradientPng(t.width, t.height, top, bottom),
      });
    }
    return hour;
  }

  /** Re-applies at the top of every hour until `stop`. */
  start(): void {
    const tick = () => {
      this.timer = setTimeout(
        () => {
          this.apply().catch((err) => this.opts.onError?.(err));
          tick();
        },
        msUntilNextHour(this.now()) + 1000,
      );
      this.timer.unref();
    };
    this.stop();
    tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
