import { z } from 'zod';
import { defineWidget } from './types.js';

// An approval request (plan 12.2, P1, T5). Posted by the run when the policy
// answers `ask` for a tool call, backed by an `approvals` row. Approve runs
// the tool and the run continues with its result; Deny continues with a
// "Denied by owner" result carrying the owner's note. Unanswered requests
// expire after 24 hours and count as denied. Replies in the message's thread
// reach the Bot as context when the run resumes (C7).

const DecisionSchema = z.enum(['auto', 'ask', 'deny']);

export const ApprovalPropsSchema = z.strictObject({
  tool_name: z.string().min(1).max(200),
  /** The call's full arguments, for the details view. */
  args: z.unknown(),
  /** A one-line, human-readable version of `args`. */
  summary: z.string().max(2_000).optional(),
  /** Why the policy asked. */
  reason: z.string().max(500).nullable(),
  /** Every policy rule that applied, in order; the last one decided. */
  trace: z
    .array(
      z.strictObject({
        rule: z.string().min(1).max(32),
        decision: DecisionSchema,
        why: z.string().max(500),
      }),
    )
    .max(16)
    .optional(),
});

export const ApprovalActionSchema = z.strictObject({
  type: z.enum(['approve', 'deny']),
  note: z.string().trim().min(1).max(2_000).optional(),
});

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalState {
  status: ApprovalStatus;
  note?: string;
}

/** The tool result a run gets for a denied or expired request. */
export const DENIED_BY_OWNER = 'Denied by owner';

export interface ApprovalOutcome {
  approved: boolean;
  error?: string;
  note?: string;
}

export const approvalWidget = defineWidget({
  kind: 'approval',
  description: 'A request to approve or deny one tool call',
  props: ApprovalPropsSchema,
  action: ApprovalActionSchema,
  botEmits: false,
  initialState: (): ApprovalState => ({ status: 'pending' }),
  reduce: (state: ApprovalState | undefined, action): ApprovalState | string => {
    if (state && state.status !== 'pending') return `This request was already ${state.status}`;
    return {
      status: action.type === 'approve' ? 'approved' : 'denied',
      ...(action.note ? { note: action.note } : {}),
    };
  },
  toolResult: (state: ApprovalState): ApprovalOutcome => {
    const note = state.note ? { note: state.note } : {};
    if (state.status === 'approved') return { approved: true, ...note };
    if (state.status === 'expired') {
      return { approved: false, error: `${DENIED_BY_OWNER}: the request expired unanswered` };
    }
    return { approved: false, error: DENIED_BY_OWNER, ...note };
  },
});

/** Whether a resumed run's answer approves the call; the worker then runs the tool. */
export function isApproved(output: unknown): boolean {
  return (output as ApprovalOutcome | null)?.approved === true;
}
