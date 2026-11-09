import {
  CODER_AGENT_LABELS,
  CoderAgentSchema,
  CoderModelNameSchema,
  type CoderAgent,
} from '@openbots/shared';
import { z } from 'zod';
import { defineWidget, invalidAction, type InvalidAction } from './types.js';

// The owner picks the coding agent and model for a task (CA9): posted by
// `code_task` when neither the call, the Bot's settings nor the owner's
// defaults (Settings > Coding agents) name an agent and a model. The owner
// chooses an agent and a model, and may keep them as their defaults
// (`remember`), which the server saves; or declines (`cancel`). The waiting
// run is told the choice and starts the task again with it.

export const CoderChoiceAgentSchema = z.strictObject({
  agent: CoderAgentSchema,
  /** Signed in (or using an API key) on the computer; one that is not asks for a sign-in next. */
  signed_in: z.boolean(),
  /** The model already set for this agent (the Bot's or the owner's), offered first. */
  model: CoderModelNameSchema.optional(),
});

export const CoderChoicePropsSchema = z.strictObject({
  /** The agents this build runs, in the order offered. */
  agents: z.array(CoderChoiceAgentSchema).min(1).max(10),
  /** The agent to offer first: the one the call or a default named. */
  agent: CoderAgentSchema.optional(),
  /** The repository the task is for, `owner/name`. */
  repo: z.string().min(1).max(200).optional(),
  /** The start of the task, so the owner knows what the choice is for. */
  prompt_excerpt: z.string().min(1).max(300).optional(),
});
export type CoderChoiceProps = z.infer<typeof CoderChoicePropsSchema>;

export const CoderChoiceActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choose'),
    agent: CoderAgentSchema,
    model: CoderModelNameSchema,
    /** Keep the agent and model as the owner's defaults for later tasks. */
    remember: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('cancel') }),
]);
export type CoderChoiceAction = z.infer<typeof CoderChoiceActionSchema>;

export interface CoderChoiceState {
  status: 'pending' | 'chosen' | 'cancelled';
  agent?: CoderAgent;
  model?: string;
  /** The choice was saved as the owner's defaults. */
  remember?: boolean;
}

export interface CoderChoiceOutcome {
  chosen: boolean;
  agent?: CoderAgent;
  model?: string;
  saved_as_default?: boolean;
  note: string;
}

export const coderChoiceWidget = defineWidget({
  kind: 'coder_choice',
  description: 'A request for the owner to pick the coding agent and model for a task',
  props: CoderChoicePropsSchema,
  action: CoderChoiceActionSchema,
  botEmits: false,
  initialState: (): CoderChoiceState => ({ status: 'pending' }),
  reduce: (
    state: CoderChoiceState | undefined,
    action,
    props,
  ): CoderChoiceState | string | InvalidAction => {
    if (state && state.status !== 'pending') return 'This choice was already made';
    if (action.type === 'cancel') return { status: 'cancelled' };
    if (!props.agents.some((a) => a.agent === action.agent)) {
      return invalidAction(`${CODER_AGENT_LABELS[action.agent]} is not offered here`);
    }
    return {
      status: 'chosen',
      agent: action.agent,
      model: action.model,
      remember: action.remember === true,
    };
  },
  toolResult: (state: CoderChoiceState): CoderChoiceOutcome => {
    if (state.status === 'chosen' && state.agent && state.model) {
      const label = CODER_AGENT_LABELS[state.agent];
      return {
        chosen: true,
        agent: state.agent,
        model: state.model,
        saved_as_default: !!state.remember,
        note:
          `The owner chose ${label} with the model ${state.model}. Call code_task again with the ` +
          `same task, agent "${state.agent}" and model "${state.model}".`,
      };
    }
    return {
      chosen: false,
      note: 'The owner did not pick a coding agent. Do not start the coding task; ask what they would like instead.',
    };
  },
});
