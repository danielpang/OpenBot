import { describe, expect, it } from 'vitest';
import { rateLimitResetMs } from './common.js';

describe('rate limit resets', () => {
  it('reads the reset a vendor states, or none', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(rateLimitResetMs('Please try again in 20s', now)).toBe(20_000);
    expect(rateLimitResetMs('Rate limit reached. Try again in 1m30s.', now)).toBe(90_000);
    expect(rateLimitResetMs('retry after 5 minutes', now)).toBe(300_000);
    expect(rateLimitResetMs('429\nretry-after: 12', now)).toBe(12_000);
    expect(rateLimitResetMs('Claude AI usage limit reached|1793959200', now)).toBe(
      1793959200 * 1000 - now,
    );
    expect(rateLimitResetMs('limit resets at 2026-11-05T10:05:00Z', now)).toBe(300_000);
    expect(rateLimitResetMs('429 Too Many Requests', now)).toBeNull();
  });
});
