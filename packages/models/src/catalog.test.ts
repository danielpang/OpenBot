import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_URL,
  CatalogSchema,
  builtinPreset,
  catalogModel,
  loadCatalog,
  presetById,
} from './catalog.js';

describe('catalog.json', () => {
  it('validates against the schema', () => {
    const raw = JSON.parse(readFileSync(CATALOG_URL, 'utf8'));
    const parsed = CatalogSchema.safeParse(raw);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('has the built-in providers and every custom preset named in L2', () => {
    const ids = loadCatalog().presets.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic',
        'openai',
        'google',
        'xai',
        'openrouter',
        'groq',
        'together',
        'fireworks',
        'deepseek',
        'mistral',
        'azure-openai',
        'ollama',
        'lmstudio',
        'vllm',
        'litellm',
      ]),
    );
  });

  it('defaults Anthropic to Claude Opus 5.5 and marks a small model', () => {
    const anthropic = builtinPreset('anthropic');
    expect(anthropic.models.find((m) => m.default)?.id).toBe('claude-opus-5-5');
    expect(anthropic.models.find((m) => m.small)?.id).toBe('claude-haiku-4-5');
    expect(catalogModel('anthropic', 'claude-opus-5-5')?.pricing).toEqual({
      input: 4,
      output: 20,
      cached: 0.2,
    });
  });

  it('prices the OpenAI, Google and xAI frontier models at their list prices (L4)', () => {
    // Short-context list prices per 1M tokens, from each provider's pricing page.
    expect(catalogModel('openai', 'gpt-5.5')?.pricing).toEqual({
      input: 5,
      output: 30,
      cached: 0.5,
    });
    expect(catalogModel('google', 'gemini-3.1-pro-preview')?.pricing).toEqual({
      input: 2,
      output: 12,
      cached: 0.2,
    });
    expect(catalogModel('xai', 'grok-4.7')?.pricing).toEqual({ input: 2, output: 6, cached: 0.5 });
  });

  it('describes Azure with a deployment URL, api-version and the api-key header', () => {
    const azure = presetById('azure-openai')!;
    expect(azure.base_url).toContain('/openai/deployments/{deployment}');
    expect(azure.base_url).toContain('api-version=');
    expect(azure.auth).toEqual({ header: 'api-key', scheme: null });
  });

  it('points Ollama at its /v1 endpoint with discovery', () => {
    const ollama = presetById('ollama')!;
    expect(ollama.base_url).toMatch(/\/v1$/);
    expect(ollama).toMatchObject({
      protocol: 'openai_compatible',
      discovery: 'list_models',
      key_required: false,
    });
  });

  it('rejects a built-in kind on a compatible protocol', () => {
    const bad = {
      version: 1,
      presets: [{ ...builtinPreset('openai'), protocol: 'openai_compatible' }],
    };
    expect(CatalogSchema.safeParse(bad).success).toBe(false);
  });
});
