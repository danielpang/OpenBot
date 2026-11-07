import {
  NEEDS_LOGIN,
  type CoderAgent,
  type CoderUsage,
  type CodingSessionStatus,
} from '@openbots/shared';
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

/** What a plan sign-in bills, by agent: the usage line of a settled session. */
export const PLAN_WORDS: Record<CoderAgent, string> = {
  claude: 'Billed to your Claude plan',
  codex: 'Billed to your ChatGPT plan',
  // pi names no vendor: it signs in to whichever provider the owner picks.
  pi: 'Billed to your plan',
};

/**
 * The plan an agent's subscription sign-in bills, for the line after
 * "Sign in to …": the usage line's words, lower case. pi signs in inside its
 * own terminal, so its sign-in has no such line.
 */
export const CODER_PLAN_WORDS: Record<CoderAgent, string | null> = {
  claude: lowerFirst(PLAN_WORDS.claude),
  codex: lowerFirst(PLAN_WORDS.codex),
  pi: null,
};

/** pi signed in with a Claude plan: Anthropic bills that as extra usage, not against the plan. */
export const PI_CLAUDE_PLAN_WORDS = `${lowerFirst(PLAN_WORDS.claude)} as extra usage`;

/** Whose plan a subscription sign-in bills, as the server's account view says (`planProvider`). */
export type CoderPlanProvider = 'anthropic' | 'openai' | 'other' | null;

/**
 * What a signed-in plan bills, for Settings > Coding agents. pi signs in to
 * whichever provider the owner picks, so its words follow `planProvider`: a
 * Claude plan through pi is extra usage, a ChatGPT plan is the plan. A
 * settled session's usage line cannot know the provider and stays on
 * `usageWords`.
 */
export function coderPlanWords(agent: CoderAgent, planProvider: CoderPlanProvider): string {
  if (agent === 'pi') {
    if (planProvider === 'anthropic') return PI_CLAUDE_PLAN_WORDS;
    if (planProvider === 'openai') return lowerFirst(PLAN_WORDS.codex);
  }
  return CODER_PLAN_WORDS[agent] ?? lowerFirst(PLAN_WORDS[agent]);
}

function lowerFirst(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** What the session's error line says; a bare `needs_login` marker becomes a sentence. */
export function sessionErrorWords(error: string): string {
  return error.trim() === NEEDS_LOGIN
    ? 'Not signed in. Sign in under Settings > Coding agents.'
    : error;
}

/** Tokens and cost, or the plan when the vendor billed the owner's subscription. */
export function usageWords(usage: CoderUsage, agent: CoderAgent): string {
  if (usage.billed === 'subscription') return PLAN_WORDS[agent];
  const tokens = `${usage.input_tokens.toLocaleString('en-US')} in / ${usage.output_tokens.toLocaleString('en-US')} out tokens`;
  return usage.cost_usd !== undefined ? `${tokens}, $${usage.cost_usd.toFixed(2)}` : tokens;
}
