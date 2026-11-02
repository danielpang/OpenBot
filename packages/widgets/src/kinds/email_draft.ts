import { z } from 'zod';
import { defineWidget } from './types.js';

// An email draft (plan 12.2, W1, W2): From, To, Subject and body, editable,
// with Send. The Bot posts it with `show_widget`; Send stores the edited draft
// and starts a run that calls `send_email` with it, so the send goes through
// the Bot's policy (approval by default) and then the email built-in.

const Address = z.string().trim().min(3).max(320);

export const EmailDraftPropsSchema = z.strictObject({
  /** The sending account or address; the email built-in's default when absent. */
  from: Address.optional(),
  to: z.array(Address).min(1).max(50),
  cc: z.array(Address).max(50).optional(),
  subject: z.string().max(998),
  body: z.string().max(100_000),
});

export type EmailDraft = z.infer<typeof EmailDraftPropsSchema>;

/** Send, with whatever the owner edited; fields left out keep the Bot's draft. */
export const EmailDraftActionSchema = z.strictObject({
  type: z.literal('send'),
  from: Address.optional(),
  to: z.array(Address).min(1).max(50).optional(),
  cc: z.array(Address).max(50).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(100_000).optional(),
});

export interface EmailDraftState {
  /** `sent` and `failed` are set by the email built-in once the send runs. */
  status: 'draft' | 'sending' | 'sent' | 'failed';
  /** The draft as sent, edits included. */
  draft?: EmailDraft;
}

/** The `send_email` arguments for a draft. */
export function sendEmailArgs(draft: EmailDraft) {
  return {
    ...(draft.from ? { from: draft.from } : {}),
    to: draft.to,
    ...(draft.cc?.length ? { cc: draft.cc } : {}),
    subject: draft.subject,
    body: draft.body,
  };
}

export const emailDraftWidget = defineWidget({
  kind: 'email_draft',
  description: 'An email draft the owner can edit and send (From, To, Subject, body)',
  props: EmailDraftPropsSchema,
  action: EmailDraftActionSchema,
  botEmits: true,
  initialState: (): EmailDraftState => ({ status: 'draft' }),
  reduce: (state: EmailDraftState | undefined, action, props): EmailDraftState | string => {
    if (state && state.status !== 'draft' && state.status !== 'failed') {
      return 'This email was already sent';
    }
    const { type: _send, ...edits } = action;
    return { status: 'sending', draft: { ...props, ...edits } };
  },
  toolCall: (state: EmailDraftState) =>
    state.draft ? { toolName: 'send_email', args: sendEmailArgs(state.draft) } : null,
});
