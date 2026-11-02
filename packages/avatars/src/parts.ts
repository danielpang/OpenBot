// The avatar catalogue (I1). Every avatar is drawn on the same 64-unit grid
// from the same few rules, so variations stay one family:
//
// - The body fills the box from about y 10 to y 57 and x 9 to 55, centred.
// - Eyes sit on one line at y 32: two eyes at x 24 and 40, or one at x 32.
//   Eyes are at least 7 units tall, so they stay readable at 24 px.
// - Lines are at least 2.5 units wide (about 1 px at 24 px).
// - Colours come only from the palette: body, accent (accessories, cheeks),
//   eye (pupils and line work) and sclera. Nothing else adds colour.
// - Accessories hang off fixed anchors (head top, eye line, neck at y 46).

export interface Palette {
  body: string;
  accent: string;
  eye: string;
  sclera: string;
}

export const PALETTES = {
  tangerine: { body: '#F08A3C', accent: '#5B2A86', eye: '#1F1A17', sclera: '#FFFFFF' },
  mint: { body: '#3FBF9B', accent: '#0F4C5C', eye: '#0E1B1A', sclera: '#FFFFFF' },
  sky: { body: '#4A9EF0', accent: '#0F2E66', eye: '#0B1F3A', sclera: '#FFFFFF' },
  grape: { body: '#8A63D2', accent: '#FFE3EC', eye: '#1A1033', sclera: '#FFFFFF' },
  coral: { body: '#EF6F6C', accent: '#2D3047', eye: '#24121A', sclera: '#FFFFFF' },
  lime: { body: '#8CBF3A', accent: '#2F4B7C', eye: '#172208', sclera: '#FFFFFF' },
  rose: { body: '#E56B9F', accent: '#4A1030', eye: '#2A0F1E', sclera: '#FFFFFF' },
  slate: { body: '#6B7F94', accent: '#FFE9CC', eye: '#0D1117', sclera: '#FFFFFF' },
  sun: { body: '#F2B630', accent: '#7A2414', eye: '#2B2118', sclera: '#FFFFFF' },
  teal: { body: '#2A9D8F', accent: '#FFF4D6', eye: '#062421', sclera: '#FFFFFF' },
  cocoa: { body: '#B07454', accent: '#FDF1DE', eye: '#1E0F08', sclera: '#FFFFFF' },
  berry: { body: '#C8457A', accent: '#B5F2E3', eye: '#1C0A12', sclera: '#FFFFFF' },
} as const satisfies Record<string, Palette>;

export type AvatarPalette = keyof typeof PALETTES;
export const AVATAR_PALETTES = Object.keys(PALETTES) as AvatarPalette[];

/** Body outlines. */
export const SHAPES = {
  circle: 'M9 34a23 23 0 1 0 46 0a23 23 0 1 0-46 0Z',
  rounded:
    'M24 12h16a14 14 0 0 1 14 14v16a14 14 0 0 1-14 14H24a14 14 0 0 1-14-14V26a14 14 0 0 1 14-14Z',
  blob: 'M32 11C42 11 50 20 53 32C56 46 47 57 32 57C17 57 8 46 11 32C14 20 22 11 32 11Z',
  bean: 'M30 10C41 9 50 15 54 25C58 36 54 50 43 55C33 60 18 58 12 48C6 38 9 24 16 16C20 12 25 10 30 10Z',
  ghost:
    'M32 10C45 10 54 19 54 32V54C54 56 52 57 50 55L46 52L42 55C40 57 38 57 36 55L32 52L28 55C26 57 24 57 22 55L18 52L14 55C12 57 10 56 10 54V32C10 19 19 10 32 10Z',
} as const;

export type AvatarShape = keyof typeof SHAPES;
export const AVATAR_SHAPES = Object.keys(SHAPES) as AvatarShape[];

/**
 * The bodies a new Bot gets and its owner picks from, named as the landing
 * page names them. The other shapes stay for existing avatars and the app icon.
 */
export const BOT_SHAPES = [
  { shape: 'bean', label: 'Moon' },
  { shape: 'rounded', label: 'Box' },
  { shape: 'blob', label: 'Egg' },
] as const satisfies readonly { shape: AvatarShape; label: string }[];

export type BotShape = (typeof BOT_SHAPES)[number]['shape'];

export const AVATAR_EYES = ['round', 'dot', 'pill', 'sleepy', 'visor', 'cyclops'] as const;
export type AvatarEyes = (typeof AVATAR_EYES)[number];

export const AVATAR_ACCESSORIES = [
  'none',
  'glasses',
  'headphones',
  'antenna',
  'hat',
  'scarf',
] as const;
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];

const EYE_Y = 32;
const PAIR = [24, 40] as const;

/** Rounds to two decimals so the markup is short and identical everywhere. */
const n = (value: number) => Math.round(value * 100) / 100;

const pupil = (x: number, y: number, r: number, p: Palette) =>
  `<g class="ob-pupil"><circle cx="${x}" cy="${y}" r="${r}" fill="${p.eye}"/>` +
  `<circle cx="${n(x + r * 0.35)}" cy="${n(y - r * 0.35)}" r="${n(r * 0.32)}" fill="${p.sclera}"/></g>`;

