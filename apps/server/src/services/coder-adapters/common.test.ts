import { describe, expect, it } from 'vitest';
import { preamble, rateLimitResetMs } from './common.js';
import { DEFAULT_CODER_ACTIONS } from '@openbots/shared';
import type { CoderSessionSpec } from './types.js';

const spec: CoderSessionSpec = {
  sessionId: 'session',
  agent: 'codex',
  mode: 'edit',
  prompt: 'Fix the bug',
  worktreePath: '/repo/.worktrees/fix',
  repoFullName: 'acme/app',
  branch: 'bot/fix',
  base: 'main',
  maxTurns: 10,
  actions: DEFAULT_CODER_ACTIONS,
};

describe('publishing instructions', () => {
  it.each(['edit', 'pr'] as const)(
    'automatically publishes %s work through OpenBots, not shell or other PR tools',
    (mode) => {
      const prompt = preamble({ ...spec, mode });
      expect(prompt).toContain('automatically call the OpenBots publish_pull_request tool');
      expect(prompt).toContain('Do not wait for the user to ask for a PR');
      expect(prompt).toContain('Do not run git push, gh pr create');
      expect(prompt).toContain('Do not change repository Git configuration');
    },
  );
  it('never instructs a plan-only agent to publish', () => {
    const prompt = preamble({ ...spec, mode: 'plan' });
    expect(prompt).not.toContain('publish_pull_request');
    expect(prompt).toContain('do not edit files');
  });
});

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
