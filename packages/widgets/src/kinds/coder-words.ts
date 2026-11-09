import { NEEDS_LOGIN, type CoderUsage, type CodingSessionStatus } from '@openbots/shared';
import type { CodingSessionApproval } from './coding_session.js';

// The words the coding agent widgets say, shared by the web renderers and
// the phone so a session or a sign-in reads the same on both. No React here:
// the phone imports it from the package's plain entry.

/** A session's status, as the header says it. */
export const sessionStatusWords: Record<CodingSessionStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Working',
  waiting: 'Waiting for you',
  settled: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** How an approval the session asked for ended. */
export const approvalStatusWords: Record<
  Exclude<CodingSessionApproval['status'], 'pending'>,
  string
> = {
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired unanswered',
};

/** What the session's error line says; a bare `needs_login` marker becomes a sentence. */
export function sessionErrorWords(error: string): string {
  return error.trim() === NEEDS_LOGIN ? 'Not signed in. Sign in under Settings > Models.' : error;
}

/** Tokens and cost, or null when the vendor billed the owner's subscription. */
export function usageWords(usage: CoderUsage): string | null {
  if (usage.billed === 'subscription') return null;
  const tokens = `${usage.input_tokens.toLocaleString('en-US')} in / ${usage.output_tokens.toLocaleString('en-US')} out tokens`;
  return usage.cost_usd !== undefined ? `${tokens}, $${usage.cost_usd.toFixed(2)}` : tokens;
}
