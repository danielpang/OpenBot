import type { Avatar } from '@openbots/shared';
import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_PALETTES,
  AVATAR_SHAPES,
  BOT_SHAPES,
  PALETTES,
  SHAPES,
  backMarkup,
  eyesMarkup,
  frontMarkup,
  type AvatarAccessory,
  type AvatarEyes,
  type AvatarPalette,
  type AvatarShape,
  type Palette,
} from './parts.js';
import { createRandom, pick } from './random.js';

/** The `generated` avatar stored on a Bot (`bots.avatar`). */
export type GeneratedAvatar = Extract<Avatar, { kind: 'generated' }>;

/** Generator input: a seed plus optional pinned parts; `kind` may be left off. */
export type AvatarParams = Omit<GeneratedAvatar, 'kind'> & { kind?: 'generated' };

export interface AvatarParts {
  shape: AvatarShape;
  palette: AvatarPalette;
  eyes: AvatarEyes;
  accessory: AvatarAccessory;
}

export interface AvatarDrawing extends AvatarParts {
  seed: string;
  colors: Palette;
  /** Static SVG markup; the React component and the PNG renderer both draw this. */
  svg: string;
}

const known = <T extends string>(items: readonly T[], value: string | undefined): T | undefined =>
  items.find((item) => item === value);

/**
 * The parts a seed resolves to. Every part draws from the seed in a fixed
 * order whether or not it is pinned, so pinning the shape never changes the
 * palette. Unknown pinned names (an older catalogue) fall back to the seed.
 */
export function resolveParts(params: AvatarParams): AvatarParts {
  const random = createRandom(params.seed);
  const shape = pick(random, AVATAR_SHAPES);
  const palette = pick(random, AVATAR_PALETTES);
  const eyes = pick(random, AVATAR_EYES);
  const accessory = pick(random, AVATAR_ACCESSORIES);
  return {
    shape: known(AVATAR_SHAPES, params.shape) ?? shape,
    palette: known(AVATAR_PALETTES, params.palette) ?? palette,
    eyes: known(AVATAR_EYES, params.eyes) ?? eyes,
    accessory: known(AVATAR_ACCESSORIES, params.accessory) ?? accessory,
  };
}

export const partsKey = (parts: AvatarParts) =>
  `${parts.shape}/${parts.palette}/${parts.eyes}/${parts.accessory}`;

/** Deterministic: the same params always give the same drawing, byte for byte. */
export function generate(params: AvatarParams): AvatarDrawing {
  const parts = resolveParts(params);
  const colors: Palette = PALETTES[parts.palette];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="ob-svg">' +
    '<g class="ob-figure">' +
    backMarkup(parts.accessory, colors) +
    `<path class="ob-body" d="${SHAPES[parts.shape]}" fill="${colors.body}"/>` +
    `<ellipse cx="23" cy="20" rx="7" ry="4" fill="#FFFFFF" opacity=".18"/>` +
    `<g fill="${colors.accent}" opacity=".55"><ellipse cx="17" cy="41" rx="3.5" ry="2"/><ellipse cx="47" cy="41" rx="3.5" ry="2"/></g>` +
    `<g class="ob-eyes">${eyesMarkup(parts.eyes, colors)}</g>` +
    frontMarkup(parts.accessory, parts.eyes, colors) +
    '</g></svg>';
  return { seed: params.seed, ...parts, colors, svg };
}

/**
 * New params for the editor's Shuffle: a fresh seed derived from `seed`, so
 * repeated shuffles walk a reproducible chain. The result never repeats the
 * parts of `seed` itself or of anything in `taken` (the rest of the roster),
 * which is how a roster avoids look-alikes. Parts in `pinned` (the shape the
 * owner chose) stay pinned in the result; the rest are reshuffled.
 */
export function shuffle(
  seed: string,
  taken: readonly AvatarParams[] = [],
  pinned: Partial<Pick<AvatarParams, 'shape' | 'palette' | 'eyes' | 'accessory'>> = {},
): GeneratedAvatar {
  const random = createRandom(`${seed}:shuffle`);
  const avoid = new Set(
    [{ seed, ...pinned }, ...taken].map((params) => partsKey(resolveParts(params))),
  );
  let next = seed;
  for (let attempt = 0; attempt < 256; attempt++) {
    next =
      Math.floor(random() * 2 ** 32).toString(36) + Math.floor(random() * 2 ** 32).toString(36);
    if (!avoid.has(partsKey(resolveParts({ seed: next, ...pinned })))) break;
  }
  return { kind: 'generated', seed: next, ...pinned };
}

/**
 * A new Bot's avatar: one of the three Bot shapes (Moon, Box, Egg), picked
 * from `seed` and pinned, with the other parts shuffled away from `taken`.
 */
export function newBotAvatar(seed: string, taken: readonly AvatarParams[] = []): GeneratedAvatar {
  const shape = pick(createRandom(`${seed}:shape`), BOT_SHAPES).shape;
  return shuffle(seed, taken, { shape });
}
