import { labelFor, type LabelContext } from './activity/labels.js';
import {
  asEvaluation,
  summarizeArgs,
  type Policy,
  type PolicyRun,
  type PolicyTraceStep,
} from './policy/index.js';

// Waiting (plan 5.6) and the gated tool wrapper (plan 5.5). A tool that needs
// the owner throws a `WaitFor`; the run loop catches it, stops after the
// current step, and the worker persists the run until the owner answers.
// Questions (`ask_user`), approvals (`NeedsApproval`, Phase 2 rules) and
// interactive widgets share this one path.

export type WaitingReason = 'question' | 'approval' | 'widget';

export interface WaitRequest {
  reason: WaitingReason;
  /** The widget posted for the owner to act on; its answer becomes the tool result. */
  widget: { kind: string; props: unknown };
  /** The roster hover text while waiting (I3). */
  label: string;
  /**
   * The widget is already posted, in another Bot's transcript (a sign-in
   * request the main Bot asks for, K8): the run waits on it there and posts
   * no widget of its own.
   */
  posted?: { messageId: string; partIndex: number };
}

export class WaitFor extends Error {
  constructor(readonly request: WaitRequest) {
    super(`waiting for the owner: ${request.reason}`);
    this.name = 'WaitFor';
  }
}

/**
 * Thrown by `gated` when the policy answers `ask`. The widget props are the
 * `approval` kind's: the tool, its arguments with a one-line summary, and why
 * the policy asked, with the full decision trace.
 */
export class NeedsApproval extends WaitFor {
  constructor(
    readonly toolName: string,
    readonly args: unknown,
    reason: string | null = null,
    trace: PolicyTraceStep[] = [],
    labels: LabelContext = {},
  ) {
    super({
      reason: 'approval',
      widget: {
        kind: 'approval',
        props: {
          tool_name: toolName,
          args: args ?? {},
          summary: summarizeArgs(toolName, args),
          reason,
          ...(trace.length ? { trace } : {}),
        },
      },
      label: `Waiting for approval: ${labelFor(toolName, args, undefined, labels).toLowerCase()}`,
    });
    this.name = 'NeedsApproval';
  }
}

export const DENIED_RESULT = { error: 'Denied by Bot policy' } as const;

export interface GatedCall {
  run: PolicyRun;
  policy: Policy;
  toolName: string;
  args: unknown;
  /** Bot state while the tool runs: `working` with the in-progress label (plan 6.1). */
  onStart: (currentAction: string) => Promise<void> | void;
  execute: () => Promise<unknown>;
  /** Connector name and tool title for the labels. */
  labels?: LabelContext;
}

export async function gated({ run, policy, toolName, args, onStart, execute, labels }: GatedCall) {
  const { decision, reason, trace } = asEvaluation(await policy.evaluate(run, toolName, args));
  if (decision === 'deny') return DENIED_RESULT;
  if (decision === 'ask') throw new NeedsApproval(toolName, args, reason || null, trace, labels);
  await onStart(labelFor(toolName, args, undefined, labels));
  return execute();
}
