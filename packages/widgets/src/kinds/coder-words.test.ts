import { NEEDS_LOGIN } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import {
  CODER_PLAN_WORDS,
  coderPlanWords,
  PI_CLAUDE_PLAN_WORDS,
  approvalStatusWords,
  sessionErrorWords,
  sessionStatusWords,
  usageWords,
} from '../index.js';

describe('coder words', () => {
  it("says each agent's plan in the usage line, else the tokens and cost", () => {
    const usage = { input_tokens: 1, output_tokens: 2, billed: 'subscription' } as const;
    expect(usageWords(usage, 'claude')).toBe('Billed to your Claude plan');
    expect(usageWords(usage, 'codex')).toBe('Billed to your ChatGPT plan');
    expect(usageWords(usage, 'pi')).toBe('Billed to your plan');
    expect(
      usageWords(
        { input_tokens: 12000, output_tokens: 600, cost_usd: 0.4, billed: 'api' },
        'claude',
      ),
    ).toBe('12,000 in / 600 out tokens, $0.40');
    expect(usageWords({ input_tokens: 5, output_tokens: 6, billed: 'unknown' }, 'pi')).toBe(
      '5 in / 6 out tokens',
    );
    expect(
      usageWords({ input_tokens: 1200, output_tokens: 30, cost_usd: 0.123, billed: 'api' }, 'pi'),
    ).toBe('1,200 in / 30 out tokens, $0.12');
  });

  it('says a needs_login marker as a sentence and other errors as they are', () => {
    expect(sessionErrorWords(` ${NEEDS_LOGIN} `)).toMatch(/^Not signed in\./);
    expect(sessionErrorWords('git failed')).toBe('git failed');
  });

  it('has one word for every status', () => {
    expect(Object.values(sessionStatusWords)).toEqual([
      'Queued',
      'Starting',
      'Working',
      'Waiting for you',
      'Done',
      'Failed',
      'Stopped',
    ]);
    expect(approvalStatusWords).toEqual({
      approved: 'Approved',
      denied: 'Denied',
      expired: 'Expired unanswered',
    });
  });

  it('says what a plan sign-in bills, and that pi on a Claude plan is extra usage', () => {
    expect(CODER_PLAN_WORDS).toEqual({
      claude: 'billed to your Claude plan',
      codex: 'billed to your ChatGPT plan',
      pi: null,
    });
    expect(PI_CLAUDE_PLAN_WORDS).toBe('billed to your Claude plan as extra usage');
  });

  it('says what pi bills by the provider it signed in to, and the agent words otherwise', () => {
    expect(coderPlanWords('pi', 'anthropic')).toBe('billed to your Claude plan as extra usage');
    expect(coderPlanWords('pi', 'openai')).toBe('billed to your ChatGPT plan');
    expect(coderPlanWords('pi', 'other')).toBe('billed to your plan');
    expect(coderPlanWords('pi', null)).toBe('billed to your plan');
    expect(coderPlanWords('claude', null)).toBe('billed to your Claude plan');
    expect(coderPlanWords('codex', 'openai')).toBe('billed to your ChatGPT plan');
    // The session usage line stays on `billed`: it cannot know the provider.
    expect(usageWords({ input_tokens: 1, output_tokens: 2, billed: 'subscription' }, 'pi')).toBe(
      'Billed to your plan',
    );
  });
});
