import { afterEach, describe, expect, it } from 'vitest';
import { createModelFactory, type ProviderConfig } from './adapters.js';
import { DiscoveryError, discoverModels } from './discover.js';
import { testModel } from './test-provider.js';
import { startFakeOpenAI, type FakeOpenAI } from './testing.js';

// Discover and Test against a local OpenAI-compatible endpoint, through the
// real `@ai-sdk/openai-compatible` adapter.

function config(baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'custom',
    protocol: 'openai_compatible',
    slug: 'local',
    baseUrl,
    headers: { 'x-team': 'ops' },
    apiKey: 'sk-local',
    presetId: null,
    updatedAt: new Date(),
    ...over,
  };
}

describe('against a fake OpenAI-compatible endpoint', () => {
  let fake: FakeOpenAI | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('discovers models with the key and extra headers', async () => {
    fake = await startFakeOpenAI({ models: [{ id: 'qwen3' }, { id: 'llama3.2' }] });
    const models = await discoverModels(config(fake.baseUrl));
    expect(models.map((m) => m.modelId)).toEqual(['qwen3', 'llama3.2']);
    expect(fake.requests[0]!.headers).toMatchObject({
      authorization: 'Bearer sk-local',
      'x-team': 'ops',
    });
  });

  it('keeps query parameters such as api-version on discovery', async () => {
    fake = await startFakeOpenAI();
    await discoverModels(
      config(`${fake.baseUrl}?api-version=2024-10-21`, { presetId: 'azure-openai' }),
    );
    expect(fake.requests[0]!.url).toBe('/v1/models?api-version=2024-10-21');
    expect(fake.requests[0]!.headers['api-key']).toBe('sk-local');
  });

  it('reports a refused connection as a DiscoveryError', async () => {
    await expect(discoverModels(config('http://127.0.0.1:9/v1'))).rejects.toBeInstanceOf(
      DiscoveryError,
    );
  });

  it('passes streaming and tool calling on a working endpoint', async () => {
    fake = await startFakeOpenAI();
    const model = createModelFactory(config(fake.baseUrl))('qwen3');
    const result = await testModel(model, { modelId: 'qwen3' });
    expect(result).toMatchObject({ model_id: 'qwen3', streaming: true, tools: true, error: null });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    // Streaming, then the tool call, then the answer after the tool result.
    const chats = fake.requests.filter((r) => r.url.endsWith('/chat/completions'));
    expect(chats).toHaveLength(3);
    expect(chats[0]!.body).toMatchObject({ stream: true, max_tokens: 16 });
  });

  it('reports a model that ignores tools', async () => {
    fake = await startFakeOpenAI({ toolCalls: false });
    const result = await testModel(createModelFactory(config(fake.baseUrl))('m'), { modelId: 'm' });
    expect(result).toMatchObject({ streaming: true, tools: false });
    expect(result.error).toMatch(/without calling the tool/);
  });

  it('reports a failing endpoint without throwing', async () => {
    fake = await startFakeOpenAI({ chatStatus: 500 });
    const result = await testModel(createModelFactory(config(fake.baseUrl))('m'), { modelId: 'm' });
    expect(result).toMatchObject({ streaming: false, tools: false, latency_ms: null });
    expect(result.error).toMatch(/^Streaming failed/);
  });

  it('reports an unreachable endpoint without throwing', async () => {
    const result = await testModel(createModelFactory(config('http://127.0.0.1:9/v1'))('m'), {
      modelId: 'm',
      timeoutMs: 5000,
    });
    expect(result.streaming).toBe(false);
    expect(result.error).toMatch(/^Streaming failed/);
  });
});
