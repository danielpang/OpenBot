// Loop guards (plan 7). Every run a message starts is one link deeper than the
// run that wrote the message; a chain stops at `maxChainDepth`. Runs started
// by a Bot's message (they have a parent run) also draw on a rolling budget
// per chat. Either guard posts a visible "Stopped a Bot loop" event row.

export interface ChainLimits {
  /** The deepest run a chain may start; an owner's message starts depth 1. */
  maxChainDepth: number;
  /** Bot-triggered runs a chat may start per `budgetWindowMs`. */
  botRunBudget: number;
  budgetWindowMs: number;
}

export const DEFAULT_CHAIN_LIMITS: ChainLimits = {
  maxChainDepth: 6,
  botRunBudget: 20,
  budgetWindowMs: 10 * 60_000,
};

export const LOOP_STOPPED_TEXT = 'Stopped a Bot loop';

/**
 * The limits for a chat: `chats.settings` may carry `max_chain_depth` and
 * `bot_run_budget` (positive integers); anything else keeps the default. No
 * API or UI writes them in 1.0, so the defaults apply unless an operator sets
 * them in the database.
 */
export function chainLimitsFor(settings: unknown): ChainLimits {
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const positive = (v: unknown) =>
    Number.isInteger(v) && (v as number) > 0 ? (v as number) : null;
  return {
    ...DEFAULT_CHAIN_LIMITS,
    maxChainDepth: positive(s.max_chain_depth) ?? DEFAULT_CHAIN_LIMITS.maxChainDepth,
    botRunBudget: positive(s.bot_run_budget) ?? DEFAULT_CHAIN_LIMITS.botRunBudget,
  };
}

export interface ChainCandidate {
  /** The depth the new run would have. */
  depth: number;
  /** Whether a Bot's message (not the owner's) would start it. */
  botTriggered: boolean;
  /** Bot-triggered runs already started in the chat within the window. */
  recentBotRuns: number;
}

export type ChainCheck = { ok: true } | { ok: false; reason: 'depth' | 'budget' };

export function withinChainLimits(
  candidate: ChainCandidate,
  limits: ChainLimits = DEFAULT_CHAIN_LIMITS,
): ChainCheck {
  if (candidate.depth > limits.maxChainDepth) return { ok: false, reason: 'depth' };
  if (candidate.botTriggered && candidate.recentBotRuns >= limits.botRunBudget) {
    return { ok: false, reason: 'budget' };
  }
  return { ok: true };
}

/** The event row's wording for a stopped chain. */
export function loopStoppedDetail(reason: 'depth' | 'budget', limits: ChainLimits): string {
  return reason === 'depth'
    ? `${LOOP_STOPPED_TEXT}: the chain of Bot replies reached ${limits.maxChainDepth} steps.`
    : `${LOOP_STOPPED_TEXT}: Bots started ${limits.botRunBudget} runs in this chat in ${Math.round(
        limits.budgetWindowMs / 60_000,
      )} minutes.`;
}
