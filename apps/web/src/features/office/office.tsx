import { AVATAR_CSS, generate, type AvatarParams, type AvatarState } from '@openbots/avatars';
import { defaultFileUrl } from '@openbots/avatars/react';
import { cn } from '@openbots/ui';
import { useNavigate } from '@tanstack/react-router';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { Bot } from '../bots/queries.js';
import {
  officeLayout,
  officeRoute,
  routeProgress,
  type FloorPoint,
  type OfficeLayout,
} from './layout.js';
import { cityTowers, isDaytime, STREET, towerOpacity, type Tower } from './city.js';
import { OFFICE_CSS } from './office-css.js';
import { paintOrder, roomView, WALL, type Box, type View } from './scene.js';

// The home page's office (openbots-www's hero, with the user's own Bots): each
// Bot at its desk with its avatar, name and live state. Busy Bots stay at their
// desks and say what they are doing; idle ones take turns walking to the
// cooler or the lounge. A Bot waiting on the user says so until it is
// answered. Clicking a Bot opens its chat.
//
// Dragging turns the office freely; Shift+drag, a right drag or a two finger
// scroll moves it; pinch or Ctrl+scroll zooms. The toolbar and keys do the
// same in steps: [ and ] turn, + and - zoom, 0 resets.

/** One loop of the office, in seconds. */
const WALK_PERIOD = 36;
/** How long each Bot's speech bubble shows in turn, in seconds. */
const SAY_SECONDS = 5;
const MAX_ZOOM = 3;
/** Degrees the office turns per pixel dragged. */
const TURN_PER_PIXEL = 0.4;
/** The toolbar's and the keys' turn. */
const TURN_STEP = 45;

const corners = (view: View, points: number[][]) =>
  points.map(([x = 0, y = 0, z = 0]) => view.project(x, y, z).join(',')).join(' ');

/** A box's faces that look toward the viewer, then its top. */
function Faces({
  view,
  box,
  tone,
  children,
  decorate,
}: {
  view: View;
  box: Box;
  tone: string;
  children?: ReactNode;
  /** Drawn over each visible side, from one bottom corner `a` to the other `b`. */
  decorate?: (a: FloorPoint, b: FloorPoint) => ReactNode;
}) {
  const { x0, y0, z0, x1, y1, z1 } = box;
  const sides: { normal: FloorPoint; ends: [number, number, number, number]; shade: string }[] = [
    { normal: [0, 1], ends: [x0, y1, x1, y1], shade: 'office-left' },
    { normal: [1, 0], ends: [x1, y0, x1, y1], shade: 'office-right' },
    { normal: [0, -1], ends: [x0, y0, x1, y0], shade: 'office-right' },
    { normal: [-1, 0], ends: [x0, y0, x0, y1], shade: 'office-left' },
  ];
  return (
    <g className={`office-block office-${tone}`} strokeLinejoin="round">
      {sides.map(({ normal, ends: [ax, ay, bx, by], shade }) =>
        view.faces(normal) ? (
          <g key={normal.join()}>
            <polygon
              className={shade}
              points={corners(view, [
                [ax, ay, z0],
                [bx, by, z0],
                [bx, by, z1],
                [ax, ay, z1],
              ])}
            />
            {decorate?.([ax, ay], [bx, by])}
          </g>
        ) : null,
      )}
      <polygon
        className="office-top"
        points={corners(view, [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ])}
      />
      {children}
    </g>
  );
}

type Windows = 'rows' | 'columns' | 'none';

/** One box of a building, with how its windows are drawn. */
function TowerPart({
  view,
  box,
  tone,
  windows,
  dash,
}: {
  view: View;
  box: Box;
  tone: string;
  windows: Windows;
  dash: string;
}) {
  return (
    <Faces
      view={view}
      box={box}
      tone={`tower ${tone}`}
      decorate={([ax, ay], [bx, by]) => {
        if (windows === 'none') return null;
        const length = Math.hypot(bx - ax, by - ay) || 1;
        const [ux, uy] = [(bx - ax) / length, (by - ay) / length];
        if (windows === 'columns') {
          // A glass curtain wall: mullions from bottom to top.
          const lines: ReactNode[] = [];
          for (let t = 7; t < length - 3; t += 9) {
            const [x1, y1] = view.project(ax + ux * t, ay + uy * t, box.z0 + 4);
            const [x2, y2] = view.project(ax + ux * t, ay + uy * t, box.z1 - 4);
            lines.push(
              <line key={t} className="office-mullions" x1={x1} y1={y1} x2={x2} y2={y2} />,
            );
          }
          return lines;
        }
        const floors: number[] = [];
        for (let z = box.z0 + 14; z < box.z1 - 8; z += 18) floors.push(z);
        return floors.map((z) => {
          const [x1, y1] = view.project(ax + ux * 7, ay + uy * 7, z);
          const [x2, y2] = view.project(bx - ux * 7, by - uy * 7, z);
          return (
            <line
              key={z}
              className="office-windows"
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeDasharray={dash}
            />
          );
        });
      }}
    />
  );
}

