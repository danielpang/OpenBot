import { z } from 'zod';

// Tool policy (plan 8, T5, P1): what a Bot may do without asking. Stored in
// `bots.tool_policy` and edited in Bot Settings (`PATCH /bots/:id`
// `toolPolicy`). The rules that read it live in `@openbots/agent`'s policy
// engine; this file is the stored shape and its defaults.
//
// Each tool call gets one decision: `auto` runs it, `ask` pauses the run for
// the owner's approval, `deny` refuses it. The most specific setting wins:
//
// 1. the built-in default for the tool (reads auto; `bash`, file writes,
//    non-GET `http_request`, `send_email` and non-read-only MCP tools ask),
// 2. `groups[<group>]`, then the connector's `approval_override` for its tools,
// 3. `tools[<name>]` (MCP tools are named `<connector>__<tool>`),
// 4. then `triggers[<trigger>]` can make a run started by that trigger
//    stricter, never looser (a webhook run that may not send email, say).
//    A run another Bot or a webhook started also gets the entry for its
//    source (`SOURCE_TRIGGER`), whatever its trigger.

export const PolicyDecisionSchema = z.enum(['auto', 'ask', 'deny']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** Tool groups (plan 5.4); each tool belongs to one. */
export const ToolGroupNameSchema = z.enum([
  'conversation',
  'artifacts',
  'builtin',
  'connector',
  'computer',
  'coder',
]);
export type ToolGroupName = z.infer<typeof ToolGroupNameSchema>;

/** What starts a run (plan 5.1). */
export const RunTriggerSchema = z.enum([
  'message',
  'mention',
  'bot_message',
  'bot_dm',
  'widget_action',
  'webhook',
  'routine',
  'resume',
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/**
 * Who wrote what started a run (P2): the owner, another Bot, or a webhook
 * delivery. The trigger alone does not say: a Bot's @mention of another Bot
 * arrives as `mention`, like the owner's, and a Routine run a delivery
 * started is a `routine` run. A run another Bot or a webhook started gets the
 * rules of `SOURCE_TRIGGER` on top of its own trigger's.
 */
export const RunSourceSchema = z.enum(['owner', 'bot', 'webhook']);
export type RunSource = z.infer<typeof RunSourceSchema>;

/**
 * The trigger entry whose rules cover every run from a source: `bot_dm` for
 * any run another Bot's message starts (a Bot to Bot message or a Bot's
 * @mention), `webhook` for any run webhook data starts.
 */
export const SOURCE_TRIGGER = { bot: 'bot_dm', webhook: 'webhook' } as const satisfies Record<
  Exclude<RunSource, 'owner'>,
  RunTrigger
>;

/** The source a trigger implies when nothing else is known: only `bot_dm` and `webhook` say. */
export function sourceOfTrigger(trigger: string): RunSource {
  if (trigger === 'webhook') return 'webhook';
  if (trigger === 'bot_dm') return 'bot';
  return 'owner';
}

/** A host name, or `*.` and a domain for its subdomains; lowercase, no scheme or port. */
export const DomainPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
    message: 'A host like api.example.com, or *.example.com for its subdomains',
  });

// Coding agents (CA9, I7). The agent and action class enums and the per-Bot
// settings live here rather than in coders.ts because `ToolPolicySchema`
// carries them and coders.ts reads this file's helpers: one import direction,
// no cycle. coders.ts re-exports all three, so import them from either.

/** The coding agents a Bot can run on its computer. */
export const CoderAgentSchema = z.enum(['claude', 'codex', 'pi']);
export type CoderAgent = z.infer<typeof CoderAgentSchema>;

/**
 * What a coding agent asks to do, as the approvals bridge classes it (I13):
 * push a branch, open a PR, touch files outside its worktree, install
 * packages, delete or rewrite history, or anything else.
 */
export const CoderActionClassSchema = z.enum([
  'push',
  'pr',
  'outside_worktree',
  'install',
  'destructive',
  'other',
]);
export type CoderActionClass = z.infer<typeof CoderActionClassSchema>;

/** A repository by its full name on its host: `owner/name`. */
const RepoFullNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { message: 'A repository like owner/name' })
  .max(200);

/**
 * A model as its vendor's CLI names it (`--model`): `gpt-5.3-codex` for
 * Codex, `claude-sonnet-4-5` for Claude Code, `anthropic/claude-sonnet-4-5`
 * or `sonnet:high` for pi. It goes into the agent's argv, so it starts with
 * a letter or digit (never read as a flag) and holds no spaces or globs.
 */
export const CoderModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, {
    message: 'A model name like gpt-5.3-codex or anthropic/claude-sonnet-4-5',
  });

/**
 * A Bot's coding agent settings, inside `tool_policy` (`coder`). `enabled`
 * absent means on; `actions` overrides `DEFAULT_CODER_ACTIONS` class by
 * class; `allowedRepos` absent allows every repository the owner keeps,
 * an empty list allows none; `models` picks a model per agent, absent for
 * an agent means the CLI's own default.
 */
export const CoderPolicySchema = z.strictObject({
  enabled: z.boolean().optional(),
  defaultAgent: CoderAgentSchema.optional(),
  actions: z.partialRecord(CoderActionClassSchema, PolicyDecisionSchema).optional(),
  allowedRepos: z.array(RepoFullNameSchema).max(200).optional(),
  models: z.partialRecord(CoderAgentSchema, CoderModelNameSchema).optional(),
});
export type CoderPolicy = z.infer<typeof CoderPolicySchema>;

