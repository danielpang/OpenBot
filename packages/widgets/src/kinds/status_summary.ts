import { z } from 'zod';
import { defineWidget } from './types.js';

// Team or task status from a coordinating Bot (plan 12.2, W1): one row per
// piece of work with who has it and where it stands. Read only; the
// coordinating Bot posts a new one when the picture changes.

export const STATUS_SUMMARY_STATUSES = [
  'todo',
  'in_progress',
  'waiting',
  'blocked',
  'done',
] as const;

export const StatusSummaryItemSchema = z.strictObject({
  label: z.string().min(1).max(200),
  status: z.enum(STATUS_SUMMARY_STATUSES),
  /** The handle of the Bot (or the owner) doing it, without the `@`. */
  owner: z.string().min(1).max(64).optional(),
  note: z.string().max(500).optional(),
});

export const StatusSummaryPropsSchema = z.strictObject({
  title: z.string().min(1).max(200),
  items: z.array(StatusSummaryItemSchema).min(1).max(20),
  /** One or two sentences above the rows. */
  summary: z.string().max(1_000).optional(),
});

export type StatusSummaryProps = z.infer<typeof StatusSummaryPropsSchema>;

export const statusSummaryWidget = defineWidget({
  kind: 'status_summary',
  description:
    'Team or task status: a title and rows of {label, status: todo|in_progress|waiting|blocked|done, owner?: handle, note?}',
  props: StatusSummaryPropsSchema,
  botEmits: true,
});
