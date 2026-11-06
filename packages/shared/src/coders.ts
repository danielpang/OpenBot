import { z } from 'zod';
import {
  CoderActionClassSchema,
  CoderAgentSchema,
  SOURCE_TRIGGER,
  stricterDecision,
  type CoderActionClass,
  type CoderAgent,
  type PolicyDecision,
  type ResolvedToolPolicy,
  type RunSource,
} from './policy.js';
import type { ProviderKind, ProviderProtocol } from './providers.js';

// Coding agents on the Bot's computer (CA1 to CA14, I7): Claude Code, Codex
// and pi run as the `coder` user in a git worktree of their own, started by
// the `code_task` tool and run by the server's `coders` queue. This file is
// the vocabulary every side shares: the agents, modes and session states,
// the normal form the runner turns each vendor's event stream into
// (`CoderEvent`), the control channel's messages, the per-Bot action policy
// and the limits. The agent and action class enums and `CoderPolicySchema`
// and the model name are defined in policy.ts (the tool policy carries them)
// and re-exported here.

export {
  CoderActionClassSchema,
  CoderAgentSchema,
  CoderModelNameSchema,
  CoderPolicySchema,
  type CoderActionClass,
  type CoderAgent,
  type CoderPolicy,
} from './policy.js';

export const CODER_AGENTS = CoderAgentSchema.options;

export const CODER_AGENT_LABELS: Record<CoderAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
};

/**
 * What a session may do: `plan` reads and proposes, `edit` changes and
 * commits on its branch, `pr` also pushes and opens a pull request after the
 * owner approves.
 */
export const CoderModeSchema = z.enum(['plan', 'edit', 'pr']);
export type CoderMode = z.infer<typeof CoderModeSchema>;

/** How an agent is signed in on the computer (`coder_accounts.auth_kind`). */
export const CoderAuthKindSchema = z.enum(['none', 'subscription', 'api_key']);
export type CoderAuthKind = z.infer<typeof CoderAuthKindSchema>;

/**
 * Whose plan a `subscription` account bills (Settings > Coding agents): pi
 * signed in to a Claude plan bills it as extra usage, which the card says.
 * Null for an account with no plan sign-in.
 */
export const CoderPlanProviderSchema = z.enum(['anthropic', 'openai', 'other']);
export type CoderPlanProvider = z.infer<typeof CoderPlanProviderSchema>;

/**
 * How an agent signs in: a link to open (Claude Code), a link and a code to
 * enter there (Codex), or in the computer's terminal (pi).
 */
export const CoderSignInStyleSchema = z.enum(['link', 'device', 'terminal']);
export type CoderSignInStyle = z.infer<typeof CoderSignInStyleSchema>;

/**
 * `coding_sessions.status`: `queued` until the runner claims it, `starting`
 * while the checkout and worktree are made, `running` while the agent works,
 * `waiting` on an approval or a vendor rate limit, then one of the ends:
 * `settled` (the agent finished), `failed` or `stopped` (the owner stopped it).
 * A continued session goes back to `queued`.
 */
export const CodingSessionStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'waiting',
  'settled',
  'failed',
  'stopped',
]);
export type CodingSessionStatus = z.infer<typeof CodingSessionStatusSchema>;

/**
 * `coding_sessions.error` when the CLI is not signed in: a machine-readable
 * marker, which the widgets word as "Not signed in" (coder-words.ts).
 */
export const NEEDS_LOGIN = 'needs_login';

/** The statuses a session ends in; only these take Continue or Discard. */
export const CODING_SESSION_ENDED: readonly CodingSessionStatus[] = [
  'settled',
  'failed',
  'stopped',
];

/** The BullMQ queue the runner jobs go on: one job per session (I12). */
export const CODERS_QUEUE = 'coders';

/** The Redis channel the server publishes `CoderControl` messages on (I12). */
export const CODER_CONTROL_CHANNEL = 'openbots:coder-control';

/**
 * What the server tells a running session's job: stop it, stop every session
 * on a computer that is stopping, answer an approval, write to the agent's
 * stdin, or arm the push credential once the owner approved a push.
 */
