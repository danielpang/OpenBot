import { describe, expect, it } from 'vitest';
import { keyPlaceholder, keyStatusText, setupRequired, usableProvider } from './api.js';

describe('setup wizard helpers', () => {
  it('treats an unreachable setup endpoint as set up, so sign-in still shows', async () => {
    expect(await setupRequired(async () => ({ setupRequired: true }))).toBe(true);
    expect(await setupRequired(async () => ({ setupRequired: false }))).toBe(false);
    expect(await setupRequired(() => Promise.reject(new Error('offline')))).toBe(false);
  });

  it('continues past the key step only with a key whose Test passed with tools (L1)', () => {
    expect(usableProvider({ hasKey: true, status: 'ok' })).toBe(true);
    expect(usableProvider({ hasKey: true, status: 'degraded' })).toBe(false);
    expect(usableProvider({ hasKey: true, status: 'error' })).toBe(false);
    expect(usableProvider({ hasKey: true, status: 'untested' })).toBe(false);
    expect(usableProvider({ hasKey: false, status: 'ok' })).toBe(false);
  });

  it('says why a key did not work', () => {
    const tested = (status: 'ok' | 'error' | 'untested', error: string | null = null) => ({
      hasKey: true,
      status,
      testResult: {
        streaming: status === 'ok',
        tools: status === 'ok',
        latency_ms: null,
        model_id: null,
        error,
      },
    });
    expect(keyStatusText({ ...tested('ok'), hasKey: false })).toBe('No key yet');
    // A check mark says it instead.
    expect(keyStatusText(tested('ok'))).toBeNull();
    expect(keyStatusText(tested('untested'))).toBe('Key saved, not tested yet');
    expect(keyStatusText(tested('error', 'Streaming failed: 401 invalid x-api-key'))).toBe(
      'The key did not work: Streaming failed: 401 invalid x-api-key',
    );
  });

  it("puts the saved key's hint in the empty field (P3)", () => {
    expect(keyPlaceholder()).toBe('API key');
    expect(keyPlaceholder({ hasKey: false, keyHint: null })).toBe('API key');
    expect(keyPlaceholder({ hasKey: true, keyHint: 'sk-ant-…a1b2' })).toBe('sk-ant-…a1b2 saved');
    expect(keyPlaceholder({ hasKey: true, keyHint: null })).toBe('Key set (from .env or earlier)');
  });
});
