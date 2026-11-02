import { DEFAULT_LIMITS } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { LIMIT_LABELS, limitLabel, limitsPatch } from './admin-settings.js';

describe('the limits form', () => {
  it('labels every limit the server has', () => {
    expect(Object.keys(LIMIT_LABELS).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
  });

  it('says nothing about accounts in the Mac app local mode', () => {
    for (const key of Object.keys(LIMIT_LABELS) as (keyof typeof LIMIT_LABELS)[]) {
      expect(limitLabel(key, true)).not.toMatch(/account/i);
    }
    expect(limitLabel('botsPerAccount', true)).toBe('Bots');
    expect(limitLabel('botsPerAccount', false)).toBe('Bots per account');
  });

  it('sends only the limits that changed', () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) form.set(key, String(value));
    form.set('botsPerAccount', '10');
    expect(limitsPatch(form, { ...DEFAULT_LIMITS })).toEqual({ botsPerAccount: 10 });
  });
});