/** A pyramid roof on `box`'s top: the sides that face the viewer. */
function PyramidRoof({ view, box, rise }: { view: View; box: Box; rise: number }) {
  const { x0, y0, x1, y1, z1 } = box;
  const apex = view.project((x0 + x1) / 2, (y0 + y1) / 2, z1 + rise).join(',');
  const sides: { normal: FloorPoint; a: FloorPoint; b: FloorPoint; shade: string }[] = [
    { normal: [0, 1], a: [x0, y1], b: [x1, y1], shade: 'office-left' },
    { normal: [1, 0], a: [x1, y0], b: [x1, y1], shade: 'office-right' },
    { normal: [0, -1], a: [x0, y0], b: [x1, y0], shade: 'office-right' },
    { normal: [-1, 0], a: [x0, y0], b: [x0, y1], shade: 'office-left' },
  ];
  // Back faces first, so the front ones cover them.
  return (
    <g className="office-block office-tower office-roof">
      {[false, true].flatMap((front) =>
        sides
          .filter((side) => view.faces(side.normal) === front)
          .map(({ a, b, shade, normal }) => (
            <polygon
              key={normal.join()}
              className={shade}
              points={`${view.project(a[0], a[1], z1).join(',')} ${view.project(b[0], b[1], z1).join(',')} ${apex}`}
            />
          )),
      )}
    </g>
  );
}

/** A downtown building of its kind, lit at night. */
function TowerNode({ view, tower, opacity }: { view: View; tower: Tower; opacity: number }) {
  const { x, y, w, d, h, kind } = tower;
  const tone = `office-tower-${tower.tone}`;
  const dash = ['7 5', '5 8', '9 4'][tower.tone]!;
  const box = (inset: number, z0: number, z1: number): Box => ({
    x0: x + inset,
    y0: y + inset,
    z0,
    x1: x + w - inset,
    y1: y + d - inset,
    z1,
  });
  const part = (key: string, b: Box, t: string, windows: Windows) => (
    <TowerPart key={key} view={view} box={b} tone={t} windows={windows} dash={dash} />
  );
  let parts: ReactNode[];
  switch (kind) {
    case 'setback':
      parts = [
        part('base', box(0, 0, h * 0.55), tone, 'rows'),
        part('middle', box(Math.min(w, d) * 0.12, h * 0.55, h * 0.8), tone, 'rows'),
        part('top', box(Math.min(w, d) * 0.24, h * 0.8, h), tone, 'rows'),
      ];
      break;
    case 'glass':
      parts = [
        part('glass', box(0, 0, h), 'office-glass', 'columns'),
        part('crown', box(4, h, h + 6), 'office-glass', 'none'),
      ];
      break;
    case 'spire': {
      const cx = x + w / 2;
      const cy = y + d / 2;
      parts = [
        part('shaft', box(0, 0, h), tone, 'rows'),
        part('cap', box(Math.min(w, d) * 0.2, h, h + 14), tone, 'none'),
        part(
          'antenna',
          { x0: cx - 1.5, y0: cy - 1.5, z0: h + 14, x1: cx + 1.5, y1: cy + 1.5, z1: h + 64 },
          'office-antenna',
          'none',
        ),
      ];
      break;
    }
    case 'pyramid':
      parts = [
        part('body', box(0, 0, h), tone, 'rows'),
        <PyramidRoof key="roof" view={view} box={box(0, 0, h)} rise={Math.min(w, d) * 0.45} />,
      ];
      break;
    case 'lowrise': {
      const tx = x + w * 0.62;
      const ty = y + d * 0.2;
      parts = [
        part('body', box(0, 0, h), 'office-brick', 'rows'),
        part('ledge', box(-2, h, h + 4), 'office-brick', 'none'),
        part(
          'ac',
          { x0: x + 10, y0: y + d - 26, z0: h + 4, x1: x + 30, y1: y + d - 12, z1: h + 12 },
          'office-unit',
          'none',
        ),
        ...[
          [0, 0],
          [14, 0],
          [0, 14],
          [14, 14],
        ].map(([dx = 0, dy = 0], i) =>
          part(
            `leg${i}`,
            { x0: tx + dx, y0: ty + dy, z0: h + 4, x1: tx + dx + 2, y1: ty + dy + 2, z1: h + 16 },
            'office-tank',
            'none',
          ),
        ),
        part(
          'tank',
          { x0: tx - 1, y0: ty - 1, z0: h + 16, x1: tx + 17, y1: ty + 17, z1: h + 34 },
          'office-tank',
          'none',
        ),
      ];
      break;
    }
    default:
      parts = [part('body', box(0, 0, h), tone, 'rows')];
  }
  return (
    <g opacity={opacity} style={{ '--lit': tower.lit } as CSSProperties}>
      {parts}
    </g>
  );
}

/**
 * Where the page's own area is (the frame's parent, beside the sidebar), as
 * offsets from the window's edges, kept up to date as the window resizes.
 */
