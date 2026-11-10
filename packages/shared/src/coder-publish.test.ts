import { describe, expect, it } from 'vitest';
import { CoderPublishInputSchema, CoderPublishResultSchema } from './coder-publish.js';

describe('coding-session publication contract', () => {
  it('accepts only presentation metadata, never publication authority', () => {
    expect(
      CoderPublishInputSchema.parse({ title: ' Fix ', body: 'Tests pass', draft: true }),
    ).toEqual({ title: 'Fix', body: 'Tests pass', draft: true });
    for (const field of [
      'repo',
      'branch',
      'base',
      'worktreePath',
      'sessionId',
      'force',
      'credentials',
    ]) {
      expect(
        CoderPublishInputSchema.safeParse({ title: 'Fix', body: '', [field]: 'override' }).success,
      ).toBe(false);
    }
  });
  it('bounds input and rejects empty titles', () => {
    for (const input of [
      { title: ' ', body: '' },
      { title: 'x'.repeat(201), body: '' },
      { title: 'Fix', body: 'x'.repeat(20001) },
    ]) {
      expect(CoderPublishInputSchema.safeParse(input).success).toBe(false);
    }
  });
  it('requires a real result rather than treating an allow decision as a completed push', () => {
    expect(
      CoderPublishResultSchema.safeParse({
        branch: 'bot/fix',
        prUrl: 'https://github.com/acme/app/pull/1',
      }).success,
    ).toBe(true);
    expect(CoderPublishResultSchema.safeParse({ branch: 'bot/fix' }).success).toBe(false);
    expect(CoderPublishResultSchema.safeParse({ decision: 'allow' }).success).toBe(false);
  });
});
