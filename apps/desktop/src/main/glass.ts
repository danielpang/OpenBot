// Liquid Glass in the main window (macOS 26 and later). Electron has no
// NSGlassEffectView, so the window puts the system's sidebar material behind
// a transparent page and the web app draws its floating sidebar and controls
// over it (apps/web `html[data-glass]`, packages/ui styles.css). Reduce
// Transparency and Increase Contrast reach the material through AppKit and
// the page through CSS media queries.

/** Darwin 25 is macOS 26 (Tahoe), the first with Liquid Glass. */
const FIRST_GLASS_DARWIN = 25;

/** Whether this system draws Liquid Glass: `platform` and `release` as `node:os` reports them. */
export function supportsLiquidGlass(platform: string, release: string): boolean {
  if (platform !== 'darwin') return false;
  const major = Number.parseInt(release.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= FIRST_GLASS_DARWIN;
}

/**
 * The traffic lights inside the floating sidebar: 12px in from its left edge
 * and centered on its 32px top row, which starts 8px down (apps/web sidebar.tsx
 * `TitleBarInset`, packages/ui `--glass-inset`).
 */
export const GLASS_TRAFFIC_LIGHTS = { x: 20, y: 17 };

/**
 * The main window's options for Liquid Glass: the sidebar material behind a
 * clear page, following the window's key state like a native sidebar. A web
 * app without glass styles paints its own opaque background over it, so an
 * older server still looks as before.
 */
export function glassWindowOptions(enabled: boolean): Electron.BrowserWindowConstructorOptions {
  if (!enabled) return {};
  return {
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    trafficLightPosition: GLASS_TRAFFIC_LIGHTS,
  };
}
