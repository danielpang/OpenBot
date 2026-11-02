import {
  resolveToolPolicy,
  sourceOfTrigger,
  SOURCE_TRIGGER,
  stricterDecision,
  type PolicyDecision,
  type RunSource,
  type TriggerOverride,
} from '@openbots/shared';
import type { Policy, PolicyEvaluation, PolicyTraceStep } from './policy.js';
import { hostAllowed } from '../tools/builtin.js';
import { defaultRule, type ToolFacts } from './rules.js';

// The policy engine (plan 8, T5). A pure function of the tool, its arguments,
// the run's trigger and the owner's settings, returning the decision and the
// trace of every rule that applied. Order, most specific last:
//
//   default (by name, annotations, group) -> Bot group setting
//   -> connector approval override -> Bot tool setting
//   -> trigger overrides, which can only make the decision stricter.
//
// The trigger overrides are the run's trigger's, then the ones for its source
// when another Bot or a webhook wrote what started it (`bot_dm` or `webhook`,
// whatever the trigger: a Bot's @mention, a Routine run a delivery started),
// then the webhook endpoint's own. A run webhook data started also asks
// before a GET fetch from a host outside the Bot's domain allowlist: a query
// string can carry data out (P2, S-10).

export interface PolicyInput {
  toolName: string;
  args: unknown;
  facts: ToolFacts;
  trigger: string;
  /** Who wrote what started the run; defaults to what the trigger implies. */
  source?: RunSource;
  /** `bots.tool_policy` as stored; unreadable values count as empty. */
  toolPolicy?: unknown;
  /** An override carried by what started the run, e.g. a webhook endpoint's. */
  triggerOverride?: TriggerOverride | null;
}

export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  const { toolName, facts } = input;
  const policy = resolveToolPolicy(input.toolPolicy);
  const base = defaultRule(toolName, input.args, facts);
  const trace: PolicyTraceStep[] = [{ rule: base.rule, decision: base.decision, why: base.why }];

  const set = (step: PolicyTraceStep) => trace.push(step);
  const group = policy.groups[facts.group];
  if (group) {
    set({ rule: 'group', decision: group, why: `Bot setting for ${facts.group} tools` });
  }
  const override = facts.connector?.approvalOverride;
  if (override) {
    set({
      rule: 'connector',
      decision: override,
      why: `Bot setting for the ${facts.connector!.slug} connector`,
    });
  }
  const own = policy.tools[toolName];
  if (own) set({ rule: 'tool', decision: own, why: `Bot setting for ${toolName}` });

  const source = input.source ?? sourceOfTrigger(input.trigger);
  const overrides: [string, TriggerOverride | null | undefined][] = [
    [`${input.trigger} runs`, policy.triggers[input.trigger as keyof typeof policy.triggers]],
  ];
  if (source !== 'owner' && SOURCE_TRIGGER[source] !== input.trigger) {
    overrides.push([SOURCE_RUNS[source], policy.triggers[SOURCE_TRIGGER[source]]]);
  }
  overrides.push([
    source === 'webhook' ? 'this webhook' : `this ${input.trigger}`,
    input.triggerOverride,
  ]);
  for (const [source, rules] of overrides) {
    if (!rules) continue;
    const floor = triggerFloor(rules, toolName, facts, base.sideEffects);
    const current = trace.at(-1)!.decision;
    if (!floor || stricterDecision(current, floor) === current) continue;
    set({ rule: 'trigger', decision: floor, why: `Stricter rule for ${source}` });
  }
  if (source === 'webhook' && base.fetchHost !== undefined) {
    const host = base.fetchHost;
    const current = trace.at(-1)!.decision;
    if (current === 'auto' && !(host && hostAllowed(host, policy.httpAllowlist ?? []))) {
      set({
        rule: 'trigger',
        decision: 'ask',
        why: `Webhook runs ask before fetching from ${host ?? 'a host'} outside the Bot's domain allowlist`,
      });
    }
  }

  const last = trace.at(-1)!;
  return { decision: last.decision, reason: last.why, trace };
}

/** How the trace names the source's rules when the trigger does not already. */
const SOURCE_RUNS = {
  bot: "runs another Bot's message started",
  webhook: 'runs a webhook started',
} as const;

function triggerFloor(
  rules: TriggerOverride,
  toolName: string,
  facts: ToolFacts,
  sideEffects: boolean,
): PolicyDecision | undefined {
  return (
    rules.tools?.[toolName] ??
    rules.groups?.[facts.group] ??
    (sideEffects ? rules.default : undefined)
  );
}

export interface PolicySource {
  /** `bots.tool_policy`. */
  toolPolicy?: unknown;
  triggerOverride?: TriggerOverride | null;
  /** The facts for a tool in this run; unknown tools are judged by their name. */
  facts(toolName: string): ToolFacts | undefined;
}

/** A `Policy` for one run's tools and the Bot's settings. */
export function createPolicy(source: PolicySource): Policy {
  return {
    evaluate: (run, toolName, args) =>
      evaluatePolicy({
        toolName,
        args,
        trigger: run.trigger,
        ...(run.source ? { source: run.source } : {}),
        facts: source.facts(toolName) ?? guessFacts(toolName),
        toolPolicy: source.toolPolicy,
        triggerOverride: source.triggerOverride ?? null,
      }),
  };
}

/** MCP tools are named `<connector>__<tool>` (plan 8); anything else is a built-in. */
export function guessFacts(toolName: string): ToolFacts {
  const split = toolName.indexOf('__');
  return split > 0
    ? { group: 'connector', connector: { slug: toolName.slice(0, split) } }
    : { group: 'builtin' };
}
