// Turning the office freely and drawing it back to front. The room turns
// about its middle by any angle; everything keeps its own floor coordinates
// and the view projects them. Boxes are painted so that nothing is drawn over
// a box in front of it: a box is behind another when a gap along one of the
// room's axes separates them on the side away from the viewer, or it is below.

import type { FloorPoint, OfficeLayout } from './layout.js';

const PX = 0.98;
const PY = 0.28;
/** Height of the walls; the drawing leaves room above the floor for them. */
export const WALL = 130;

export interface View {
  /** Degrees about the room's middle; 0 is the landing page's view. */
  angle: number;
  /** The floor direction toward the viewer, in the room's own coordinates. */
  toward: FloorPoint;
  /** A point of the room on the drawing. */
  project(x: number, y: number, z?: number): [number, number];
  /** Whether a face looking along `normal` faces the viewer. */
  faces(normal: FloorPoint): boolean;
  /** The drawing's size, the same at every angle. */
  width: number;
  height: number;
}

export function roomView(layout: OfficeLayout, angle: number): View {
  const { width: W, depth: D } = layout;
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // Turned, a point of the floor is at most this far from the middle along x'-y' or x'+y'.
  const reach = Math.hypot(W, D) / Math.SQRT2;
  const ox = reach * PX + 30;
  const oy = WALL + 30 + reach * PY;
  const toward: FloorPoint = [cos + sin, cos - sin];
  return {
    angle,
    toward,
    project(x, y, z = 0) {
      const dx = x - W / 2;
      const dy = y - D / 2;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      return [ox + (rx - ry) * PX, oy + (rx + ry) * PY - z];
    },
    faces([nx, ny]) {
      return nx * toward[0] + ny * toward[1] > 1e-6;
    },
    width: 2 * ox,
    height: oy + reach * PY + 40,
  };
}

/** An upright box in the room's own coordinates. */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

const EPSILON = 0.01;

function behind(a: Box, b: Box, [tx, ty]: FloorPoint): boolean {
  return (
    (tx > EPSILON && a.x1 <= b.x0 + EPSILON) ||
    (tx < -EPSILON && b.x1 <= a.x0 + EPSILON) ||
    (ty > EPSILON && a.y1 <= b.y0 + EPSILON) ||
    (ty < -EPSILON && b.y1 <= a.y0 + EPSILON) ||
    a.z1 <= b.z0 + EPSILON
  );
}

/** `items` back to front for a viewer looking from `toward`. */
export function paintOrder<T extends { box: Box }>(items: readonly T[], toward: FloorPoint): T[] {
  const n = items.length;
  const depth = (b: Box) =>
    ((b.x0 + b.x1) * toward[0] + (b.y0 + b.y1) * toward[1]) / 2 + (b.z0 + b.z1) / 2;
  const after: number[][] = Array.from({ length: n }, () => []);
  const waiting = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ab = behind(items[i]!.box, items[j]!.box, toward);
      const ba = behind(items[j]!.box, items[i]!.box, toward);
      if (ab && !ba) {
        after[i]!.push(j);
        waiting[j]!++;
      } else if (ba && !ab) {
        after[j]!.push(i);
        waiting[i]!++;
      }
    }
  }
  const nearer = (x: number, y: number) => depth(items[x]!.box) - depth(items[y]!.box);
  const done = new Array<boolean>(n).fill(false);
  const ready = items.map((_, i) => i).filter((i) => waiting[i] === 0);
  const order: number[] = [];
  while (order.length < n) {
    if (!ready.length) {
      // A cycle (boxes that overlap): take the farthest one left and go on.
      ready.push(
        items
          .map((_, i) => i)
          .filter((i) => !done[i])
          .sort(nearer)[0]!,
      );
    }
    ready.sort(nearer);
    const i = ready.shift()!;
    if (done[i]) continue;
    done[i] = true;
    order.push(i);
    for (const j of after[i]!) if (--waiting[j]! <= 0 && !done[j]) ready.push(j);
  }
  return order.map((i) => items[i]!);
}
