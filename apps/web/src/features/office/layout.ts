// The home page's office (openbots-www's IsometricOffice, grown to fit the
// user's Bots): one desk per Bot along the back wall, more rows as the team
// grows, and a lounge at the front with a water cooler and a coffee table.
// Everything here is floor geometry, in the room's own units; office.tsx
// projects it isometrically.

export type FloorPoint = [number, number];

/** A floor rectangle: left, top, right, bottom. */
export type Rect = [number, number, number, number];

export const DESKS_PER_ROW = 4;
const DESK_X = 50;
const DESK_Y = 64;
const DESK_SPACING = 185;
const ROW_SPACING = 170;
const LOUNGE_DEPTH = 180;
const MIN_DESKS = 4;

export interface OfficeLayout {
  width: number;
  depth: number;
  /** Each desk's back left corner; one per Bot, at least three. */
  desks: FloorPoint[];
  /** Where each desk's Bot stands, in front of it. */
  seats: FloorPoint[];
  cooler: FloorPoint;
  coffeeTable: FloorPoint;
  /** The sofa's seat, facing the coffee table across the rug. */
  sofa: FloorPoint;
  /** The rug under the lounge: left, top, right, bottom. */
  rug: Rect;
  plants: FloorPoint[];
  /** Where an idle Bot goes for a break. */
  breakSpots: FloorPoint[];
  /** Furniture footprints plus room for a Bot's body. */
  obstacles: Rect[];
}

export function officeLayout(bots: number): OfficeLayout {
  const desksCount = Math.max(MIN_DESKS, bots);
  const columns = Math.min(DESKS_PER_ROW, desksCount);
  const rows = Math.ceil(desksCount / DESKS_PER_ROW);
  const width = DESK_X + columns * DESK_SPACING - 5;
  const depth = DESK_Y + rows * ROW_SPACING + LOUNGE_DEPTH;
  const desks: FloorPoint[] = Array.from({ length: desksCount }, (_, i) => [
    DESK_X + (i % DESKS_PER_ROW) * DESK_SPACING,
    DESK_Y + Math.floor(i / DESKS_PER_ROW) * ROW_SPACING,
  ]);
  const cooler: FloorPoint = [125, depth - 35];
  const coffeeTable: FloorPoint = [width - 150, depth - 95];
  const sofa: FloorPoint = [width - 212, depth - 103];
  const rug: Rect = [width - 245, depth - 130, width - 40, depth - 20];
  const plants: FloorPoint[] = [
    [38, depth - 47],
    [width - 45, 35],
  ];
  return {
    width,
    depth,
    desks,
    seats: desks.map(([x, y]) => [x + 55, y + 116]),
    cooler,
    coffeeTable,
    sofa,
    rug,
    plants,
    breakSpots: [
      [140, depth - 75],
      [width - 140, depth - 150],
      [Math.round(width / 2), depth - 60],
    ],
    obstacles: [
      ...desks.map(([x, y]): Rect => [x - 20, y - 20, x + 132, y + 100]),
      [105, depth - 55, 174, depth],
      [width - 245, depth - 125, width, depth],
      [10, depth - 75, 65, depth - 15],
      [width - 70, 10, width - 20, 65],
    ],
  };
}

export function isOpen(layout: OfficeLayout, [x, y]: FloorPoint): boolean {
  return (
    x >= 20 &&
    x <= layout.width - 20 &&
    y >= 20 &&
    y <= layout.depth - 20 &&
    !layout.obstacles.some(([l, t, r, b]) => x >= l && x <= r && y >= t && y <= b)
  );
}

function clearWalk(layout: OfficeLayout, from: FloorPoint, to: FloorPoint): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isOpen(layout, [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]))
      return false;
  }
  return true;
}

/** The open floor point on the 10 unit grid nearest to `p`. */
function nearestOpen(layout: OfficeLayout, [x, y]: FloorPoint): FloorPoint {
  let best: FloorPoint | null = null;
  let bestDistance = Infinity;
  for (let gx = 20; gx <= layout.width - 20; gx += 10) {
    for (let gy = 20; gy <= layout.depth - 20; gy += 10) {
      const distance = Math.hypot(gx - x, gy - y);
      if (distance < bestDistance && isOpen(layout, [gx, gy])) {
        best = [gx, gy];
        bestDistance = distance;
      }
    }
  }
  return best ?? [x, y];
}

/** Drops the corners a straight walk can cut. */
function smooth(layout: OfficeLayout, path: FloorPoint[]): FloorPoint[] {
  const result = [path[0]!];
  for (let i = 0; i < path.length - 1;) {
    let next = path.length - 1;
    while (next > i + 1 && !clearWalk(layout, path[i]!, path[next]!)) next--;
    result.push(path[next]!);
    i = next;
  }
  return result;
}

/** A walk from `from` to `to` around the furniture: a breadth first search on a 10 unit grid. */
export function officeRoute(layout: OfficeLayout, from: FloorPoint, to: FloorPoint): FloorPoint[] {
  const start = nearestOpen(layout, from);
  const end = nearestOpen(layout, to);
  const key = (p: FloorPoint) => `${p[0]},${p[1]}`;
  const parents = new Map<string, FloorPoint | null>([[key(start), null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (key(p) === key(end)) {
      const path: FloorPoint[] = [];
      for (let at: FloorPoint | null = p; at; at = parents.get(key(at)) ?? null) path.push(at);
      return smooth(layout, path.reverse());
    }
    for (const [dx, dy] of [
      [10, 0],
      [-10, 0],
      [0, 10],
      [0, -10],
    ] as const) {
      const next: FloorPoint = [p[0] + dx, p[1] + dy];
      if (!parents.has(key(next)) && clearWalk(layout, p, next)) {
        parents.set(key(next), p);
        queue.push(next);
      }
    }
  }
  return [start];
}

/** Each point's share of the route's length, from 0 at the start to 1 at the end. */
export function routeProgress(route: readonly FloorPoint[]): number[] {
  let distance = 0;
  const lengths = route.map((p, i) => {
    const previous = route[i - 1];
    if (previous) distance += Math.hypot(p[0] - previous[0], p[1] - previous[1]);
    return distance;
  });
  return lengths.map((length) => length / (distance || 1));
}
