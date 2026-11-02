import { cn } from '@openbots/ui';
import { useState } from 'react';
import type { ChartProps } from '../kinds/chart.js';
import type { TableProps } from '../kinds/table.js';
import { csvHref, csvName, DataTable, toCsv } from './table.js';
import type { WidgetRendererProps } from './types.js';

// A bar or line chart (W1, plan 12.2), drawn as inline SVG: no charting
// library, one y axis. Hovering a label shows its values; with two or more
// series a legend names them. The data is also there as a table (the light
// series colors fall under 3:1 on the light surface, so the table is the
// relief) and as a CSV download. Read only.

const W = 560;
const H = 240;
const M = { top: 12, right: 12, bottom: 28, left: 48 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const BAR_MAX = 24;
const GAP = 2;

// The first four categorical slots, in their validated order, light and dark.
const FILL = [
  'fill-[#2a78d6] dark:fill-[#3987e5]',
  'fill-[#eb6834] dark:fill-[#d95926]',
  'fill-[#1baf7a] dark:fill-[#199e70]',
  'fill-[#eda100] dark:fill-[#c98500]',
];
const STROKE = [
  'stroke-[#2a78d6] dark:stroke-[#3987e5]',
  'stroke-[#eb6834] dark:stroke-[#d95926]',
  'stroke-[#1baf7a] dark:stroke-[#199e70]',
  'stroke-[#eda100] dark:stroke-[#c98500]',
];
const SWATCH = [
  'bg-[#2a78d6] dark:bg-[#3987e5]',
  'bg-[#eb6834] dark:bg-[#d95926]',
  'bg-[#1baf7a] dark:bg-[#199e70]',
  'bg-[#eda100] dark:bg-[#c98500]',
];

/** Round tick values covering `[min, max]`, about `count` steps apart. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    if (max === 0) max = 1;
    else if (max > 0) min = 0;
    else max = 0;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  // Whole steps from the first tick, so float drift never drops the last one.
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  return Array.from({ length: last - first + 1 }, (_, i) =>
    Number(((first + i) * step).toPrecision(12)),
  );
}

function formatter(ticks: number[]) {
  const big = Math.max(...ticks.map(Math.abs)) >= 10_000;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    ...(big ? { notation: 'compact' as const } : {}),
  });
}

/** A bar with a 4px rounded data end and a square end on the baseline. */
function barPath(x: number, width: number, y0: number, y1: number): string {
  const up = y1 <= y0;
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, width / 2, h);
  if (up) {
    return (
      `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + width - r}` +
      `Q${x + width},${y1} ${x + width},${y1 + r}V${y0}Z`
    );
  }
  return (
    `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + width - r}` +
    `Q${x + width},${y1} ${x + width},${y1 - r}V${y0}Z`
  );
}

/** The chart's data as table props: one column for the labels, one per series. */
export function chartTable(props: ChartProps): Pick<TableProps, 'columns' | 'rows'> {
  return {
    columns: [
      { key: 'label', label: props.x_label || 'Label' },
      ...props.series.map((s, i) => ({ key: `s${i}`, label: s.name, type: 'number' as const })),
    ],
    rows: props.labels.map((label, j) => ({
      label,
      ...Object.fromEntries(props.series.map((s, i) => [`s${i}`, s.values[j]!])),
    })),
  };
}

