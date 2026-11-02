import { cn } from '@openbots/ui';
import { useMemo, useState } from 'react';
import type { TableCell, TableProps } from '../kinds/table.js';
import type { WidgetRendererProps } from './types.js';

// A table from the Bot (W1, plan 12.2). Read only: a header click sorts by
// that column (ascending, then descending), and Download CSV saves the rows
// as the Bot sent them. Both happen in the browser; nothing is posted.

type Column = TableProps['columns'][number];
type Sort = { key: string; dir: 'asc' | 'desc' };

/** One CSV document (RFC 4180), with text that a spreadsheet would run as a formula defused. */
export function toCsv(columns: Column[], rows: Record<string, TableCell>[]): string {
  const cell = (value: TableCell | undefined) => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.map((c) => cell(c.label)).join(','),
    ...rows.map((row) => columns.map((c) => cell(row[c.key])).join(',')),
  ].join('\r\n');
}

/** A `data:` URL for a CSV document, for a download link. */
export const csvHref = (csv: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;

/** A file name from a title: "Q3 revenue" → "q3-revenue.csv". */
export function csvName(title: string | undefined, fallback: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || fallback}.csv`;
}

function compare(a: TableCell | undefined, b: TableCell | undefined, numeric: boolean): number {
  // Empty cells go last whichever way the column is sorted.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (numeric && typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function sortRows(
  columns: Column[],
  rows: Record<string, TableCell>[],
  sort: Sort | null,
): Record<string, TableCell>[] {
  const column = sort && columns.find((c) => c.key === sort.key);
  if (!column) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const numeric = column.type === 'number';
  return [...rows].sort((a, b) => {
    const order = compare(a[column.key], b[column.key], numeric);
    const empty = a[column.key] == null || b[column.key] == null;
    return empty ? order : sign * order;
  });
}

const display = (value: TableCell | undefined) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'boolean'
      ? value
        ? 'Yes'
        : 'No'
      : typeof value === 'number'
        ? value.toLocaleString()
        : value;

/** The sortable table itself; the chart kind shows its data with it too. */
export function DataTable({
  columns,
  rows,
  label,
}: {
  columns: Column[];
  rows: Record<string, TableCell>[];
  label?: string;
}) {
  const [sort, setSort] = useState<Sort | null>(null);
  const sorted = useMemo(() => sortRows(columns, rows, sort), [columns, rows, sort]);

  function toggle(key: string) {
    setSort((s) =>
      s?.key === key && s.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' },
    );
  }

  return (
    <div className="max-h-96 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-sm" aria-label={label}>
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            {columns.map((c) => {
              const dir = sort?.key === c.key ? sort.dir : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  className={cn('p-0 font-medium', c.type === 'number' && 'text-right')}
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    className={cn(
                      'w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground',
                      c.type === 'number' ? 'text-right' : 'text-left',
                    )}
                  >
                    {c.label}
                    <span aria-hidden className="ml-1 inline-block w-2">
                      {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} className="border-b last:border-b-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-2 py-1.5 align-top',
                    c.type === 'number' && 'text-right tabular-nums',
                  )}
                >
                  {display(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableWidget({ props }: WidgetRendererProps<TableProps>) {
  return (
    <div
      data-widget="table"
      className="flex max-w-2xl flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <div className="flex items-baseline gap-2">
        {props.title && <h3 className="font-medium">{props.title}</h3>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {props.rows.length} {props.rows.length === 1 ? 'row' : 'rows'}
        </span>
      </div>
      {props.rows.length ? (
        <DataTable columns={props.columns} rows={props.rows} label={props.title} />
      ) : (
        <p className="text-muted-foreground">No rows.</p>
      )}
      <div className="flex items-baseline gap-2">
        {props.caption && <p className="text-xs text-muted-foreground">{props.caption}</p>}
        {props.rows.length > 0 && (
          <a
            className="ml-auto shrink-0 text-xs underline-offset-2 hover:underline"
            href={csvHref(toCsv(props.columns, props.rows))}
            download={csvName(props.title, 'table')}
          >
            Download CSV
          </a>
        )}
      </div>
    </div>
  );
}
