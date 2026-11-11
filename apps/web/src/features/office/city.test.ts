import { describe, expect, it } from 'vitest';
import { cityTowers, isDaytime, STREET, towerOpacity } from './city.js';
import { officeLayout } from './layout.js';
import { roomView } from './scene.js';

describe('cityTowers', () => {
  const layout = officeLayout(4);
  const towers = cityTowers(layout);

  it('keeps the office and its street clear', () => {
    expect(towers.length).toBeGreaterThan(20);
    for (const t of towers) {
      const clear =
        t.x + t.w <= -STREET ||
        t.x >= layout.width + STREET ||
        t.y + t.d <= -STREET ||
        t.y >= layout.depth + STREET;
      expect(clear).toBe(true);
    }
  });

  it('mixes kinds of building', () => {
    expect(new Set(towers.map((t) => t.kind)).size).toBeGreaterThanOrEqual(5);
  });

  it('is the same skyline every time', () => {
    expect(cityTowers(layout)).toEqual(towers);
  });

  it('shows only the towers behind the office', () => {
    const toward = roomView(layout, 0).toward;
    const behind = towers.find((t) => t.x + t.w < 0 && t.y + t.d < 0)!;
    const front = towers.find((t) => t.x > layout.width && t.y > layout.depth)!;
    expect(towerOpacity(layout, behind, toward)).toBeGreaterThan(0);
    expect(towerOpacity(layout, front, toward)).toBe(0);
    expect(towerOpacity(layout, front, roomView(layout, 180).toward)).toBeGreaterThan(0);
  });
});

describe('isDaytime', () => {
  it('is day from 7 to 19', () => {
    expect(isDaytime(new Date(2026, 10, 10, 6, 59))).toBe(false);
    expect(isDaytime(new Date(2026, 10, 10, 7, 0))).toBe(true);
    expect(isDaytime(new Date(2026, 10, 10, 18, 59))).toBe(true);
    expect(isDaytime(new Date(2026, 10, 10, 21, 0))).toBe(false);
  });
});
