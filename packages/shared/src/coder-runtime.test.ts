import { describe, expect, it } from 'vitest';
import {
  CODER_APPROVAL_TTL_ENV,
  CODER_CONFIG_DIRS,
  CODER_HOME,
  coderApprovalTtlMs,
  DEFAULT_CODER_APPROVAL_TTL_MS,
  REPOS_DIR,
  RUNNER_HOME,
} from './coder-runtime.js';

describe('coder runtime', () => {
  it('puts the homes and config directories on the state volume, the repositories in the home', () => {
    expect(CODER_HOME).toBe('/var/lib/openbots/coders/home');
    expect(RUNNER_HOME).toBe('/var/lib/openbots/coders/runner-home');
    expect(REPOS_DIR).toBe('/home/bot/repos');
    expect(CODER_CONFIG_DIRS.claude).toEqual({
      env: 'CLAUDE_CONFIG_DIR',
      dir: '/var/lib/openbots/coders/claude',
    });
  });

  it('waits on a prompt as long as an approval by default', () => {
    expect(DEFAULT_CODER_APPROVAL_TTL_MS).toBe(24 * 60 * 60_000);
    expect(coderApprovalTtlMs({})).toBe(DEFAULT_CODER_APPROVAL_TTL_MS);
  });

  it('reads the wait from the environment when it is a positive whole number', () => {
    expect(coderApprovalTtlMs({ [CODER_APPROVAL_TTL_ENV]: '120000' })).toBe(120_000);
    expect(coderApprovalTtlMs({ [CODER_APPROVAL_TTL_ENV]: ' 5000 ' })).toBe(5_000);
    for (const bad of ['', '0', '-1', '1.5', 'soon', '1e6']) {
      expect(coderApprovalTtlMs({ [CODER_APPROVAL_TTL_ENV]: bad })).toBe(
        DEFAULT_CODER_APPROVAL_TTL_MS,
      );
    }
    // A timer longer than this fires at once.
    expect(coderApprovalTtlMs({ [CODER_APPROVAL_TTL_ENV]: String(10 ** 12) })).toBe(2 ** 31 - 1);
  });
});
