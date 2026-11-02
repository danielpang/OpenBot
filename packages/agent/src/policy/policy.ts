import type { PolicyDecision, RunSource } from '@openbots/shared';

// Tool policy (plan 5.5, P1). Every tool call is evaluated before it runs:
// `auto` runs it, `ask` pauses the run for the owner's approval, `deny`
// refuses it. `createPolicy` (engine.ts) is the real rule set; a test or a
// caller with its own rules can implement `Policy` directly.

export type { PolicyDecision } from '@openbots/shared';

/** The run as the policy sees it. */
export interface PolicyRun {
  id: string;
  botId: string;
  chatId: string | null;
  trigger: string;
  /**
   * Who wrote what started the run (P2); defaults to what the trigger implies
   * (`sourceOfTrigger`). The server knows a Bot's @mention from the owner's.
   */
  source?: RunSource;
}

/** Which rule set a decision, for the decision trace. */
export type PolicyRule = 'default' | 'annotations' | 'group' | 'connector' | 'tool' | 'trigger';

export interface PolicyTraceStep {
  rule: PolicyRule;
  decision: PolicyDecision;
  /** One line for the owner: why this rule decided what it did. */
  why: string;
}

/** A decision with the reasons behind it; the approval widget shows them. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** The `why` of the step that settled the decision. */
  reason: string;
  /** Every rule that applied, in order; the last one wins. */
  trace: PolicyTraceStep[];
}

export interface Policy {
  evaluate(
    run: PolicyRun,
    toolName: string,
    args: unknown,
  ): PolicyDecision | PolicyEvaluation | Promise<PolicyDecision | PolicyEvaluation>;
}

/** Runs every tool without asking; for tests and tools that need no gate. */
export const defaultPolicy: Policy = {
  evaluate: () => 'auto',
};

export function asEvaluation(result: PolicyDecision | PolicyEvaluation): PolicyEvaluation {
  return typeof result === 'string' ? { decision: result, reason: '', trace: [] } : result;
}
