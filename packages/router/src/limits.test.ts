import { describe, expect, it } from 'vitest';
import {
  chainLimitsFor,
  DEFAULT_CHAIN_LIMITS,
  loopStoppedDetail,
  withinChainLimits,
} from './limits.js';

describe('loop guards', () => {
  it('defaults to depth 6 and 20 Bot-triggered runs per 10 minutes', () => {
    expect(DEFAULT_CHAIN_LIMITS).toEqual({
      maxChainDepth: 6,
      botRunBudget: 20,
      budgetWindowMs: 600_000,
    });
  });

  it('stops a chain deeper than the cap', () => {
    expect(withinChainLimits({ depth: 6, botTriggered: true, recentBotRuns: 0 })).toEqual({
      ok: true,
    });
    expect(withinChainLimits({ depth: 7, botTriggered: true, recentBotRuns: 0 })).toEqual({
      ok: false,
      reason: 'depth',
    });
  });

  it('stops Bot-triggered runs once the budget is spent, but never the owner', () => {
    expect(withinChainLimits({ depth: 2, botTriggered: true, recentBotRuns: 19 }).ok).toBe(true);
    expect(withinChainLimits({ depth: 2, botTriggered: true, recentBotRuns: 20 })).toEqual({
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
      'Stopped a Bot loop: the chain of Bot replies reached 6 steps.',
    );
    expect(loopStoppedDetail('budget', DEFAULT_CHAIN_LIMITS)).toBe(
      'Stopped a Bot loop: Bots started 20 runs in this chat in 10 minutes.',
    );
  });
});
