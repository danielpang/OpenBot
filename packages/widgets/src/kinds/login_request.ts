import { z } from 'zod';
import { defineWidget } from './types.js';

// A sign-in request (K1, K8). A Bot that needs a login it does not have calls
// `request_login`. With a main Bot set, the server posts this widget in the
// main Bot's transcript, authored by the main Bot, and the asking Bot waits;
// another Bot asking for the same site while it is pending joins it
// (`waiting`) instead of asking again. Without one, or when the main Bot
// asks, it goes in the asking Bot's own transcript. Take over opens the
// screen of `screen_bot_id`, on `url` when given, so the owner signs in
// there; the login reaches every Bot through the computer's shared cookies.
// Done and Can't sign in resume every waiting run. Unanswered, the request
// expires at `expires_at` (OPENBOTS_APPROVAL_TTL_MINUTES, like an approval) and
// every waiting run resumes told so.

const BotRefSchema = z.strictObject({
  bot_id: z.uuid(),
  handle: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const LoginRequestPropsSchema = z.strictObject({
  /** The site, as a host name: `github.com`. */
  site: z.string().min(1).max(253),
  /** Where to sign in; the screen's browser opens it on Take over. */
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_000)
    .optional(),
  /** Why the Bot needs it, in its words. */
  reason: z.string().min(1).max(1_000),
  /** The Bot that asked first. */
  requester: BotRefSchema,
  /** The Bot whose screen the owner signs in on: the main Bot, or the requester. */
  screen_bot_id: z.uuid(),
});

export const LoginRequestActionSchema = z.strictObject({
  type: z.enum(['done', 'cant']),
});

export type LoginRequestStatus = 'pending' | 'signed_in' | 'failed' | 'expired';

/** A run of another Bot waiting on the main Bot's request. */
export interface LoginRequestWaiter {
  run_id: string;
  bot_id: string;
  handle: string;
  /** Why this Bot needs the login, in its words. */
  reason?: string;
}

export interface LoginRequestState {
  status: LoginRequestStatus;
  /** Runs waiting on the request in the main Bot's transcript. */
  waiting?: LoginRequestWaiter[];
  /** When an unanswered request expires (ISO 8601). */
  expires_at?: string;
}

export interface LoginRequestOutcome {
  signed_in: boolean;
  note: string;
}

export const loginRequestWidget = defineWidget({
  kind: 'login_request',
  description: 'A request for the owner to sign in to a site on the computer',
  props: LoginRequestPropsSchema,
  action: LoginRequestActionSchema,
  botEmits: false,
  initialState: (): LoginRequestState => ({ status: 'pending' }),
  reduce: (state: LoginRequestState | undefined, action): LoginRequestState | string => {
    if (state?.status === 'expired') return 'This sign-in request expired';
    if (state && state.status !== 'pending') return 'This sign-in request was already answered';
    return { ...state, status: action.type === 'done' ? 'signed_in' : 'failed' };
  },
  toolResult: (state: LoginRequestState): LoginRequestOutcome => {
    switch (state.status) {
      case 'signed_in':
        return {
          signed_in: true,
          note: 'The owner signed in. Every Bot on the computer shares the login now: try the site again.',
        };
      case 'expired':
        return {
          signed_in: false,
          note: 'The sign-in request expired before the owner answered it. Do not ask for their password. Carry on without the site, or tell the owner what you could not do.',
        };
      default:
        return {
          signed_in: false,
          note: 'The owner could not sign in. Do not ask for their password. Carry on without the site, or tell the owner what you could not do.',
        };
    }
  },
});
