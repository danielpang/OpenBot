import {
  CODER_AGENT_LABELS,
  CoderAgentSchema,
  type CoderAgent,
  type CoderLoginState,
} from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// A coding agent sign-in (CA3, I4, I8): posted when `code_task` needs an
// agent that is not signed in on the computer, like `login_request` for a
// site. The server runs the agent's own login as the `coder` user, shows the
// link (and Codex's device code) it printed, and the owner signs in there
// and pastes the code back (`code`), says they cannot (`cant`), or picks an
// API key from Settings > Models instead (`api_key`). The reducer only
// records the owner's answer; the server writes the code to the login and
// moves the state on to `signed_in`, `failed` or `expired`. Other Bots asking
// for the same agent while it is pending join it (`waiting`).

const BotRefSchema = z.strictObject({
  bot_id: z.uuid(),
  handle: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const CoderLoginPropsSchema = z.strictObject({
  /** `coder_logins.id`. */
  login_id: z.uuid(),
  agent: CoderAgentSchema,
  /** Where to sign in, as the agent's login printed it. */
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_000)
    .optional(),
  /** A code to enter at `url` (Codex's device auth). */
  device_code: z.string().min(1).max(64).optional(),
  instructions: z.string().min(1).max(500),
  waiting: z.array(BotRefSchema).max(50).optional(),
});
export type CoderLoginProps = z.infer<typeof CoderLoginPropsSchema>;

export const CoderLoginActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('code'), code: z.string().trim().min(4).max(200) }),
  z.strictObject({ type: z.literal('cant') }),
  z.strictObject({ type: z.literal('api_key') }),
]);
export type CoderLoginAction = z.infer<typeof CoderLoginActionSchema>;

export type CoderLoginWidgetState = CoderLoginState & {
  /** The agent, from the props, so the tool result can name it. */
  agent?: CoderAgent;
  /** When an unanswered sign-in expires (ISO 8601). */
  expires_at?: string;
  /** The owner pasted a code; the server is checking it. The code itself is never stored here. */
  code_submitted?: boolean;
  /** The owner chose an API key instead (Settings > Models). */
  wants_api_key?: boolean;
};

export interface CoderLoginOutcome {
  signed_in: boolean;
  note: string;
}

const CLOSED: Partial<Record<CoderLoginState['status'], string>> = {
  signed_in: 'This sign-in is already done',
  failed: 'This sign-in was already answered',
  expired: 'This sign-in expired',
  cancelled: 'This sign-in was already answered',
};

export const coderLoginWidget = defineWidget({
  kind: 'coder_login',
  description: 'A request for the owner to sign in to a coding agent on the computer',
  props: CoderLoginPropsSchema,
  action: CoderLoginActionSchema,
  botEmits: false,
  initialState: (props): CoderLoginWidgetState => ({ status: 'pending', agent: props.agent }),
  reduce: (state: CoderLoginWidgetState | undefined, action): CoderLoginWidgetState | string => {
    const current: CoderLoginWidgetState = state ?? { status: 'pending' };
    const closed = CLOSED[current.status];
    if (closed) return closed;
    switch (action.type) {
      case 'code':
        return { ...current, status: 'awaiting_code', code_submitted: true };
      case 'cant':
        return { ...current, status: 'failed' };
      case 'api_key':
        return { ...current, status: 'cancelled', wants_api_key: true };
    }
  },
  toolResult: (state: CoderLoginWidgetState): CoderLoginOutcome => {
    if (state.status === 'signed_in') {
      const agent = state.agent ? CODER_AGENT_LABELS[state.agent] : 'the coding agent';
      return {
        signed_in: true,
        note: `The owner signed in to ${agent}. Start the coding task again.`,
      };
    }
    if (state.wants_api_key) {
      return {
        signed_in: false,
        note: 'The owner chose to use an API key instead of signing in. Do not ask for their password or key; tell them to add it in Settings > Coding agents, then start the coding task again.',
      };
    }
    if (state.status === 'expired') {
      return {
        signed_in: false,
        note: 'The sign-in expired before the owner finished it. Do not ask for their password. Carry on without the coding agent, or tell the owner what you could not do.',
      };
    }
    return {
      signed_in: false,
      note: 'The owner could not sign in. Do not ask for their password. Carry on without the coding agent, or tell the owner what you could not do.',
    };
  },
});
