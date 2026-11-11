import { describe, expect, it } from 'vitest';
import { officeLayout } from './layout.js';
import { paintOrder, roomView, type Box } from './scene.js';

const box = (
  name: string,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
) => ({
  name,
  box: { x0, y0, z0, x1, y1, z1 } satisfies Box,
});

describe('roomView', () => {
  const layout = officeLayout(3);

  it('keeps the drawing the same size at every angle', () => {
    const sizes = [0, 37, 90, 200].map((a) => {
      const v = roomView(layout, a);
      return [v.width, v.height];
    });
    expect(new Set(sizes.map((s) => s.join()))).toHaveLength(1);
  });

  it('keeps every corner of the room inside the drawing as it turns', () => {
    for (let angle = 0; angle < 360; angle += 15) {
      const v = roomView(layout, angle);
      for (const [x, y] of [
        [0, 0],
        [layout.width, 0],
        [0, layout.depth],
        [layout.width, layout.depth],
      ] as const) {
        const [sx, sy] = v.project(x, y);
        expect(sx).toBeGreaterThanOrEqual(0);
        expect(sx).toBeLessThanOrEqual(v.width);
        expect(sy).toBeLessThanOrEqual(v.height);
      }
    }
  });

  it('shows the faces turned to the viewer', () => {
    expect(roomView(layout, 0).faces([0, 1])).toBe(true);
    expect(roomView(layout, 0).faces([0, -1])).toBe(false);
    expect(roomView(layout, 180).faces([0, 1])).toBe(false);
  });
});

describe('paintOrder', () => {
  const scene = [
    box('mug', 50, 50, 10, 55, 55, 15),
    box('front', 0, 100, 0, 10, 110, 10),
    box('desk', 0, 0, 5, 100, 70, 10),
    box('leg', 5, 5, 0, 10, 10, 5),
    box('wall', 0, -5, 0, 100, 0, 50),
  ];

  it('paints far boxes first and stacked boxes after what they sit on', () => {
    const order = paintOrder(scene, roomView(officeLayout(3), 0).toward).map((i) => i.name);
    expect(order.indexOf('wall')).toBeLessThan(order.indexOf('desk'));
    expect(order.indexOf('leg')).toBeLessThan(order.indexOf('desk'));
    expect(order.indexOf('desk')).toBeLessThan(order.indexOf('mug'));
    expect(order.indexOf('desk')).toBeLessThan(order.indexOf('front'));
  });

  it('flips front and back when the room turns around', () => {
    const order = paintOrder(scene, roomView(officeLayout(3), 180).toward).map((i) => i.name);
    expect(order.indexOf('front')).toBeLessThan(order.indexOf('desk'));
    expect(order.indexOf('desk')).toBeLessThan(order.indexOf('wall'));
  });
});
