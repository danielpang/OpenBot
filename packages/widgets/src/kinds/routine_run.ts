import { z } from 'zod';
import { defineWidget } from './types.js';

// "Routine ran" (plan 10.2, R3): posted into the Bot's transcript when a
// Routine's run finishes, with the outcome, a link to the run's activity log
// and a Pause action for the Routine. A failed or cancelled run also offers
// the exception action: run it again (a new run, which posts its own widget).

export const ROUTINE_RUN_OUTCOMES = ['completed', 'failed', 'cancelled'] as const;
export const ROUTINE_RUN_REASONS = ['schedule', 'run_now', 'event', 'retry'] as const;

export const RoutineRunPropsSchema = z.strictObject({
  routine_id: z.uuid(),
  routine_run_id: z.uuid(),
  bot_id: z.uuid(),
  name: z.string().min(1).max(120),
  run_id: z.uuid().nullable(),
  outcome: z.enum(ROUTINE_RUN_OUTCOMES),
  reason: z.enum(ROUTINE_RUN_REASONS),
  started_at: z.string(),
  finished_at: z.string(),
  /** The run's error, for a failed or cancelled run. */
  exception: z.string().max(2_000).nullable().optional(),
});
export type RoutineRunProps = z.infer<typeof RoutineRunPropsSchema>;

export const RoutineRunActionSchema = z.strictObject({
  type: z.enum(['run_again', 'pause']),
});

export interface RoutineRunState {
  /** Set by the server when Run again started a run. */
  rerun_run_id?: string;
  paused?: boolean;
}

export const routineRunWidget = defineWidget({
  kind: 'routine_run',
  description: 'The outcome of one Routine run',
  props: RoutineRunPropsSchema,
  action: RoutineRunActionSchema,
  botEmits: false,
  initialState: (): RoutineRunState => ({}),
  reduce: (state: RoutineRunState | undefined, action) => {
    const current = state ?? {};
    if (action.type === 'pause') {
      if (current.paused) return 'The Routine is already paused';
      return { ...current, paused: true } satisfies RoutineRunState;
    }
    if (current.rerun_run_id) return 'This run was already started again';
    return current;
  },
});
