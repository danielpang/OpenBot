// The downtown around the office: blocks of towers on the room's own grid, so
// their walls run along the office's edges and turn with it. Seeded, so the
// skyline is the same on every visit. Only the towers behind the office from
// the viewer's side are drawn; they fade in as the office turns.

import type { OfficeLayout } from './layout.js';
import type { FloorPoint } from './layout.js';

/**
 * The kinds of building downtown: a plain block, a setback tower that steps
 * in as it rises, a glass tower, a slim spire with an antenna, a tower with a
 * pyramid roof, and a brick low rise with a water tank on the roof.
 */
export type TowerKind = 'block' | 'setback' | 'glass' | 'spire' | 'pyramid' | 'lowrise';

const KINDS: { kind: TowerKind; weight: number }[] = [
  { kind: 'block', weight: 3 },
  { kind: 'setback', weight: 2 },
  { kind: 'glass', weight: 2 },
  { kind: 'spire', weight: 1 },
  { kind: 'pyramid', weight: 1 },
  { kind: 'lowrise', weight: 2 },
];
const TOTAL_WEIGHT = KINDS.reduce((sum, k) => sum + k.weight, 0);

function pickKind(roll: number): TowerKind {
  let left = roll * TOTAL_WEIGHT;
  for (const { kind, weight } of KINDS) {
    left -= weight;
    if (left < 0) return kind;
  }
  return 'block';
}

export interface Tower {
  kind: TowerKind;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  /** Which of the tower palettes it uses. */
  tone: number;
  /** The share of its windows lit at night, 0 to 1. */
  lit: number;
}

/** The street between the office and the first towers. */
export const STREET = 60;
const BLOCK = 130;
const RINGS = 3;

/** Deterministic random numbers in [0, 1). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cityTowers(layout: OfficeLayout): Tower[] {
  const { width: W, depth: D } = layout;
  const random = seeded(7);
  const towers: Tower[] = [];
  const start = -(STREET + RINGS * BLOCK);
  const columns = Math.ceil((W + 2 * (STREET + RINGS * BLOCK)) / BLOCK);
  const rows = Math.ceil((D + 2 * (STREET + RINGS * BLOCK)) / BLOCK);
  for (let c = 0; c < columns; c++) {
    for (let r = 0; r < rows; r++) {
      const x0 = start + c * BLOCK;
      const y0 = start + r * BLOCK;
      const x1 = x0 + BLOCK;
      const y1 = y0 + BLOCK;
      // Leave the office and its street clear.
      if (x1 > -STREET && x0 < W + STREET && y1 > -STREET && y0 < D + STREET) continue;
      const kind = pickKind(random());
      // Spires are slim; low rises fill their lot.
      const inset =
        kind === 'spire' ? 30 + random() * 8 : kind === 'lowrise' ? 10 : 14 + random() * 10;
      const w = BLOCK - inset * 2 - random() * 18;
      const d = BLOCK - inset * 2 - random() * 18;
      // How many blocks out from the office: farther towers rise higher.
      const ring = Math.max(
        Math.ceil(Math.max(-STREET - x1, x0 - W - STREET, 0) / BLOCK),
        Math.ceil(Math.max(-STREET - y1, y0 - D - STREET, 0) / BLOCK),
      );
      const height = 60 + ring * 30 + random() * 95;
      towers.push({
        kind,
        x: x0 + inset,
        y: y0 + inset,
        w,
        d,
        h: kind === 'lowrise' ? 40 + random() * 40 : kind === 'spire' ? height * 1.3 : height,
        tone: Math.floor(random() * 3),
        lit: 0.35 + random() * 0.5,
      });
    }
  }
  return towers;
}

/**
 * How much of a tower shows from here: none beside or in front of the office,
 * fading in behind it. `toward` is the floor direction toward the viewer.
 */
export function towerOpacity(layout: OfficeLayout, tower: Tower, toward: FloorPoint): number {
  const cx = tower.x + tower.w / 2 - layout.width / 2;
  const cy = tower.y + tower.d / 2 - layout.depth / 2;
  const reach = Math.hypot(layout.width, layout.depth) / 2;
  const depth = (cx * toward[0] + cy * toward[1]) / Math.hypot(toward[0], toward[1]);
  const t = (-depth - reach * 0.35) / (reach * 0.35);
  return Math.max(0, Math.min(1, t));
}

/** Day from 7 in the morning until 7 in the evening, by this computer's clock. */
export function isDaytime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 7 && hour < 19;
}
