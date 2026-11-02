import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_PROCESS_LIMITS,
  LIMIT_ENV_VARS,
  PROCESS_LIMIT_ENV_VARS,
  resolveLimits,
  resolveProcessLimits,
} from './limits.js';

describe('limits', () => {
  it('defaults to PRD section 6', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.botsPerAccount).toBe(50);
    expect(DEFAULT_LIMITS.botsPerGroup).toBe(6);
    expect(DEFAULT_LIMITS.skillsPerAccount).toBe(200);
    expect(DEFAULT_LIMITS.webhookPayloadBytes).toBe(1_048_576);
    expect(DEFAULT_LIMITS.webhookIpRatePerMin).toBe(600);
    expect(DEFAULT_LIMITS.webhookFailedAuthPerMin).toBe(10);
    expect(DEFAULT_LIMITS.webhookEndpointRatePerMin).toBe(60);
  });

  it('applies overrides and ignores undefined', () => {
    const limits = resolveLimits({ botsPerGroup: 8, routinesPerBot: undefined });
    expect(limits.botsPerGroup).toBe(8);
    expect(limits.routinesPerBot).toBe(50);
  });

  it('names an env var for every limit', () => {
    expect(Object.keys(LIMIT_ENV_VARS).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
    expect(LIMIT_ENV_VARS.botsPerAccount).toBe('OPENBOTS_LIMITS_BOTS_PER_ACCOUNT');
  });

  it('keeps the process limits at their former constants, overridable one by one', () => {
    expect(resolveProcessLimits()).toEqual({
      approvalTtlMinutes: 1440,
      mcpIdleStopMinutes: 10,
      webFetchMaxChars: 40_000,
      webFetchTimeoutSeconds: 30,
    });
    expect(
      resolveProcessLimits({ webFetchMaxChars: 8_000, approvalTtlMinutes: undefined }),
    ).toEqual({ ...DEFAULT_PROCESS_LIMITS, webFetchMaxChars: 8_000 });
    expect(Object.keys(PROCESS_LIMIT_ENV_VARS).sort()).toEqual(
      Object.keys(DEFAULT_PROCESS_LIMITS).sort(),
    );
    // No name is shared with the admin-overridable limits.
    const names = [...Object.values(LIMIT_ENV_VARS), ...Object.values(PROCESS_LIMIT_ENV_VARS)];
    expect(new Set(names).size).toBe(names.length);
  });
});
