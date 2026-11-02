import { DEFAULT_CAPABILITIES, missingCapabilities, modelSupports } from '@openbots/shared';
import { describe, expect, it } from 'vitest';
import { estimateCost } from './cost.js';
import { parseModelList } from './discover.js';
import { reasoningProviderOptions } from './reasoning.js';
import { createToolNameMap, toolNameRules } from './tool-names.js';

describe('estimateCost', () => {
  it('prices input, cached input and output per 1M tokens', () => {
    const cost = estimateCost(
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 },
      { input: 4, output: 20, cached: 0.2 },
    );
    expect(cost).toBeCloseTo(2 + 0.1 + 2);
  });

  it('bills cached tokens at the input rate when no cached rate is known', () => {
    expect(
      estimateCost({ inputTokens: 1000, cachedInputTokens: 1000 }, { input: 1, output: 1 }),
    ).toBeCloseTo(0.001);
  });

  it('gives no estimate without pricing', () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, null)).toBeNull();
    expect(estimateCost({ inputTokens: 10 }, undefined)).toBeNull();
  });
});

describe('modelSupports', () => {
  const caps = { ...DEFAULT_CAPABILITIES, tools: true, vision: false };
  it('filters on needs', () => {
    expect(modelSupports({ capabilities: caps }, ['tools'])).toBe(true);
    expect(modelSupports({ capabilities: caps }, ['tools', 'vision'])).toBe(false);
    expect(missingCapabilities(caps, ['tools', 'vision', 'reasoning'])).toEqual([
      'vision',
      'reasoning',
    ]);
    expect(modelSupports({ capabilities: caps }, [])).toBe(true);
  });
});

describe('reasoningProviderOptions', () => {
  const native = (kind: 'openai' | 'google' | 'xai' | 'anthropic') => ({
    kind,
    protocol: 'native' as const,
  });
  it('spells reasoning per provider', () => {
    expect(reasoningProviderOptions(native('openai'), 'low', true)).toEqual({
      openai: { reasoningEffort: 'low' },
    });
    expect(reasoningProviderOptions(native('xai'), true, true)).toEqual({
      xai: { reasoningEffort: 'medium' },
    });
    expect(reasoningProviderOptions(native('google'), 'high', true)).toEqual({
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
    });
    expect(reasoningProviderOptions(native('anthropic'), true, true)).toEqual({
      anthropic: { thinking: { type: 'adaptive' } },
    });
    expect(
      reasoningProviderOptions({ kind: 'custom', protocol: 'openai_compatible' }, 'medium', true),
    ).toEqual({
      openaiCompatible: { reasoningEffort: 'medium' },
    });
  });

  it('passes nothing when reasoning is off or unsupported', () => {
    expect(reasoningProviderOptions(native('openai'), false, true)).toEqual({});
    expect(reasoningProviderOptions(native('openai'), undefined, true)).toEqual({});
    expect(reasoningProviderOptions(native('openai'), 'high', false)).toEqual({});
  });
});

describe('createToolNameMap', () => {
  const openai = toolNameRules({ kind: 'openai', protocol: 'native' });
  const google = toolNameRules({ kind: 'google', protocol: 'native' });

  it('keeps names that fit and round-trips the rest', () => {
    const long = `github__${'x'.repeat(80)}`;
    const map = createToolNameMap(['edit_file', 'a.b', 'a_b', long], openai);
    expect(map.toProvider('edit_file')).toBe('edit_file');
    expect(map.toProvider('a_b')).toBe('a_b');
    // `a.b` sanitizes to `a_b`, which is taken, so it gets a hash suffix.
    expect(map.toProvider('a.b')).not.toBe('a_b');
    expect(map.toProvider(long).length).toBeLessThanOrEqual(64);
    for (const name of ['edit_file', 'a.b', 'a_b', long]) {
      expect(map.fromProvider(map.toProvider(name))).toBe(name);
    }
    expect([...map.renamed.keys()].sort()).toEqual(['a.b', long].sort());
  });

  it('applies Gemini rules: dots allowed, letter or underscore first', () => {
    const map = createToolNameMap(['notion.search', '1password'], google);
    expect(map.toProvider('notion.search')).toBe('notion.search');
    expect(map.toProvider('1password')).toMatch(/^_/);
    expect(map.fromProvider(map.toProvider('1password'))).toBe('1password');
  });

  it('is stable across builds', () => {
    const a = createToolNameMap(['x y z'], openai).toProvider('x y z');
    const b = createToolNameMap(['x y z'], openai).toProvider('x y z');
    expect(a).toBe(b);
  });
});

describe('parseModelList', () => {
  it('reads plain id lists and OpenRouter metadata, preferring catalog data', () => {
    const models = parseModelList(
      {
        data: [
          { id: 'llama3.2' },
          { id: 'llama3.2' },
          {
            id: 'vendor/model',
            name: 'Vendor Model',
            context_length: 32000,
            supported_parameters: ['tools', 'temperature'],
            architecture: { input_modalities: ['text', 'image'] },
            top_provider: { max_completion_tokens: 4096 },
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
          { id: 'llama-3.3-70b-versatile' },
          { nope: true },
        ],
      },
      'groq',
    );
    expect(models.map((m) => m.modelId)).toEqual([
      'llama3.2',
      'vendor/model',
      'llama-3.3-70b-versatile',
    ]);
    expect(models[0]).toMatchObject({
      displayName: 'llama3.2',
      capabilities: DEFAULT_CAPABILITIES,
      pricing: null,
    });
    expect(models[1]).toMatchObject({
      displayName: 'Vendor Model',
      capabilities: {
        tools: true,
        vision: true,
        reasoning: false,
        context_window: 32000,
        max_output: 4096,
      },
      pricing: { input: 1, output: 2 },
    });
    expect(models[2]).toMatchObject({
      displayName: 'Llama 3.3 70B Versatile',
      pricing: { input: 0.59, output: 0.79 },
    });
  });

  it('throws on a body that is not a model list', () => {
    expect(() => parseModelList({ error: 'x' }, null)).toThrow(/model list/);
  });
});