export const CoderControlSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stop'), sessionId: z.uuid() }),
  z.strictObject({ type: z.literal('stop_all'), computerId: z.uuid() }),
  z.strictObject({
    type: z.literal('approval'),
    sessionId: z.uuid(),
    approvalId: z.uuid(),
    decision: z.enum(['approved', 'denied']),
  }),
  z.strictObject({ type: z.literal('stdin'), sessionId: z.uuid(), data: z.string() }),
  z.strictObject({ type: z.literal('push_allowed'), sessionId: z.uuid() }),
]);
export type CoderControl = z.infer<typeof CoderControlSchema>;

/**
 * The normal form of a coding agent's output (I10): each adapter parses its
 * CLI's stream into these, and the runner feeds them to the widget and the
 * activity log. `usage.billed` says whether the tokens count against a plan
 * or API credits, when the stream says.
 */
export const CoderEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('tool_use'), name: z.string(), summary: z.string() }),
  z.strictObject({
    type: z.literal('file_change'),
    path: z.string(),
    kind: z.enum(['edit', 'create', 'delete']),
    added: z.number().int().nonnegative().optional(),
    removed: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('command'),
    command: z.string(),
    exit_code: z.number().int().optional(),
    summary: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('approval_request'),
    /** The agent's own id for the prompt, answered with the decision. */
    request_id: z.string().min(1),
    action_class: CoderActionClassSchema,
    title: z.string(),
    detail: z.string().optional(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal('usage'),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative().optional(),
    billed: z.enum(['subscription', 'api', 'unknown']),
  }),
  z.strictObject({
    type: z.literal('result'),
    ok: z.boolean(),
    summary: z.string(),
    /** The vendor's session id, which `--resume` and its kin take to continue. */
    vendor_session_id: z.string().optional(),
    error: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);
export type CoderEvent = z.infer<typeof CoderEventSchema>;
export type CoderEventType = CoderEvent['type'];

export const CODER_EVENT_TYPES = [
  'text',
  'tool_use',
  'file_change',
  'command',
  'approval_request',
  'usage',
  'result',
  'error',
] as const satisfies readonly CoderEventType[];

/** The longest line the widget's feed keeps; the full log is a file on the session. */
export const CODER_FEED_LINE_MAX = 500;

/** One line of the `coding_session` widget's feed: an event, shortened. */
export const CoderFeedLineSchema = z.strictObject({
  t: z.iso.datetime({ offset: true }),
  type: z.enum(CODER_EVENT_TYPES),
  text: z.string().max(CODER_FEED_LINE_MAX),
});
export type CoderFeedLine = z.infer<typeof CoderFeedLineSchema>;

/** The widget keeps the last this many feed lines (I12). */
export const CODER_FEED_MAX = 200;

// Limits (docs/TECHNICAL_PLAN.md 22.11): constants for now, per account in
// `limits` later.

/** A session's own time limit, in minutes, unless the account sets another. */
export const DEFAULT_SESSION_MINUTES = 60;
/** Agent turns per session (Claude Code's `--max-turns`, and the others' equivalent). */
export const DEFAULT_MAX_TURNS = 200;
/** Sessions running at once per account; the next one queues. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
/** Remembered repositories per account (GH4). */
export const DEFAULT_MAX_REPOS = 50;

/**
 * What a session asks before, unless the Bot's `coder.actions` says
 * otherwise: edits, tests and commits inside the worktree run (`other`);
 * pushing, a PR, anything outside the worktree, package installs and
 * destructive commands ask ("Decisions to confirm", default permission posture).
 */
export const DEFAULT_CODER_ACTIONS: Record<CoderActionClass, PolicyDecision> = {
  push: 'ask',
  pr: 'ask',
  outside_worktree: 'ask',
  install: 'ask',
  destructive: 'ask',
  other: 'auto',
};

/**
 * The decision for one action class in a session: the Bot's override or the
 * default, then raised to the floor for runs another Bot or a webhook
 * started (P2), read the way the policy engine reads a trigger entry: its
 * rule for `code_task`, else for the `coder` group, else its `default`. The
 * `webhook` and `bot_dm` entries default to `ask`, so those sessions ask for
 * everything unless the owner set `default: 'auto'` there.
 */
export function coderActionDecision(
  policy: ResolvedToolPolicy,
  source: RunSource,
  action: CoderActionClass,
): PolicyDecision {
  const own = policy.coder.actions?.[action] ?? DEFAULT_CODER_ACTIONS[action];
  if (source === 'owner') return own;
  const rules = policy.triggers[SOURCE_TRIGGER[source]];
  const floor = rules?.tools?.code_task ?? rules?.groups?.coder ?? rules?.default;
  return floor ? stricterDecision(own, floor) : own;
}

/** Whether a Bot may start coding sessions: `coder.enabled` absent means on, and `groups.coder = deny` turns it off. */
export function coderEnabled(policy: ResolvedToolPolicy): boolean {
  return policy.coder.enabled !== false && policy.groups.coder !== 'deny';
}

/**
 * A coding agent sign-in (`coder_logins.status`, the `coder_login` widget):
 * `pending` until the agent shows a link, `awaiting_code` while the agent
 * waits for the owner to paste the code back (the link stays visible), then
 * `signed_in`, or `failed`, `expired` or `cancelled` (the owner chose an API
 * key instead).
 */
export const CoderLoginStatusSchema = z.enum([
  'pending',
  'awaiting_code',
  'signed_in',
  'failed',
  'expired',
  'cancelled',
]);
export type CoderLoginStatus = z.infer<typeof CoderLoginStatusSchema>;

/** A sign-in's state as the `coder_login` widget keeps it. */
export interface CoderLoginState {
  status: CoderLoginStatus;
  /** Where the owner signs in, as the agent's login printed it. */
  url?: string;
  /** A device code to enter at `url` (Codex's device auth). */
  device_code?: string;
  /** The account signed in, as the agent names it: an email or plan. */
  account_label?: string;
  error?: string;
}

/** One changed file of a session's branch against its base. */
export const CoderChangedFileSchema = z.strictObject({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  kind: z.enum(['edit', 'create', 'delete']),
});
export type CoderChangedFile = z.infer<typeof CoderChangedFileSchema>;

export const CoderCommitSchema = z.strictObject({ sha: z.string(), title: z.string() });
export type CoderCommit = z.infer<typeof CoderCommitSchema>;

export const CoderUsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().optional(),
  billed: z.enum(['subscription', 'api', 'unknown']),
});
export type CoderUsage = z.infer<typeof CoderUsageSchema>;

