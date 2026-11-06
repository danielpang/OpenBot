import { describe, expect, it } from 'vitest';
import {
  chainLimitsFor,
  DEFAULT_CHAIN_LIMITS,
  loopStoppedDetail,
  withinChainLimits,
} from './limits.js';

describe('loop guards', () => {
  it('defaults to depth 4 and 10 Bot-triggered runs per 10 minutes', () => {
    expect(DEFAULT_CHAIN_LIMITS).toEqual({
      maxChainDepth: 4,
      botRunBudget: 10,
      budgetWindowMs: 600_000,
    });
  });

  it('stops a chain deeper than the cap', () => {
    expect(withinChainLimits({ depth: 4, botTriggered: true, recentBotRuns: 0 })).toEqual({
      ok: true,
    });
    expect(withinChainLimits({ depth: 5, botTriggered: true, recentBotRuns: 0 })).toEqual({
      ok: false,
      reason: 'depth',
    });
  });

  it('stops Bot-triggered runs once the budget is spent, but never the owner', () => {
    expect(withinChainLimits({ depth: 2, botTriggered: true, recentBotRuns: 9 }).ok).toBe(true);
    expect(withinChainLimits({ depth: 2, botTriggered: true, recentBotRuns: 10 })).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(withinChainLimits({ depth: 1, botTriggered: false, recentBotRuns: 50 }).ok).toBe(true);
  });

  it('reads per-chat overrides from chats.settings', () => {
    expect(chainLimitsFor({ max_chain_depth: 2, bot_run_budget: 3 })).toMatchObject({
      maxChainDepth: 2,
      botRunBudget: 3,
    });
    expect(chainLimitsFor({ max_chain_depth: 0, bot_run_budget: 'x' })).toEqual(
      DEFAULT_CHAIN_LIMITS,
    );
    expect(chainLimitsFor(null)).toEqual(DEFAULT_CHAIN_LIMITS);
  });

  it('says which guard tripped', () => {
    expect(loopStoppedDetail('depth', DEFAULT_CHAIN_LIMITS)).toBe(
      'Stopped a Bot loop: the chain of Bot replies reached 4 steps.',
    );
    expect(loopStoppedDetail('budget', DEFAULT_CHAIN_LIMITS)).toBe(
      'Stopped a Bot loop: Bots started 10 runs in this chat in 10 minutes.',
    );
  });
});
