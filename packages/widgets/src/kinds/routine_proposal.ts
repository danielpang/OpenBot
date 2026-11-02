import { SchedulePresetSchema } from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// "Create Routine?" (plan 10.2, R5). `propose_routine` posts it with the
// schedule and prompt filled in and the run waits. Confirm creates the
// Routine on the server (which adds its id to the state and posts a
// `routine_created` widget) and the run continues knowing it exists; Decline
// continues with a refusal. The owner's browser supplies the timezone when
// the proposal carries none.

export const RoutineProposalPropsSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8_000),
  trigger: z.strictObject({ type: z.literal('schedule'), preset: SchedulePresetSchema }),
  /** IANA name; absent means the owner's own timezone at Confirm. */
  timezone: z.string().min(1).max(64).optional(),
  /** Why the Bot suggests it, one sentence. */
  reason: z.string().max(500).optional(),
});
export type RoutineProposalProps = z.infer<typeof RoutineProposalPropsSchema>;

export const RoutineProposalActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('confirm'),
    timezone: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({ type: z.literal('decline') }),
]);

export interface RoutineProposalState {
  status: 'pending' | 'confirmed' | 'declined';
  timezone?: string;
  /** Set by the server once the Routine exists. */
  routine_id?: string;
}

export const routineProposalWidget = defineWidget({
  kind: 'routine_proposal',
  description: 'A proposed Routine with Confirm and Decline',
  props: RoutineProposalPropsSchema,
  action: RoutineProposalActionSchema,
  botEmits: false,
  initialState: (): RoutineProposalState => ({ status: 'pending' }),
  reduce: (state: RoutineProposalState | undefined, action, props) => {
    if (state && state.status !== 'pending') return `This proposal was already ${state.status}`;
    if (action.type === 'decline') return { status: 'declined' } satisfies RoutineProposalState;
    return {
      status: 'confirmed',
      timezone: props.timezone ?? action.timezone ?? 'UTC',
    } satisfies RoutineProposalState;
  },
  toolResult: (state: RoutineProposalState) =>
    state.status === 'confirmed'
      ? { created: true, routine_id: state.routine_id, timezone: state.timezone }
      : { created: false, note: 'The owner declined the Routine' },
});
