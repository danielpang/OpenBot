import { z } from 'zod';
import { defineWidget } from './types.js';

// A table (plan 12.2, W1): columns and rows the Bot fills. Read only; the
// owner can sort by a column and download it as CSV, both in the browser.

export const TableCellSchema = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);

export const TableColumnSchema = z.strictObject({
  /** The row key this column reads. */
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  /** Numbers align right and sort numerically. Defaults to text. */
  type: z.enum(['text', 'number']).optional(),
});

export const TablePropsSchema = z
  .strictObject({
    title: z.string().min(1).max(200).optional(),
    columns: z.array(TableColumnSchema).min(1).max(20),
    rows: z.array(z.record(z.string(), TableCellSchema)).max(500),
    /** A line under the table: the source, or what was left out. */
    caption: z.string().max(500).optional(),
  })
  .refine((p) => new Set(p.columns.map((c) => c.key)).size === p.columns.length, {
    message: 'Column keys must be unique',
    path: ['columns'],
  });

export type TableProps = z.infer<typeof TablePropsSchema>;
export type TableCell = z.infer<typeof TableCellSchema>;

export const tableWidget = defineWidget({
  kind: 'table',
  description:
    'A table: {title?, columns: [{key, label, type?: text|number}], rows: [{<key>: value}] ' +
    '(up to 500), caption?}. The owner can sort it and download it as CSV',
  props: TablePropsSchema,
  botEmits: true,
});
