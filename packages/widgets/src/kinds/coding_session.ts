import {
  CODER_FEED_MAX,
  CoderActionClassSchema,
  CoderAgentSchema,
  CoderModeSchema,
  type CoderActionClass,
  type CoderFeedLine,
  type CodingSessionResult,
  type CodingSessionStatus,
} from '@openbots/shared';
import { z } from 'zod';
import { defineWidget } from './types.js';

// A coding session (CA5, I8): posted by `code_task` into the run's chat when
// a coding agent starts on a repository, and kept current by the server's
// runner, which appends to `feed` (the last CODER_FEED_MAX lines), adds the
// session's `approvals` as the agent asks, and sets `result` when it
// settles. The run waits on the widget like a sign-in request and resumes
// with `toolResult`. Stop, Continue and Discard only record what the owner
// asked for in `control`; the server acts on it and clears it. Open terminal
// is the client's own (a terminal on the worktree), so the reducer leaves
// the state as it is.

export const CodingSessionPropsSchema = z.strictObject({
  session_id: z.uuid(),
  agent: CoderAgentSchema,
  /** The repository's full name: `owner/name`. */
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(255),
  base: z.string().min(1).max(255),
  mode: CoderModeSchema,
  prompt_excerpt: z.string().max(300),
});
export type CodingSessionProps = z.infer<typeof CodingSessionPropsSchema>;

export const CodingSessionActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('continue'), prompt: z.string().trim().min(1).max(4_000) }),
  z.strictObject({ type: z.literal('discard') }),
  z.strictObject({ type: z.literal('open_terminal') }),
]);
export type CodingSessionAction = z.infer<typeof CodingSessionActionSchema>;

/** One approval the session asked for, as the widget shows it. */
export interface CodingSessionApproval {
  /** `approvals.id`; decided through `POST /approvals/{id}/decide`. */
  id: string;
  action_class: CoderActionClass;
  title: string;
  detail?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}

export const CodingSessionApprovalSchema = z.strictObject({
  id: z.uuid(),
  action_class: CoderActionClassSchema,
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
});

/** What a settled session produced, plus the Artifact its diff went into (CA5 View diff). */
export type CodingSessionStateResult = CodingSessionResult & {
  /** The Artifact holding `git diff <base>...HEAD`, when the session made commits. */
  diff_artifact_id?: string;
};

export interface CodingSessionState {
  status: CodingSessionStatus;
  started_at?: string;
  finished_at?: string;
  /** The last CODER_FEED_MAX lines, oldest first. */
  feed: CoderFeedLine[];
  approvals: CodingSessionApproval[];
  result?: CodingSessionStateResult;
  error?: string;
  vendor_session_id?: string;
  /** What the owner last asked for; the server acts on it and clears it. */
  control?: 'stop' | 'discard' | 'continue';
  /** The session's id, from the props, so the tool result can name it. */
  session_id?: string;
}

/** What the run waiting on the session receives (the model's view, kept small). */
export interface CodingSessionOutcome {
  status: CodingSessionStatus;
  summary: string | null;
  branch: string | null;
  base: string | null;
  worktree_path: string | null;
  changed_files: CodingSessionResult['changed_files'];
  commits: CodingSessionResult['commits'];
  pr_url: string | null;
  usage: CodingSessionResult['usage'] | null;
  error: string | null;
  session_id: string | null;
  note: string;
}

const MAX_TOOL_FILES = 50;
const MAX_TOOL_COMMITS = 20;
const CONTINUE_EXCERPT = 200;

const ENDED: readonly CodingSessionStatus[] = ['settled', 'failed', 'stopped'];

function excerpt(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const codingSessionWidget = defineWidget({
  kind: 'coding_session',
  description: 'A coding agent session working on a repository',
  props: CodingSessionPropsSchema,
  action: CodingSessionActionSchema,
  botEmits: false,
  initialState: (props): CodingSessionState => ({
    status: 'queued',
    feed: [],
    approvals: [],
    session_id: props.session_id,
  }),
  reduce: (state: CodingSessionState | undefined, action): CodingSessionState | string => {
    const current: CodingSessionState = state ?? { status: 'queued', feed: [], approvals: [] };
    const ended = ENDED.includes(current.status);
    switch (action.type) {
      case 'stop':
        if (ended) return 'This session already ended';
        return { ...current, status: 'stopped', control: 'stop' };
      case 'continue': {
        if (!ended) return 'This session is still running';
        const line: CoderFeedLine = {
          t: new Date().toISOString(),
          type: 'text',
          text: `Continue: ${excerpt(action.prompt, CONTINUE_EXCERPT)}`,
        };
        return {
          ...current,
          status: 'queued',
          control: 'continue',
          feed: [...current.feed, line].slice(-CODER_FEED_MAX),
        };
      }
      case 'discard':
        if (!ended) return 'Stop the session before discarding its branch';
        return { ...current, control: 'discard' };
      case 'open_terminal':
        return current;
    }
  },
  toolResult: (state: CodingSessionState): CodingSessionOutcome => {
    const result = state.result;
    const next = state.session_id
      ? `To continue this session call code_task with session_id ${state.session_id} and the next prompt.`
      : 'To continue this session call code_task with session_id and the next prompt.';
    const push = 'The branch is pushed only after the owner approves.';
    const note =
      state.status === 'settled'
        ? `${next} ${push}`
        : state.status === 'stopped'
          ? `The owner stopped the session. ${next} ${push}`
          : `The session did not finish. Tell the owner what happened. ${next} ${push}`;
    return {
      status: state.status,
      summary: result?.summary ?? null,
      branch: result?.branch ?? null,
      base: result?.base ?? null,
      worktree_path: result?.worktree_path ?? null,
      changed_files: (result?.changed_files ?? []).slice(0, MAX_TOOL_FILES),
      commits: (result?.commits ?? []).slice(0, MAX_TOOL_COMMITS),
      pr_url: result?.pr_url ?? null,
      usage: result?.usage ?? null,
      error: state.error ?? null,
      session_id: state.session_id ?? null,
      note,
    };
  },
});