const ToolDecisionsSchema = z.record(z.string().min(1).max(200), PolicyDecisionSchema);
const GroupDecisionsSchema = z.partialRecord(ToolGroupNameSchema, PolicyDecisionSchema);

/**
 * A stricter override for runs started by one trigger; also the shape of a
 * webhook endpoint's `tool_policy_override` (plan 4.7). Only raises a
 * decision (auto < ask < deny). `default` covers every tool that can change
 * something; read-only tools and conversation tools are left alone.
 */
export const TriggerOverrideSchema = z.strictObject({
  default: PolicyDecisionSchema.optional(),
  groups: GroupDecisionsSchema.optional(),
  tools: ToolDecisionsSchema.optional(),
});
export type TriggerOverride = z.infer<typeof TriggerOverrideSchema>;

export const ToolPolicySchema = z.strictObject({
  /** Per tool, by name; wins over everything but a trigger override. */
  tools: ToolDecisionsSchema.optional(),
  /** Per tool group. */
  groups: GroupDecisionsSchema.optional(),
  /** Stricter rules for runs started by a trigger; merged over `DEFAULT_TOOL_POLICY.triggers`. */
  triggers: z.partialRecord(RunTriggerSchema, TriggerOverrideSchema).optional(),
  /**
   * Hosts `http_request` may call (P2, plan 17): `api.example.com` matches that
   * host, `*.example.com` its subdomains. Absent allows every public host; an
   * empty list allows none. Naming a private host here is the only way to
   * reach one.
   */
  httpAllowlist: z.array(DomainPatternSchema).max(200).optional(),
  /** The Bot's coding agent settings (CA9); see `CoderPolicySchema`. */
  coder: CoderPolicySchema.optional(),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/**
 * What an empty `tool_policy` means. Webhook payloads and other Bots'
 * messages are data, never instructions (P2), so a run they start asks before
 * anything that can change something, even where the Bot's own policy says
 * `auto`. The floor follows who wrote the message (`RunSource`), not the
 * trigger's name: the `bot_dm` entry covers a Bot's @mention too, and the
 * owner's own group messages (`bot_message`, `mention`) get none. The owner
 * lifts one with an explicit `default: 'auto'`.
 */
export const DEFAULT_TOOL_POLICY = {
  tools: {},
  groups: {},
  triggers: {
    webhook: { default: 'ask' },
    bot_dm: { default: 'ask' },
  },
} as const satisfies ToolPolicy;

export type ResolvedToolPolicy = Required<Omit<ToolPolicy, 'httpAllowlist' | 'coder'>> & {
  /** Null allows every public host. */
  httpAllowlist: string[] | null;
  /** As stored; `{}` when absent. `coderActionDecision` fills in the defaults. */
  coder: CoderPolicy;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A stored `coder` section, key by key: a key that does not parse (a model
 * name that reads as a flag, say) is dropped and the rest are kept, so one
 * bad entry does not reset the Bot's other coding settings. Unknown keys
 * are ignored.
 */
function readCoderPolicy(stored: unknown): CoderPolicy {
  if (!isRecord(stored)) return {};
  const coder: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(CoderPolicySchema.shape)) {
    if (!Object.hasOwn(stored, key)) continue;
    const parsed = schema.safeParse(stored[key]);
    if (parsed.success && parsed.data !== undefined) coder[key] = parsed.data;
  }
  return coder as CoderPolicy;
}

/**
 * A stored policy with the defaults filled in. The `coder` section is read
 * on its own (`readCoderPolicy`); anything else unreadable makes the whole
 * policy count as empty.
 */
export function resolveToolPolicy(stored: unknown): ResolvedToolPolicy {
  const raw = stored ?? {};
  const { coder: storedCoder, ...rest } = isRecord(raw) ? raw : { coder: undefined };
  const parsed = ToolPolicySchema.safeParse(isRecord(raw) ? rest : raw);
  const policy = parsed.success ? parsed.data : {};
  return {
    tools: { ...DEFAULT_TOOL_POLICY.tools, ...policy.tools },
    groups: { ...DEFAULT_TOOL_POLICY.groups, ...policy.groups },
    triggers: mergeTriggers(DEFAULT_TOOL_POLICY.triggers, policy.triggers ?? {}),
    httpAllowlist: policy.httpAllowlist ?? null,
    coder: parsed.success ? readCoderPolicy(storedCoder) : {},
  };
}

type TriggerOverrides = NonNullable<ToolPolicy['triggers']>;

/**
 * The owner's trigger overrides over the defaults, trigger by trigger: an
 * owner entry keeps the default's `default` unless it sets `default` itself,
 * and its group and tool settings add to the default's.
 */
function mergeTriggers(defaults: TriggerOverrides, owner: TriggerOverrides): TriggerOverrides {
  const merged: TriggerOverrides = {};
  for (const trigger of RunTriggerSchema.options) {
    const base = defaults[trigger];
    const own = owner[trigger];
    if (!base && !own) continue;
    const decision = own?.default ?? base?.default;
    const groups = { ...base?.groups, ...own?.groups };
    const tools = { ...base?.tools, ...own?.tools };
    merged[trigger] = {
      ...(decision ? { default: decision } : {}),
      ...(Object.keys(groups).length ? { groups } : {}),
      ...(Object.keys(tools).length ? { tools } : {}),
    };
  }
  return merged;
}

const STRICTNESS: Record<PolicyDecision, number> = { auto: 0, ask: 1, deny: 2 };

/** The stricter of two decisions. */
export function stricterDecision(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}