export function ChartWidget({ props }: WidgetRendererProps<ChartProps>) {
  const [hover, setHover] = useState<number | null>(null);
  const values = props.series.flatMap((s) => s.values);
  const bars = props.type === 'bar';
  // Bars grow from zero, so zero is always on the axis; lines fit their data.
  const lo = bars ? Math.min(0, ...values) : Math.min(...values);
  const hi = bars ? Math.max(0, ...values) : Math.max(...values);
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0]!;
  const yMax = ticks.at(-1)!;
  const y = (v: number) => M.top + PLOT_H - ((v - yMin) / (yMax - yMin || 1)) * PLOT_H;
  const fmt = formatter(ticks);
  const unit = props.unit ?? '';
  const n = props.labels.length;
  const band = PLOT_W / n;
  const cx = (j: number) => M.left + band * (j + 0.5);

  // Every label that fits, at about 6px a character.
  const widest = Math.max(...props.labels.map((l) => l.length)) * 6 + 8;
  const every = Math.max(1, Math.ceil(widest / band));
  const groupW = Math.min(band * 0.8, props.series.length * (BAR_MAX + GAP) - GAP);
  const barW = (groupW - GAP * (props.series.length - 1)) / props.series.length;
  const markers = n <= 24;
  const table = chartTable(props);

  return (
    <figure
      data-widget="chart"
      data-chart={props.type}
      className="flex max-w-2xl flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <figcaption className="flex flex-col">
        <span className="font-medium">{props.title}</span>
        {props.y_label && (
          <span className="text-xs text-muted-foreground">
            {props.y_label}
            {unit.trim() && ` (${unit.trim()})`}
          </span>
        )}
      </figcaption>
      {props.series.length > 1 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {props.series.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('inline-block size-2 rounded-sm', SWATCH[i])} />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`${props.title}: ${props.type} chart of ${props.series.map((s) => s.name).join(', ')}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? 'stroke-muted-foreground/50' : 'stroke-border'}
                strokeWidth={1}
              />
              <text
                x={M.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {fmt.format(t)}
              </text>
            </g>
          ))}
          {props.labels.map((label, j) =>
            j % every === 0 ? (
              <text
                key={j}
                x={cx(j)}
                y={H - M.bottom + 14}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {label}
              </text>
            ) : null,
          )}
          {props.x_label && (
            <text
              x={M.left + PLOT_W / 2}
              y={H - 2}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {props.x_label}
            </text>
          )}
          {hover !== null && !bars && (
            <line
              x1={cx(hover)}
              x2={cx(hover)}
              y1={M.top}
              y2={M.top + PLOT_H}
              className="stroke-muted-foreground/50"
              strokeWidth={1}
            />
          )}
          {props.series.map((s, i) =>
            bars ? (
              <g key={i} className={FILL[i]} data-series={s.name}>
                {s.values.map((v, j) => (
                  <path
                    key={j}
                    d={barPath(cx(j) - groupW / 2 + i * (barW + GAP), barW, y(0), y(v))}
                    opacity={hover === null || hover === j ? 1 : 0.5}
                  />
                ))}
              </g>
            ) : (
              <g key={i} data-series={s.name}>
                <polyline
                  points={s.values.map((v, j) => `${cx(j)},${y(v)}`).join(' ')}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className={STROKE[i]}
                />
                {s.values.map((v, j) =>
                  markers || j === n - 1 || hover === j ? (
                    <circle
                      key={j}
                      cx={cx(j)}
                      cy={y(v)}
                      r={4}
                      strokeWidth={2}
                      className={cn(FILL[i], 'stroke-card')}
                    />
                  ) : null,
                )}
              </g>
            ),
          )}
          {props.labels.map((label, j) => (
            <rect
              key={j}
              data-hit={j}
              x={M.left + band * j}
              y={M.top}
              width={band}
              height={PLOT_H}
              fill="transparent"
              onMouseEnter={() => setHover(j)}
              onMouseLeave={() => setHover((h) => (h === j ? null : h))}
            >
              <title>
                {`${label}: ${props.series.map((s) => `${s.name} ${fmt.format(s.values[j]!)}${unit}`).join(', ')}`}
              </title>
            </rect>
          ))}
        </svg>
        {hover !== null && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
            style={{ left: `${(cx(hover) / W) * 100}%` }}
          >
            <p className="font-medium">{props.labels[hover]}</p>
            {props.series.map((s, i) => (
              <p key={i} className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden className={cn('inline-block size-2 rounded-sm', SWATCH[i])} />
                {props.series.length > 1 && <span className="text-muted-foreground">{s.name}</span>}
                <span className="ml-auto pl-2">
                  {fmt.format(s.values[hover]!)}
                  {unit}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none">Data</summary>
        <div className="mt-2">
          <DataTable columns={table.columns} rows={table.rows} label={`${props.title} data`} />
        </div>
      </details>
      <a
        className="self-end text-xs underline-offset-2 hover:underline"
        href={csvHref(toCsv(table.columns, table.rows))}
        download={csvName(props.title, 'chart')}
      >
        Download CSV
      </a>
    </figure>
  );
}