function usePageArea(frame: { current: HTMLElement | null }): CSSProperties {
  const [area, setArea] = useState<CSSProperties>({ inset: 0 });
  useLayoutEffect(() => {
    const host = frame.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setArea({
        left: rect.left,
        top: rect.top,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [frame]);
  return area;
}

/** The night sky's stars, seeded so they stay put: mostly in the upper sky. */
const STARS = (() => {
  let seed = 11;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: 120 }, () => {
    const y = random() ** 1.6 * 75;
    const big = random() < 0.12;
    return {
      x: random() * 100,
      y,
      r: big ? 1.6 + random() * 0.6 : 0.6 + random() * 0.7,
      twinkle: random() < 0.35,
      delay: random() * 4,
    };
  });
})();

/** Day or night by this computer's clock, checked every minute. */
function useDaytime(): boolean {
  const [day, setDay] = useState(() => isDaytime(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setDay(isDaytime(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

/**
 * The sun or the moon, over the skyline so towers never hide it, and under
 * the office's controls.
 */
function Celestial({ day }: { day: boolean }) {
  return <span className={day ? 'office-sun' : 'office-moon'} aria-hidden />;
}

/** The sky behind the city: clouds by day, stars by night. */
function Sky({ day }: { day: boolean }) {
  return (
    <div className="office-sky" data-time={day ? 'day' : 'night'} aria-hidden>
      {day ? (
        <>
          <span className="office-cloud" style={{ left: '12%', top: '10%' }} />
          <span className="office-cloud office-cloud-small" style={{ left: '58%', top: '6%' }} />
          <span className="office-cloud" style={{ left: '80%', top: '18%' }} />
        </>
      ) : (
        <svg className="office-stars" aria-hidden>
          {STARS.map((star, i) => (
            <circle
              key={i}
              cx={`${star.x}%`}
              cy={`${star.y}%`}
              r={star.r}
              className={star.twinkle ? 'office-star office-star-twinkle' : 'office-star'}
              style={star.twinkle ? { animationDelay: `${star.delay}s` } : undefined}
            />
          ))}
        </svg>
      )}
    </div>
  );
}

interface Item {
  key: string;
  box: Box;
  node: ReactNode;
}

/** Builds the scene's boxes from the room's floor geometry. */
function sceneBuilder(view: View) {
  /** A flat face, drawn only when it faces the viewer. */
  const face = (className: string, normal: FloorPoint, points: number[][]) =>
    view.faces(normal) ? <polygon className={className} points={corners(view, points)} /> : null;
  const block = (
    key: string,
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    tone = 'furniture',
    extra?: ReactNode,
  ): Item => {
    const box = { x0: x, y0: y, z0: z, x1: x + w, y1: y + d, z1: z + h };
    return {
      key,
      box,
      node: (
        <Faces key={key} view={view} box={box} tone={tone}>
          {extra}
        </Faces>
      ),
    };
  };

  function desk(i: number, [x, y]: FloorPoint, busy: boolean): Item[] {
    const k = `desk${i}`;
    return [
      block(
        `${k}-back`,
        x,
        y,
        0,
        112,
        5,
        95,
        'partition',
        face(
          'office-note',
          [0, 1],
          [
            [x + 13, y + 5.5, 69],
            [x + 28, y + 5.5, 69],
            [x + 28, y + 5.5, 85],
            [x + 13, y + 5.5, 85],
          ],
        ),
      ),
      block(`${k}-side`, x, y + 5, 0, 5, 75, 95, 'partition'),
      block(`${k}-leg1`, x + 8, y + 56, 0, 5, 5, 47),
      block(`${k}-leg2`, x + 96, y + 56, 0, 5, 5, 47),
      block(`${k}-top`, x + 7, y + 12, 47, 103, 58, 6, 'desk'),
      block(`${k}-stand`, x + 42, y + 25, 53, 24, 14, 3),
      block(`${k}-neck`, x + 53, y + 28, 56, 4, 4, 11),
      block(
        `${k}-monitor`,
        x + 30,
        y + 25,
        67,
        48,
        4,
        30,
        'monitor',
        face(
          busy ? 'office-screen office-screen-busy' : 'office-screen',
          [0, 1],
          [
            [x + 34, y + 29.5, 71],
            [x + 74, y + 29.5, 71],
            [x + 74, y + 29.5, 93],
            [x + 34, y + 29.5, 93],
          ],
        ),
      ),
      block(`${k}-keys`, x + 33, y + 49, 53, 41, 12, 2, 'keyboard'),
      block(`${k}-mug`, x + 89, y + 35, 53, 10, 10, 13, 'mug'),
    ];
  }

  function plant(key: string, [x, y]: FloorPoint): Item {
    const pot = block(key, x - 10, y - 10, 0, 20, 20, 23, 'pot');
    const [cx, cy] = view.project(x, y);
    return {
      key,
      box: { ...pot.box, z1: 90 },
      node: (
        <g key={key}>
          {pot.node}
          <path
            className="office-leaves"
            d={`M${cx} ${cy - 22}v-47 m0 27q-27-2-23-25q24-2 23 25 m0-11q27-3 25-27q-27 0-25 27 m0-10q-17-7-12-26q18 6 12 26`}
          />
        </g>
      ),
    };
  }

  function lounge(layout: OfficeLayout): Item[] {
    const [cx, cy] = layout.cooler;
    const [tx, ty] = layout.coffeeTable;
    const [sx, sy] = layout.sofa;
    return [
      block('cooler', cx, cy, 0, 29, 27, 54, 'cooler'),
      block('bottle', cx + 5, cy + 5, 54, 19, 17, 26, 'water'),
      ...[
        [6, 6],
        [58, 6],
        [6, 36],
        [58, 36],
      ].map(([dx = 0, dy = 0], i) => block(`table-leg${i}`, tx + dx, ty + dy, 0, 5, 5, 22)),
      block('table', tx, ty, 22, 70, 48, 5, 'desk'),
      block('table-mug', tx + 46, ty + 14, 27, 8, 8, 10, 'mug'),
      block('table-book', tx + 12, ty + 18, 27, 22, 15, 3, 'book'),
      block('sofa-seat', sx, sy, 0, 30, 70, 18, 'sofa'),
      block('sofa-back', sx - 12, sy - 10, 0, 12, 90, 40, 'sofa'),
      block('sofa-arm1', sx, sy - 10, 0, 30, 10, 28, 'sofa'),
      block('sofa-arm2', sx, sy + 70, 0, 30, 10, 28, 'sofa'),
      ...layout.plants.map((p, i) => plant(`plant${i}`, p)),
    ];
  }

  /**
   * The walls behind the room from here: a side's wall shows when the viewer
   * looks at its inside. The window is on the left wall, the board on the back.
   */
  function walls(layout: OfficeLayout): ReactNode[] {
    const { width: W, depth: D } = layout;
    const t = 7;
    const sides = [
      { key: 'wall-left', outward: [-1, 0] as FloorPoint, box: [0, 0, t, D] },
      { key: 'wall-back', outward: [0, -1] as FloorPoint, box: [0, 0, W, t] },
      { key: 'wall-right', outward: [1, 0] as FloorPoint, box: [W - t, 0, W, D] },
      { key: 'wall-front', outward: [0, 1] as FloorPoint, box: [0, D - t, W, D] },
    ];
    return sides
      .filter((side) => !view.faces(side.outward))
      .map(({ key, box: [x0 = 0, y0 = 0, x1 = 0, y1 = 0] }) => (
        <Faces key={key} view={view} box={{ x0, y0, z0: 0, x1, y1, z1: WALL }} tone="wall">
          {key === 'wall-left' && (
            <>
              <polygon
                className="office-window"
                points={corners(view, [
                  [t + 0.5, 60, 40],
                  [t + 0.5, 180, 40],
                  [t + 0.5, 180, 115],
                  [t + 0.5, 60, 115],
                ])}
              />
              <polyline
                className="office-window-frame"
                points={corners(view, [
                  [t + 0.5, 120, 40],
                  [t + 0.5, 120, 115],
                ])}
              />
              <polyline
                className="office-window-frame"
                points={corners(view, [
                  [t + 0.5, 60, 78],
                  [t + 0.5, 180, 78],
                ])}
              />
            </>
          )}
          {key === 'wall-back' && (
            <polygon
              className="office-board"
              points={corners(view, [
                [W - 260, t + 0.5, 55],
                [W - 170, t + 0.5, 55],
                [W - 170, t + 0.5, 112],
                [W - 260, t + 0.5, 112],
              ])}
            />
          )}
        </Faces>
      ));
  }

  return { block, desk, lounge, walls };
}

/** Idle lines, picked per Bot so each one keeps its own. */
const IDLE_LINES = [
  'Coffee break',
  'Stretching my legs',
  'Back in five',
  'Any new tasks?',
  'Inbox zero!',
  'Refilling my water',
];

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function clip(text: string, max = 34): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** What a Bot says over its head, and whether it stays up until the user acts. */
export function botLine(bot: Bot): { text: string; urgent: boolean } {
  const { state, currentAction } = bot.state;
  switch (state) {
    case 'waiting':
      return { text: 'Waiting for you', urgent: true };
    case 'blocked':
      return { text: 'Needs your help', urgent: true };
    case 'working':
      return { text: clip(currentAction ?? 'On it'), urgent: false };
    case 'thinking':
      return { text: clip(currentAction ?? 'Thinking it over'), urgent: false };
    case 'done':
      return { text: 'All done', urgent: false };
    default:
      return { text: IDLE_LINES[hash(bot.id) % IDLE_LINES.length]!, urgent: false };
  }
}

/** Idle and finished Bots get up from their desks; the rest keep working. */
export function wanders(bot: Bot): boolean {
  return bot.state.state === 'idle' || bot.state.state === 'done';
}

function OfficeAvatar({ bot, x, y, size }: { bot: Bot; x: number; y: number; size: number }) {
  const state: AvatarState = bot.state.state;
  if (bot.avatar.kind === 'upload') {
    const clipId = `office-clip-${bot.id}`;
    return (
      <svg
        x={x}
        y={y}
        width={size}
        height={size}
        viewBox="0 0 64 64"
        className="ob-avatar"
        data-state={state}
        data-kind="upload"
        aria-hidden
      >
        <clipPath id={clipId}>
          <circle cx="32" cy="32" r="28" />
        </clipPath>
        <image
          href={defaultFileUrl(bot.avatar.file_id)}
          x="4"
          y="4"
          width="56"
          height="56"
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="xMidYMid slice"
        />
      </svg>
    );
  }
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className="ob-avatar"
      data-state={state}
      data-kind="generated"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: generate(bot.avatar as AvatarParams).svg }}
    />
  );
}

interface Walker {
  bot: Bot;
  seat: FloorPoint;
  /** The walk to a break spot and back, as floor points with their times, if it wanders. */
  walk: { time: number; at: FloorPoint }[] | null;
  line: { text: string; urgent: boolean };
  /** Its turn to speak, for Bots without an urgent line. */
  turn: number;
}

/** Where each Bot sits, the walks of those that wander, and what each says. */
function walkers(layout: OfficeLayout, bots: readonly Bot[]): Walker[] {
  let wanderer = 0;
  let talker = 0;
  return bots.map((bot, i) => {
    const seat = layout.seats[i]!;
    let walk: Walker['walk'] = null;
    if (wanders(bot)) {
      // Staggered, so the Bots leave their desks a few at a time.
      const start = 4 + ((wanderer * 23) % 52);
      const spot = layout.breakSpots[wanderer % layout.breakSpots.length]!;
      const leg = (from: FloorPoint, to: FloorPoint, begin: number, end: number) => {
        const route = officeRoute(layout, from, to);
        const progress = routeProgress(route);
        return route.map((at, j) => ({ time: begin + (end - begin) * progress[j]!, at }));
      };
      walk = [
        { time: 0, at: seat },
        ...leg(seat, spot, start, start + 9),
        ...leg(spot, seat, start + 30, start + 39),
        { time: 100, at: seat },
      ];
      wanderer++;
    }
    const line = botLine(bot);
    return { bot, seat, walk, line, turn: line.urgent ? -1 : talker++ };
  });
}

/** Zoom and pan, in the drawing's units: `scale` about the top left, then shifted by x, y. */
interface Camera {
  scale: number;
  x: number;
  y: number;
}

/** Pixels kept under the drawing for the caption and the controls. */
const CAPTION_STRIP = 72;

/** Space kept under the office in the home view, for the caption and the controls. */
const FLOOR_MARGIN = 56;

/** Sky left above the tallest building when scrolled all the way up. */
const SKY_MARGIN = 60;

/** The share of the office (or of the frame, zoomed past it) that stays in view across. */
const OFFICE_IN_VIEW = 0.75;

/** What limits the camera, in the drawing's units at scale 1. */
interface Bounds {
  /** The highest point of the skyline in view; above the drawing when negative. */
  skyTop: number;
  /** The office's left and right edges at this angle. */
  roomLeft: number;
  roomRight: number;
  /** Three quarters of the way down the office floor, at this angle: it stays above the caption. */
  roomMiddle: number;
}

/**
 * Across, at least OFFICE_IN_VIEW of the office stays in the frame (of the
 * frame, when zoomed in so far that the office is wider). Down, the office's
 * bottom edge never rises above the frame's, so no empty ground shows. Up, it
 * goes as far as the tallest building in view, with a strip of sky.
 */
function clamp(camera: Camera, width: number, height: number, bounds: Bounds): Camera {
  const scale = Math.min(MAX_ZOOM, Math.max(1, camera.scale));
  const left = scale * bounds.roomLeft;
  const right = scale * bounds.roomRight;
  const need = OFFICE_IN_VIEW * Math.min(right - left, width);
  const minX = need - right;
  const maxX = width - need - left;
  return {
    scale,
    x: minX <= maxX ? Math.min(maxX, Math.max(minX, camera.x)) : (minX + maxX) / 2,
    // Up as far as the skyline, but never so far that most of the office drops under the caption.
    y: Math.min(
      Math.max(
        0,
        Math.min(
          SKY_MARGIN - scale * bounds.skyTop,
          height - FLOOR_MARGIN - scale * bounds.roomMiddle,
        ),
      ),
      Math.max(height * (1 - scale), camera.y),
    ),
  };
}

/** The highest point of the buildings that show, on the drawing. */
function skylineTop(view: View, towers: readonly { tower: Tower; opacity: number }[]): number {
  let top = 0;
  for (const { tower, opacity } of towers) {
    if (opacity < 0.3) continue;
    const extra =
      tower.kind === 'spire'
        ? 64
        : tower.kind === 'lowrise'
          ? 34
          : tower.kind === 'pyramid'
            ? Math.min(tower.w, tower.d) * 0.45
            : 6;
    const [, y] = view.project(tower.x + tower.w / 2, tower.y + tower.d / 2, tower.h + extra);
    top = Math.min(top, y);
  }
  return top;
}

/** Zooms by `factor` about a point of the frame, which stays put. */
function zoomAbout(camera: Camera, factor: number, px: number, py: number): Camera {
  const scale = Math.min(MAX_ZOOM, Math.max(1, camera.scale * factor));
  const k = scale / camera.scale;
  return { scale, x: px - (px - camera.x) * k, y: py - (py - camera.y) * k };
}

type Drag = {
  id: number;
  x: number;
  y: number;
  /** Shift or a right drag moves the office; a plain drag turns it. */
  mode: 'turn' | 'move';
  camera: Camera;
  angle: number;
  moved: boolean;
};

export function Office({
  bots,
  caption,
  turnable = true,
  homeZoom = 1,
  align = 'bottom',
}: {
  bots: readonly Bot[];
  caption?: ReactNode;
  /** False on a phone: a drag moves the office instead of turning it. */
  turnable?: boolean;
  /** How far the home view is zoomed in, about the top of the room so it grows downward. */
  homeZoom?: number;
  /** Where the drawing sits in a frame taller than it: low under the sky, or centered. */
  align?: 'bottom' | 'middle';
}) {
  const navigate = useNavigate();
  const [angle, setAngle] = useState(0);
  // Null until the user moves the view: then the camera is `home`, which
  // follows the skyline as the office turns.
  const [stored, setStored] = useState<Camera | null>(null);
  const homeRef = useRef<Camera>({ scale: 1, x: 0, y: 0 });
  const setCamera = useCallback((next: Camera | ((c: Camera) => Camera)) => {
    setStored((prev) => (typeof next === 'function' ? next(prev ?? homeRef.current) : next));
  }, []);
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const area = usePageArea(frame);
  const drag = useRef<Drag | null>(null);
  // Fingers on the office, and the pinch they started, for zooming by touch.
  const touches = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ distance: number; camera: Camera } | null>(null);
  const dragged = useRef(false);
  const tween = useRef(0);

  const layout = useMemo(() => officeLayout(bots.length), [bots.length]);
  const team = useMemo(() => walkers(layout, bots), [layout, bots]);
  const view = useMemo(() => roomView(layout, angle), [layout, angle]);
  const { width, height } = view;
  const scene = useMemo(() => sceneBuilder(view), [view]);
  const day = useDaytime();
  const towers = useMemo(() => cityTowers(layout), [layout]);
  const skyline = useMemo(
    () =>
      paintOrder(
        towers
          .map((tower) => ({
            tower,
            opacity: towerOpacity(layout, tower, view.toward),
            box: {
              x0: tower.x,
              y0: tower.y,
              z0: 0,
              x1: tower.x + tower.w,
              y1: tower.y + tower.d,
              z1: tower.h,
            },
          }))
          .filter((t) => t.opacity > 0),
        view.toward,
      ),
    [towers, layout, view],
  );
  const skyTop = useMemo(() => skylineTop(view, skyline), [view, skyline]);
  const bounds = useMemo<Bounds>(() => {
    const floor = [
      [0, 0],
      [layout.width, 0],
      [0, layout.depth],
      [layout.width, layout.depth],
    ].map(([x = 0, y = 0]) => view.project(x, y));
    const xs = floor.map(([x]) => x);
    const ys = floor.map(([, y]) => y);
    return {
      skyTop,
      roomLeft: Math.min(...xs),
      roomRight: Math.max(...xs),
      roomMiddle: Math.min(...ys) + 0.75 * (Math.max(...ys) - Math.min(...ys)),
    };
  }, [layout, view, skyTop]);
  /**
   * The home view: scrolled up to show the whole skyline, with the office
   * low on the page but all of it, and room for the caption, in the frame.
   */
  const home = useMemo<Camera>(() => {
    const corners4 = [
      [0, 0],
      [layout.width, 0],
      [0, layout.depth],
      [layout.width, layout.depth],
    ];
    const floor = Math.max(...corners4.map(([x = 0, y = 0]) => view.project(x, y, -14)[1]));
    const up = Math.max(0, SKY_MARGIN - skyTop);
    const base = { scale: 1, x: 0, y: Math.max(0, Math.min(up, view.height - FLOOR_MARGIN - floor)) };
    if (homeZoom === 1) return base;
    const roomTop = Math.min(...corners4.map(([x = 0, y = 0]) => view.project(x, y, WALL)[1]));
    const middle = (bounds.roomLeft + bounds.roomRight) / 2;
    return clamp(
      zoomAbout(base, homeZoom, base.x + middle, base.y + roomTop),
      view.width,
      view.height,
      bounds,
    );
  }, [layout, view, skyTop, homeZoom, bounds]);
  homeRef.current = home;
  // A stored view keeps to the limits as the office turns under it.
  const camera = stored ? clamp(stored, width, height, bounds) : home;
  /** How far the city's ground reaches past the office. */
  // The ground reaches far out, so it fills the frame below the office; it
  // fades into the sky just past the last towers, so its far edge never shows.
  const city = STREET + 3 * 130 + 1600;
  const towersEnd = STREET + 3 * 130 + 60;
  const groundTop = Math.min(
    ...[
      [-towersEnd, -towersEnd],
      [layout.width + towersEnd, -towersEnd],
      [layout.width + towersEnd, layout.depth + towersEnd],
      [-towersEnd, layout.depth + towersEnd],
    ].map(([x = 0, y = 0]) => view.project(x, y)[1]),
  );

  const items = useMemo(() => {
    const list: Item[] = [
      ...layout.desks.flatMap((desk, i) =>
        scene.desk(i, desk, team[i] ? !wanders(team[i].bot) : false),
      ),
      ...scene.lounge(layout),
    ];
    for (const w of team) {
      const [x, y] = w.seat;
      list.push({
        key: `bot-${w.bot.id}`,
        box: { x0: x - 14, y0: y - 14, z0: 0, x1: x + 14, y1: y + 14, z1: 75 },
        node: null,
      });
    }
    return paintOrder(list, view.toward);
  }, [layout, scene, team, view]);

  // The walks as keyframes from each Bot's seat, at this angle.
  const keyframes = useMemo(
    () =>
      team
        .map((w, i) => {
          if (!w.walk) return '';
          const [sx, sy] = view.project(...w.seat);
          const frames = w.walk.map(({ time, at }) => {
            const [x, y] = view.project(...at);
            return `${time.toFixed(2)}% { transform: translate(${(x - sx).toFixed(1)}px, ${(y - sy).toFixed(1)}px); }`;
          });
          return `@keyframes office-walk-${i} { ${frames.join(' ')} }`;
        })
        .join('\n'),
    [team, view],
  );

  const talkers = team.filter((w) => !w.line.urgent).length;
  const sayPeriod = Math.max(talkers, 3) * SAY_SECONDS;
  const shown = (SAY_SECONDS / sayPeriod) * 100;
  const sayFrames = `@keyframes office-say { 0% { opacity: 0; } ${(shown * 0.08).toFixed(2)}%, ${(shown * 0.92).toFixed(2)}% { opacity: 1; } ${shown.toFixed(2)}%, 100% { opacity: 0; } }`;
  const walkStyle = (i: number) =>
    team[i]?.walk ? { animation: `office-walk-${i} ${WALK_PERIOD}s linear infinite` } : undefined;
  const clock = (i: number) => (team[i]?.walk ? '' : undefined);

  /** Turns smoothly to `target` degrees (the toolbar and the keys). */
  const turnTo = useCallback((target: number) => {
    cancelAnimationFrame(tween.current);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setAngle((from) => {
      if (reduced) return target;
      const started = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / 280);
        const eased = 1 - (1 - t) ** 3;
        setAngle(from + (target - from) * eased);
        if (t < 1) tween.current = requestAnimationFrame(step);
      };
      tween.current = requestAnimationFrame(step);
      return from;
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(tween.current), []);

  // Painting back to front moves Bots in the DOM as the office turns, and a
  // moved element restarts its animations. Pinning every walk and bubble to
  // the document's clock keeps each Bot, its name and its bubble together.
  useLayoutEffect(() => {
    for (const element of svg.current?.querySelectorAll('[data-clock]') ?? []) {
      for (const animation of element.getAnimations?.() ?? []) animation.startTime = 0;
    }
  });
  const turnBy = (step: number) => {
    if (turnable) turnTo(Math.round((angle + step) / TURN_STEP) * TURN_STEP);
  };

  /** A point of the frame, from the screen. */
  const framePoint = useCallback((clientX: number, clientY: number): [number, number] => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [p.x, p.y];
  }, []);

  // Pinch or Ctrl+scroll zooms about the pointer; a two finger scroll moves the office.
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const [px, py] = framePoint(event.clientX, event.clientY);
        setCamera((c) =>
          clamp(zoomAbout(c, Math.exp(-event.deltaY * 0.01), px, py), width, height, bounds),
        );
        return;
      }
      const unit = width / (element.clientWidth || width);
      setCamera((c) =>
        clamp(
          { ...c, x: c.x - event.deltaX * unit, y: c.y - event.deltaY * unit },
          width,
          height,
          bounds,
        ),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [framePoint, width, height, bounds]);

  const zoomBy = (factor: number) =>
    setCamera((c) => clamp(zoomAbout(c, factor, width / 2, height / 2), width, height, bounds));

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 2) return;
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, [event.clientX, event.clientY]);
      if (touches.current.size === 2) {
        // A second finger turns the drag into a pinch.
        const [a, b] = [...touches.current.values()] as [[number, number], [number, number]];
        pinch.current = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, camera };
        drag.current = null;
        dragged.current = true;
        return;
      }
    }
    cancelAnimationFrame(tween.current);
    dragged.current = false;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      mode: !turnable || event.shiftKey || event.button === 2 ? 'move' : 'turn',
      camera,
      angle,
      moved: false,
    };
  }
  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, [event.clientX, event.clientY]);
    }
    const p = pinch.current;
    if (p && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()] as [[number, number], [number, number]];
      const [mx, my] = framePoint((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const factor = Math.hypot(a[0] - b[0], a[1] - b[1]) / p.distance;
      setCamera(clamp(zoomAbout(p.camera, factor, mx, my), width, height, bounds));
      return;
    }
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      dragged.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (d.mode === 'turn') {
      setAngle(d.angle - dx * TURN_PER_PIXEL);
      return;
    }
    const unit = width / (event.currentTarget.clientWidth || width);
    setCamera(
      clamp(
        { ...d.camera, x: d.camera.x + dx * unit, y: d.camera.y + dy * unit },
        width,
        height,
        bounds,
      ),
    );
  }
  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) pinch.current = null;
  };

  const open = (bot: Bot) => {
    if (dragged.current) return;
    void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
  };
  const onBotKey = (event: KeyboardEvent, bot: Bot) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open(bot);
  };
  const reset = () => {
    turnTo(Math.round(angle / 360) * 360);
    setStored(null);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const actions: Record<string, () => void> = {
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
      '0': reset,
      '[': () => turnBy(-TURN_STEP),
      ']': () => turnBy(TURN_STEP),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const botNode = (w: Walker, i: number) => {
    const [cx, cy] = view.project(...w.seat);
    return (
      <g
        key={w.bot.id}
        className="office-bot"
        role="link"
        tabIndex={0}
        aria-label={`Open ${w.bot.name}`}
        onClick={() => open(w.bot)}
        onKeyDown={(event) => onBotKey(event, w.bot)}
      >
        <g style={walkStyle(i)} data-clock={clock(i)}>
          <rect className="office-hit" x={cx - 44} y={cy - 84} width="88" height="112" rx="16" />
          <ellipse cx={cx} cy={cy + 3} rx="24" ry="9" className="office-shadow" />
          <OfficeAvatar bot={w.bot} x={cx - 38} y={cy - 74} size={76} />
        </g>
      </g>
    );
  };

  const { width: W, depth: D } = layout;
  const [rx0, ry0, rx1, ry1] = layout.rug;
  const changed = stored !== null || angle % 360 !== 0;

  return (
    // The sky and the city fill the whole window, under the sidebar too; the
    // office itself is centered on the page's own area (`area`).
    <div
      ref={frame}
      data-slot="office"
      className="office-frame fixed inset-0 overflow-hidden"
      data-time={day ? 'day' : 'night'}
      onKeyDown={onKey}
    >
      <Sky day={day} />
      <style href="openbots-avatar" precedence="default">
        {AVATAR_CSS}
      </style>
      <style>{`${OFFICE_CSS}\n${keyframes}\n${sayFrames}`}</style>
      <div className="absolute" style={area}>
        <svg
          ref={svg}
          className="office"
          // The caption and the controls get a strip of their own under the
          // drawing, the same in pixels at any size; the ground runs on under it.
          style={{
            position: 'absolute',
            inset: '0 0 auto 0',
            height: `calc(100% - ${CAPTION_STRIP}px)`,
          }}
          data-dragging={drag.current?.moved ? drag.current.mode : undefined}
          viewBox={`0 0 ${width.toFixed(0)} ${height.toFixed(0)}`}
          preserveAspectRatio={align === 'middle' ? 'xMidYMid meet' : 'xMidYMax meet'}
          role="group"
          aria-label={
            bots.length
              ? 'Your Bots in the office. Drag to turn it, hold Shift to move it.'
              : 'An empty office'
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onContextMenu={(event) => event.preventDefault()}
        >
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
            <defs>
              <linearGradient
                id="office-ground-fade"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={groundTop}
                x2="0"
                y2={groundTop + 320}
              >
                <stop offset="0" className="office-ground-stop" stopOpacity="0" />
                <stop offset="1" className="office-ground-stop" stopOpacity="1" />
              </linearGradient>
            </defs>
            <polygon
              className="office-ground"
              fill="url(#office-ground-fade)"
              points={corners(view, [
                [-city, -city],
                [W + city, -city],
                [W + city, D + city],
                [-city, D + city],
              ])}
            />
            {skyline.map(({ tower, opacity }) => (
              <TowerNode
                key={`${tower.x},${tower.y}`}
                view={view}
                tower={tower}
                opacity={opacity}
              />
            ))}
            <Faces view={view} box={{ x0: 0, y0: 0, z0: -14, x1: W, y1: D, z1: 0 }} tone="floor" />
            <g className="office-tiles">
              {Array.from({ length: Math.floor((W - 1) / 70) }, (_, i) => (i + 1) * 70).map((n) => {
                const [x1, y1] = view.project(n, 0);
                const [x2, y2] = view.project(n, D);
                return <line key={`x${n}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
              })}
              {Array.from({ length: Math.floor((D - 1) / 70) }, (_, i) => (i + 1) * 70).map((n) => {
                const [x1, y1] = view.project(0, n);
                const [x2, y2] = view.project(W, n);
                return <line key={`y${n}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
              })}
            </g>
            <polygon
              className="office-rug"
              points={corners(view, [
                [rx0, ry0],
                [rx1, ry0],
                [rx1, ry1],
                [rx0, ry1],
              ])}
            />
            {scene.walls(layout)}

            {/* Back to front, so nearer furniture covers what is behind it. */}
            {items.map((item) => {
              if (!item.key.startsWith('bot-')) return item.node;
              const i = team.findIndex((w) => `bot-${w.bot.id}` === item.key);
              return botNode(team[i]!, i);
            })}

            {/* Name tags and bubbles paint last, over everything, and move with the Bots that walk. */}
            <g className="office-labels" aria-hidden>
              {team.map((w, i) => {
                const [cx, cy] = view.project(...w.seat);
                const tag = Math.min(150, w.bot.name.length * 4.6 + 12);
                return (
                  <g key={w.bot.id} style={walkStyle(i)} data-clock={clock(i)}>
                    <g transform={`translate(${cx - tag / 2}, ${cy + 9})`}>
                      <rect className="office-tag" width={tag} height="13" rx="4" />
                      <text className="office-name" x={tag / 2} y="9.2" textAnchor="middle">
                        {clip(w.bot.name, 30)}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
            <g className="office-bubbles" aria-live="polite">
              {team.map((w, i) => {
                const [cx, cy] = view.project(...w.seat);
                const bubble = Math.min(230, w.line.text.length * 6.1 + 26);
                return (
                  <g key={w.bot.id} style={walkStyle(i)} data-clock={clock(i)}>
                    <g
                      className={cn(
                        'office-bubble',
                        w.line.urgent ? 'office-bubble-urgent' : 'office-say',
                      )}
                      data-clock={w.line.urgent ? undefined : ''}
                      style={
                        w.line.urgent
                          ? undefined
                          : {
                              animation: `office-say ${sayPeriod}s linear ${w.turn * SAY_SECONDS}s infinite backwards`,
                            }
                      }
                    >
                      <rect x={cx - bubble / 2} y={cy - 118} width={bubble} height="30" rx="10" />
                      <path d={`M${cx - 5} ${cy - 88}l5 7 5-7`} />
                      <text x={cx} y={cy - 99} textAnchor="middle">
                        {w.line.text}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        <Celestial day={day} />
        {caption && (
          <p className="pointer-events-none absolute bottom-4 left-1/2 max-w-[calc(100%-18rem)] -translate-x-1/2 truncate rounded-full border bg-background/85 px-4 py-1.5 text-sm text-foreground shadow-sm backdrop-blur-md">
            {caption}
          </p>
        )}

        <div
          role="toolbar"
          aria-label="Office view"
          className="absolute right-4 bottom-4 flex items-center gap-0.5 rounded-full border bg-background/85 p-1 shadow-sm backdrop-blur-md"
        >
          <ControlButton label="Turn left ([)" onClick={() => turnBy(-TURN_STEP)}>
            <path d="M4 9a8 8 0 1 1 2 6" />
            <path d="M4 4v5h5" />
          </ControlButton>
          <ControlButton label="Turn right (])" onClick={() => turnBy(TURN_STEP)}>
            <path d="M20 9a8 8 0 1 0-2 6" />
            <path d="M20 4v5h-5" />
          </ControlButton>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <ControlButton
            label="Zoom out (-)"
            onClick={() => zoomBy(0.8)}
            disabled={camera.scale <= 1}
          >
            <path d="M5 12h14" />
          </ControlButton>
          <ControlButton
            label="Zoom in (+)"
            onClick={() => zoomBy(1.25)}
            disabled={camera.scale >= MAX_ZOOM}
          >
            <path d="M5 12h14M12 5v14" />
          </ControlButton>
          <ControlButton label="Reset view (0)" onClick={reset} disabled={!changed}>
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}
