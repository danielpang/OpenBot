import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import {
  accountBilling,
  coderProviderEnv,
  maskKey,
  type CoderProvider,
} from './coder-provider-env.js';

// An api_key account's provider key on its way to the CLI: the vendor's
// variables, what does not fit, the billing and the mask.

const provider = (over: Partial<CoderProvider>): CoderProvider => ({
  kind: 'anthropic',
  protocol: 'native',
  name: 'Anthropic',
  baseUrl: null,
  apiKey: 'sk-ant-test',
  ...over,
});

describe('coderProviderEnv', () => {
  it("puts the key in each vendor's variable", () => {
    expect(coderProviderEnv('claude', provider({}))).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(coderProviderEnv('codex', provider({ kind: 'openai', apiKey: 'sk-oa' }))).toEqual({
      OPENAI_API_KEY: 'sk-oa',
      CODEX_API_KEY: 'sk-oa',
    });
    expect(coderProviderEnv('pi', provider({}))).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(coderProviderEnv('pi', provider({ kind: 'openai', apiKey: 'o' }))).toEqual({
      OPENAI_API_KEY: 'o',
    });
    expect(coderProviderEnv('pi', provider({ kind: 'google', apiKey: 'g' }))).toEqual({
      GEMINI_API_KEY: 'g',
    });
    expect(coderProviderEnv('pi', provider({ kind: 'xai', apiKey: 'x' }))).toEqual({
      XAI_API_KEY: 'x',
    });
  });

  it('passes a compatible endpoint where the CLI takes one, and refuses the rest', () => {
    expect(
      coderProviderEnv(
        'codex',
        provider({
          kind: 'custom',
          protocol: 'openai_compatible',
          baseUrl: 'https://llm.example/v1',
        }),
      ),
    ).toEqual({
      OPENAI_API_KEY: 'sk-ant-test',
      CODEX_API_KEY: 'sk-ant-test',
      OPENAI_BASE_URL: 'https://llm.example/v1',
    });
    expect(
      coderProviderEnv(
        'claude',
        provider({
          kind: 'custom',
          protocol: 'anthropic_compatible',
          baseUrl: 'https://a.example',
        }),
      ),
    ).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'https://a.example' });
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        return (error as DomainError).message;
      }
      throw new Error('not refused');
    };
    expect(refused(() => coderProviderEnv('claude', provider({ kind: 'openai' })))).toMatch(
      /Claude Code takes an Anthropic key only/,
    );
    expect(refused(() => coderProviderEnv('codex', provider({})))).toMatch(/OpenAI key only/);
    expect(
      refused(() =>
        coderProviderEnv(
          'pi',
          provider({ kind: 'custom', protocol: 'openai_compatible', baseUrl: 'https://x' }),
        ),
      ),
    ).toMatch(/custom endpoint/);
    expect(refused(() => coderProviderEnv('claude', provider({ apiKey: null })))).toMatch(
      /no API key/,
    );
  });

  it('reads billing from the account', () => {
    expect(accountBilling({ authKind: 'subscription' })).toBe('subscription');
    expect(accountBilling({ authKind: 'api_key' })).toBe('api');
    expect(accountBilling(null)).toBe('unknown');
  });

  it('masks the key wherever it appears', () => {
    expect(maskKey('a sk-1 b sk-1', 'sk-1')).toBe('a [key] b [key]');
    expect(maskKey('nothing', null)).toBe('nothing');
  });
});
