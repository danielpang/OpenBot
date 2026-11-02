import { RoutineTriggerSchema } from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// "Routine created" (plan 10.2, R5): posted by the server when a proposal is
// confirmed. Read only; it links to the Bot's Routines tab.

export const RoutineCreatedPropsSchema = z.strictObject({
  routine_id: z.uuid(),
  bot_id: z.uuid(),
  name: z.string().min(1).max(120),
  trigger: RoutineTriggerSchema,
  timezone: z.string().min(1).max(64),
  /** ISO time of the first run; null for event triggers. */
  next_run_at: z.string().nullable(),
});
export type RoutineCreatedProps = z.infer<typeof RoutineCreatedPropsSchema>;

export const routineCreatedWidget = defineWidget({
  kind: 'routine_created',
  description: 'A Routine that was just created',
  props: RoutineCreatedPropsSchema,
  botEmits: false,
});