/**
 * What a settled session produced, computed by the runner from git against
 * the base (I12): stored on the session and in the widget's state.
 */
export const CodingSessionResultSchema = z.strictObject({
  summary: z.string(),
  changed_files: z.array(CoderChangedFileSchema),
  commits: z.array(CoderCommitSchema),
  branch: z.string(),
  base: z.string(),
  worktree_path: z.string(),
  pr_url: z.url().optional(),
  usage: CoderUsageSchema.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  /** The Artifact holding the session's diff against its base, when one was saved (CA5). */
  diff_artifact_id: z.uuid().optional(),
});
export type CodingSessionResult = z.infer<typeof CodingSessionResultSchema>;

/**
 * Which Settings > Models providers each agent can take a key from (CA2):
 * a native provider of one of `native`, or any provider speaking one of
 * `compatible`. pi reads its key from the vendor's own variable, so it takes
 * no custom endpoint. The server refuses the rest with
 * CODER_PROVIDER_UNSUPPORTED and `message`; the web filters its picker with
 * `coderProviderFits`.
 */
export const CODER_PROVIDER_KINDS: Record<
  CoderAgent,
  {
    native: readonly ProviderKind[];
    compatible: readonly Exclude<ProviderProtocol, 'native'>[];
    message: string;
  }
> = {
  claude: {
    native: ['anthropic'],
    compatible: ['anthropic_compatible'],
    message: 'Claude Code can use Anthropic keys and Anthropic compatible endpoints',
  },
  codex: {
    native: ['openai'],
    compatible: ['openai_compatible'],
    message: 'Codex can use OpenAI keys and OpenAI compatible endpoints',
  },
  pi: {
    native: ['anthropic', 'openai', 'google', 'xai'],
    compatible: [],
    message:
      'pi can use Anthropic, OpenAI, Google and xAI keys; custom endpoints are not supported yet',
  },
};

/** Whether `agent` can use a key from `provider` (CODER_PROVIDER_KINDS). */
export function coderProviderFits(
  agent: CoderAgent,
  provider: { kind: ProviderKind; protocol: ProviderProtocol },
): boolean {
  const fit = CODER_PROVIDER_KINDS[agent];
  if (provider.protocol === 'native') return fit.native.includes(provider.kind);
  return fit.compatible.includes(provider.protocol);
}