const eye = (inner: string) => `<g class="ob-eye">${inner}</g>`;

/** Markup for the eyes group; every style keeps the `ob-eye` / `ob-pupil` classes the motion states drive. */
export function eyesMarkup(style: AvatarEyes, p: Palette): string {
  switch (style) {
    case 'round':
      return PAIR.map((x) =>
        eye(
          `<circle cx="${x}" cy="${EYE_Y}" r="6.5" fill="${p.sclera}"/>${pupil(x, EYE_Y + 0.5, 3.4, p)}`,
        ),
      ).join('');
    case 'dot':
      return PAIR.map((x) =>
        eye(
          `<g class="ob-pupil"><ellipse cx="${x}" cy="${EYE_Y}" rx="3.8" ry="4.8" fill="${p.eye}"/>` +
            `<circle cx="${x + 1.3}" cy="${EYE_Y - 1.7}" r="1.3" fill="${p.sclera}"/></g>`,
        ),
      ).join('');
    case 'pill':
      return PAIR.map((x) =>
        eye(
          `<g class="ob-pupil"><rect x="${x - 2.8}" y="${EYE_Y - 6}" width="5.6" height="12" rx="2.8" fill="${p.eye}"/>` +
            `<circle cx="${x + 0.9}" cy="${EYE_Y - 3}" r="1.2" fill="${p.sclera}"/></g>`,
        ),
      ).join('');
    case 'sleepy':
      return PAIR.map((x) =>
        eye(
          `<circle cx="${x}" cy="${EYE_Y}" r="6.5" fill="${p.sclera}"/>${pupil(x, EYE_Y + 2, 3.2, p)}` +
            `<path d="M${x - 7} ${EYE_Y - 0.5}a7 7 0 0 1 14 0Z" fill="${p.body}"/>` +
            `<path d="M${x - 6.5} ${EYE_Y - 0.5}h13" stroke="${p.eye}" stroke-width="2.5" stroke-linecap="round"/>`,
        ),
      ).join('');
    case 'visor':
      return eye(
        `<rect x="14" y="${EYE_Y - 7}" width="36" height="14" rx="7" fill="${p.sclera}"/>` +
          PAIR.map((x) => pupil(x, EYE_Y, 3.8, p)).join(''),
      );
    case 'cyclops':
      return eye(
        `<circle cx="32" cy="${EYE_Y - 1}" r="10" fill="${p.sclera}"/>${pupil(32, EYE_Y - 0.5, 5, p)}`,
      );
  }
}

/** Accessories drawn behind the body. */
export function backMarkup(accessory: AvatarAccessory, p: Palette): string {
  if (accessory !== 'antenna') return '';
  return (
    `<path d="M32 15V6" stroke="${p.eye}" stroke-width="3" stroke-linecap="round"/>` +
    `<circle cx="32" cy="5.5" r="4.5" fill="${p.accent}"/>`
  );
}

/** Accessories drawn over the body and eyes. */
export function frontMarkup(accessory: AvatarAccessory, eyes: AvatarEyes, p: Palette): string {
  const line = `fill="none" stroke="${p.eye}" stroke-width="2.5"`;
  switch (accessory) {
    case 'glasses':
      if (eyes === 'cyclops') {
        return `<circle cx="32" cy="${EYE_Y - 1}" r="12.5" ${line}/><path d="M44.5 ${EYE_Y - 1}H54" ${line}/>`;
      }
      if (eyes === 'visor') {
        return `<rect x="11.5" y="${EYE_Y - 9.5}" width="41" height="19" rx="9.5" ${line}/>`;
      }
      return (
        PAIR.map((x) => `<circle cx="${x}" cy="${EYE_Y}" r="8.5" ${line}/>`).join('') +
        `<path d="M32.5 ${EYE_Y - 1}h-1" ${line}/><path d="M15.5 ${EYE_Y - 2}H10M48.5 ${EYE_Y - 2}H54" ${line}/>`
      );
    case 'headphones':
      return (
        `<path d="M11 33A21 21 0 0 1 53 33" fill="none" stroke="${p.eye}" stroke-width="3.5" stroke-linecap="round"/>` +
        `<rect x="5" y="26" width="10" height="15" rx="4" fill="${p.accent}"/>` +
        `<rect x="49" y="26" width="10" height="15" rx="4" fill="${p.accent}"/>`
      );
    case 'hat':
      return (
        `<path d="M15 21C15 10 22 4 32 4S49 10 49 21Z" fill="${p.accent}"/>` +
        `<rect x="13" y="17" width="38" height="6" rx="3" fill="${p.accent}"/>` +
        `<rect x="13" y="17" width="38" height="6" rx="3" fill="${p.eye}" opacity=".2"/>` +
        `<circle cx="32" cy="4.5" r="3.5" fill="${p.accent}"/>`
      );
    case 'scarf':
      return (
        `<path d="M11 45Q32 53 53 45V51Q32 59 11 51Z" fill="${p.accent}"/>` +
        `<path d="M40 52L43 61H49L46 51Z" fill="${p.accent}"/>`
      );
    case 'none':
    case 'antenna':
      return '';
  }
}
