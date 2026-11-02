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

export type ResolvedToolPolicy = Required<Omit<ToolPolicy, 'httpAllowlist'>> & {
  /** Null allows every public host. */
  httpAllowlist: string[] | null;
};

/** A stored policy with the defaults filled in; anything unreadable counts as empty. */
export function resolveToolPolicy(stored: unknown): ResolvedToolPolicy {
  const parsed = ToolPolicySchema.safeParse(stored ?? {});
  const policy = parsed.success ? parsed.data : {};
  return {
    tools: { ...DEFAULT_TOOL_POLICY.tools, ...policy.tools },
    groups: { ...DEFAULT_TOOL_POLICY.groups, ...policy.groups },
    triggers: mergeTriggers(DEFAULT_TOOL_POLICY.triggers, policy.triggers ?? {}),
    httpAllowlist: policy.httpAllowlist ?? null,
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
