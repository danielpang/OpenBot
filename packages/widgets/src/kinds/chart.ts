import { z } from 'zod';
import { defineWidget } from './types.js';

// A chart (plan 12.2, W1): bars or lines over shared labels, one value per
// label per series, on a single y axis. Read only; the data is also shown as
// a table and downloads as CSV.

export const CHART_TYPES = ['bar', 'line'] as const;

/** Series past four fold into small multiples or another chart; four keep distinct colors. */
export const CHART_MAX_SERIES = 4;

export const ChartSeriesSchema = z.strictObject({
  name: z.string().min(1).max(100),
  values: z.array(z.number().finite()).min(1).max(100),
});

export const ChartPropsSchema = z
  .strictObject({
    title: z.string().min(1).max(200),
    type: z.enum(CHART_TYPES),
    /** The x axis: categories for bars, points in order for lines. */
    labels: z.array(z.string().min(1).max(100)).min(1).max(100),
    series: z.array(ChartSeriesSchema).min(1).max(CHART_MAX_SERIES),
    x_label: z.string().max(100).optional(),
    y_label: z.string().max(100).optional(),
    /** Shown after each value, like `%` or ` ms`. */
    unit: z.string().max(12).optional(),
  })
  .refine((p) => p.series.every((s) => s.values.length === p.labels.length), {
    message: 'Every series needs one value per label',
    path: ['series'],
  });

export type ChartProps = z.infer<typeof ChartPropsSchema>;

export const chartWidget = defineWidget({
  kind: 'chart',
  description:
    'A bar or line chart: {title, type: bar|line, labels: [x values], series: [{name, values: ' +
    `[one number per label]}] (1 to ${CHART_MAX_SERIES}), x_label?, y_label?, unit?}`,
  props: ChartPropsSchema,
  botEmits: true,
});
