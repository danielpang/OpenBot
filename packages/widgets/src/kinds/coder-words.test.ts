import { NEEDS_LOGIN } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import {
  approvalStatusWords,
  sessionErrorWords,
  sessionStatusWords,
  usageWords,
} from '../index.js';

describe('coder words', () => {
  it('says nothing for a plan sign-in, else the tokens and cost', () => {
    expect(usageWords({ input_tokens: 1, output_tokens: 2, billed: 'subscription' })).toBeNull();
    expect(
      usageWords({ input_tokens: 12000, output_tokens: 600, cost_usd: 0.4, billed: 'api' }),
    ).toBe('12,000 in / 600 out tokens, $0.40');
    expect(usageWords({ input_tokens: 5, output_tokens: 6, billed: 'unknown' })).toBe(
      '5 in / 6 out tokens',
    );
    expect(
      usageWords({ input_tokens: 1200, output_tokens: 30, cost_usd: 0.123, billed: 'api' }),
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
});
