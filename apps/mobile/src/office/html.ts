import type { Bot } from '../screens/data';
import { OFFICE_BUNDLE } from './generated';

// The theme tokens the office reads, from packages/ui's styles.
const LIGHT = `--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--popover:oklch(1 0 0);--popover-foreground:oklch(0.145 0 0);--muted-foreground:oklch(0.556 0 0);--border:oklch(0.922 0 0);--sidebar:oklch(0.985 0 0);--glass-edge:oklch(1 0 0 / 70%);--glass-rim:oklch(0 0 0 / 8%);--glass-shadow:0 12px 36px oklch(0 0 0 / 12%),0 1px 3px oklch(0 0 0 / 8%);color-scheme:light`;
const DARK = `--background:oklch(0.145 0 0);--foreground:oklch(0.985 0 0);--card:oklch(0.205 0 0);--popover:oklch(0.205 0 0);--popover-foreground:oklch(0.985 0 0);--muted-foreground:oklch(0.708 0 0);--border:oklch(1 0 0 / 10%);--sidebar:oklch(0.205 0 0);--glass-edge:oklch(1 0 0 / 18%);--glass-rim:oklch(1 0 0 / 10%);--glass-shadow:0 12px 36px oklch(0 0 0 / 45%),0 1px 3px oklch(0 0 0 / 30%);color-scheme:dark`;
// The few layout utilities the office's markup uses. Its view controls are for a mouse
// and keyboard; on the phone it turns by dragging. Centered on a tall screen, the city
// shows past the drawing, and the ground's colors (office-css.ts) fill in below it.
const BASE = `html,body,#office{margin:0;width:100%;height:100%;overflow:hidden;background:var(--background);color:var(--foreground);font-family:-apple-system,system-ui,sans-serif;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}.fixed{position:fixed}.inset-0{inset:0}.overflow-hidden{overflow:hidden}.absolute{position:absolute}[role=toolbar]{display:none}svg.office{overflow:visible}.office-frame>div.absolute::before{content:'';position:absolute;left:0;right:0;bottom:0;height:40%;background:#d4d9d2}.office-frame[data-time=night]>div.absolute::before{background:#252a3c}`;

/** JSON that is safe inside an inline script. */
export const scriptJSON = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export function officeHTML(bots: readonly Bot[], dark: boolean): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>:root{${dark ? DARK : LIGHT}}${BASE}</style></head><body><div id="office"></div><script>window.__officeBots=${scriptJSON(bots)};${OFFICE_BUNDLE}</script></body></html>`;
}
