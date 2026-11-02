import { Resvg } from '@resvg/resvg-js';
import { generate, type AvatarParams } from './generate.js';

// Static PNGs for notifications (plan 13). Node only:
// `@openbots/avatars/png`.

export const PNG_MIN_SIZE = 16;
export const PNG_MAX_SIZE = 1024;

/** Renders the avatar's resting pose as a square PNG `size` px wide. */
export function renderPng(params: AvatarParams, size: number): Buffer {
  const px = Math.min(PNG_MAX_SIZE, Math.max(PNG_MIN_SIZE, Math.round(size)));
  const resvg = new Resvg(generate(params).svg, {
    fitTo: { mode: 'width', value: px },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
