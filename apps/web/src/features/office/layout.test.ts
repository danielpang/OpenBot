import { describe, expect, it } from 'vitest';
import { DESKS_PER_ROW, isOpen, officeLayout, officeRoute, routeProgress } from './layout.js';

describe('officeLayout', () => {
  it('keeps a full row of desks for a small team, with room for the next Bot', () => {
    const layout = officeLayout(1);
    expect(layout.desks).toHaveLength(DESKS_PER_ROW);
  });

  it('gives every Bot a desk and starts a new row after four', () => {
    const layout = officeLayout(DESKS_PER_ROW + 2);
    expect(layout.desks).toHaveLength(6);
    expect(new Set(layout.desks.map(([, y]) => y)).size).toBe(2);
    expect(officeLayout(9).depth).toBeGreaterThan(layout.depth);
  });

  it('seats and break spots stand on open floor', () => {
    for (const bots of [1, 3, 5, 9]) {
      const layout = officeLayout(bots);
      for (const p of [...layout.seats, ...layout.breakSpots]) expect(isOpen(layout, p)).toBe(true);
    }
  });
});

describe('officeRoute', () => {
  it('walks from a desk to the cooler without crossing furniture', () => {
    const layout = officeLayout(6);
    const route = officeRoute(layout, layout.seats[5]!, layout.breakSpots[0]!);
    expect(route.length).toBeGreaterThan(1);
    for (let i = 1; i < route.length; i++) {
      const [a, b] = [route[i - 1]!, route[i]!];
      for (let t = 0; t <= 1; t += 0.05)
        expect(isOpen(layout, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])).toBe(true);
    }
  });

  it('measures progress along the route', () => {
    expect(
      routeProgress([
        [0, 0],
        [10, 0],
        [10, 30],
      ]),
    ).toEqual([0, 0.25, 1]);
  });
});
