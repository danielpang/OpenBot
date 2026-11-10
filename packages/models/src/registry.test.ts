import { DEFAULT_CAPABILITIES } from '@openbots/shared';
import { describe, expect, it, vi } from 'vitest';
import { createModelFactory, type ProviderConfig, type SdkFactories } from './adapters.js';
import { presetById } from './catalog.js';
import {
  ModelDisabledError,
  ProviderNotFoundError,
  ProviderRegistry,
  pickSmallModel,
  type ProviderModel,
} from './registry.js';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';

function config(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: PROVIDER_ID,
    kind: 'anthropic',
    protocol: 'native',
    slug: 'anthropic',
    baseUrl: null,
    headers: {},
    apiKey: 'sk-test',
    presetId: 'anthropic',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

/** Each factory returns a provider whose models record who built them. */
function fakeSdk() {
  const make = (name: string) =>
    vi.fn((settings: unknown) => {
      const provider = (modelId: string) => ({ via: name, modelId, settings });
      return Object.assign(provider, { chatModel: provider });
    });
  return {
    createAnthropic: make('anthropic'),
    createOpenAI: make('openai'),
    createGoogleGenerativeAI: make('google'),
    createXai: make('xai'),
    createOpenAICompatible: make('openai-compatible'),
  };
}

const asSdk = (sdk: ReturnType<typeof fakeSdk>) => sdk as unknown as SdkFactories;

function model(over: Partial<ProviderModel> = {}): ProviderModel {
  return {
    providerId: PROVIDER_ID,
    modelId: 'm',
    displayName: 'M',
    capabilities: { ...DEFAULT_CAPABILITIES },
    pricing: null,
    enabled: true,
    ...over,
  };
}

describe('createModelFactory', () => {
  it.each([
    ['anthropic', 'createAnthropic'],
    ['openai', 'createOpenAI'],
    ['google', 'createGoogleGenerativeAI'],
    ['xai', 'createXai'],
  ] as const)('uses the native package for %s', (kind, factory) => {
    const sdk = fakeSdk();
    const built = createModelFactory(
      config({ kind, presetId: kind }),
      asSdk(sdk),
    )('x') as unknown as {
      via: string;
      settings: { apiKey: string };
    };
    expect(sdk[factory]).toHaveBeenCalledOnce();
    expect(built.settings.apiKey).toBe('sk-test');
  });

  it('calls Ollama, a built-in, over the OpenAI compatible client at its base URL', () => {
    const sdk = fakeSdk();
    createModelFactory(
      config({
        kind: 'ollama',
        protocol: 'native',
        slug: 'ollama',
        presetId: 'ollama',
        apiKey: null,
        baseUrl: 'http://localhost:11434/v1',
      }),
      asSdk(sdk),
    )('llama3.2');
    expect(sdk.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ollama', baseURL: 'http://localhost:11434/v1' }),
    );
    expect(sdk.createOpenAI).not.toHaveBeenCalled();
  });

  it('uses createOpenAICompatible for openai_compatible, with the key in the preset header', () => {
    const sdk = fakeSdk();
    createModelFactory(
      config({
        kind: 'custom',
        protocol: 'openai_compatible',
        slug: 'azure',
        presetId: 'azure-openai',
        baseUrl: 'https://r.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21',
        headers: { 'x-extra': '1' },
      }),
      asSdk(sdk),
    )('gpt');
    expect(sdk.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'azure',
        baseURL: 'https://r.openai.azure.com/openai/deployments/gpt',
        queryParams: { 'api-version': '2024-10-21' },
        headers: { 'x-extra': '1', 'api-key': 'sk-test' },
      }),
    );
  });

  it('sends a Bearer key to OpenAI-compatible endpoints without a preset', () => {
    const sdk = fakeSdk();
    createModelFactory(
      config({
        kind: 'custom',
        protocol: 'openai_compatible',
        presetId: null,
        baseUrl: 'http://h/v1',
      }),
      asSdk(sdk),
    )('m');
    expect(sdk.createOpenAICompatible.mock.calls[0]![0]).toMatchObject({
      headers: { Authorization: 'Bearer sk-test' },
    });
  });

  it('uses createAnthropic with the base URL for anthropic_compatible', () => {
    const sdk = fakeSdk();
    createModelFactory(
      config({
        kind: 'custom',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://proxy/v1',
        headers: { h: 'v' },
      }),
      asSdk(sdk),
    )('m');
    expect(sdk.createAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://proxy/v1',
      apiKey: 'sk-test',
      headers: { h: 'v' },
    });
  });

  it('refuses a custom endpoint without a base URL', () => {
    expect(() =>
      createModelFactory(
        config({ kind: 'custom', protocol: 'openai_compatible', baseUrl: null }),
        asSdk(fakeSdk()),
      ),
    ).toThrow(/base URL/);
  });
});

describe('ProviderRegistry', () => {
  function registry(rows: { provider: ProviderConfig | null; models: ProviderModel[] }) {
    const sdk = fakeSdk();
    const source = {
      getProvider: vi.fn(async () => rows.provider),
      listModels: vi.fn(async () => rows.models),
    };
    return { sdk, source, registry: new ProviderRegistry(source, asSdk(sdk)) };
  }

  it('resolves model_config and caches the provider instance until the row changes', async () => {
    const rows = {
      provider: config(),
      models: [
        model({
          modelId: 'claude-opus-5-5',
          capabilities: { ...DEFAULT_CAPABILITIES, reasoning: true },
        }),
      ],
    };
    const { sdk, registry: reg } = registry(rows);
    const first = await reg.resolve({
      provider_id: PROVIDER_ID,
      model_id: 'claude-opus-5-5',
      reasoning: 'high',
    });
    expect(first.model).toMatchObject({ via: 'anthropic', modelId: 'claude-opus-5-5' });
    expect(first.providerOptions).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    await reg.resolve({ provider_id: PROVIDER_ID, model_id: 'claude-opus-5-5' });
    expect(sdk.createAnthropic).toHaveBeenCalledOnce();

    rows.provider = config({ updatedAt: new Date('2026-10-02T00:00:00Z'), apiKey: 'sk-new' });
    await reg.resolve({ provider_id: PROVIDER_ID, model_id: 'claude-opus-5-5' });
    expect(sdk.createAnthropic).toHaveBeenCalledTimes(2);
    expect(sdk.createAnthropic.mock.calls[1]![0]).toMatchObject({ apiKey: 'sk-new' });

    reg.invalidate(PROVIDER_ID);
    await reg.resolve({ provider_id: PROVIDER_ID, model_id: 'claude-opus-5-5' });
    expect(sdk.createAnthropic).toHaveBeenCalledTimes(3);
  });

  it('gives no reasoning options to a model without the capability', async () => {
    const { registry: reg } = registry({ provider: config(), models: [model({ modelId: 'm' })] });
    const resolved = await reg.resolve({
      provider_id: PROVIDER_ID,
      model_id: 'm',
      reasoning: true,
    });
    expect(resolved.providerOptions).toEqual({});
  });

  it('reports a missing provider and a disabled model', async () => {
    const missing = registry({ provider: null, models: [] }).registry;
    await expect(
      missing.resolve({ provider_id: PROVIDER_ID, model_id: 'm' }),
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
    const disabled = registry({ provider: config(), models: [model({ enabled: false })] }).registry;
    await expect(
      disabled.resolve({ provider_id: PROVIDER_ID, model_id: 'm' }),
    ).rejects.toBeInstanceOf(ModelDisabledError);
  });

  it('maps tool names to the provider limits and back', async () => {
    const { registry: reg } = registry({ provider: config(), models: [] });
    const resolved = await reg.resolve({ provider_id: PROVIDER_ID, model_id: 'm' });
    const map = resolved.toolNames(['edit_file', 'notion.search pages']);
    expect(map.toProvider('edit_file')).toBe('edit_file');
    const sent = map.toProvider('notion.search pages');
    expect(sent).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(map.fromProvider(sent)).toBe('notion.search pages');
  });
});

describe('pickSmallModel', () => {
  const models = [
    model({ modelId: 'big', pricing: { input: 4, output: 20 } }),
    model({
      modelId: 'cheap-no-tools',
      pricing: { input: 0.1, output: 0.1 },
      capabilities: { ...DEFAULT_CAPABILITIES, tools: false },
    }),
    model({ modelId: 'small', pricing: { input: 1, output: 5 } }),
    model({ modelId: 'off', pricing: { input: 0.01, output: 0.01 }, enabled: false }),
    model({ modelId: 'unpriced' }),
  ];

  it('picks the cheapest enabled model with tools', () => {
    expect(pickSmallModel(models)?.modelId).toBe('small');
  });

  it('honours an override naming an enabled model', () => {
    expect(pickSmallModel(models, 'big')?.modelId).toBe('big');
    expect(pickSmallModel(models, 'off')?.modelId).toBe('small');
  });

  it('falls back to an unpriced model with tools, or null', () => {
    expect(pickSmallModel([model({ modelId: 'a' })])?.modelId).toBe('a');
    expect(pickSmallModel([])).toBeNull();
  });

  it('prefers the preset’s catalog small model over pricing', () => {
    const anthropic = [
      model({ modelId: 'claude-opus-5-5' }),
      model({ modelId: 'claude-haiku-4-5' }),
      model({ modelId: 'cheapest', pricing: { input: 0.1, output: 0.1 } }),
    ];
    expect(pickSmallModel(anthropic, null, 'anthropic')?.modelId).toBe('claude-haiku-4-5');
    // The override still wins; without a preset, pricing decides.
    expect(pickSmallModel(anthropic, 'claude-opus-5-5', 'anthropic')?.modelId).toBe(
      'claude-opus-5-5',
    );
    expect(pickSmallModel(anthropic)?.modelId).toBe('cheapest');
  });

  it('skips a catalog small model that is disabled or lost tool calling', () => {
    const tools = { ...DEFAULT_CAPABILITIES, tools: false };
    const priced = model({ modelId: 'priced', pricing: { input: 3, output: 3 } });
    expect(
      pickSmallModel(
        [model({ modelId: 'claude-haiku-4-5', enabled: false }), priced],
        null,
        'anthropic',
      )?.modelId,
    ).toBe('priced');
    expect(
      pickSmallModel(
        [model({ modelId: 'claude-haiku-4-5', capabilities: tools }), priced],
        null,
        'anthropic',
      )?.modelId,
    ).toBe('priced');
  });

  it('on an unpriced endpoint, picks the catalog small model, else the first in order', () => {
    const groq = [
      model({ modelId: 'llama-3.3-70b-versatile' }),
      model({ modelId: 'llama-3.1-8b-instant' }),
    ];
    const small = presetSmall('groq');
    expect(pickSmallModel(groq, null, 'groq')?.modelId).toBe(small);
    expect(pickSmallModel(groq, null, 'ollama')?.modelId).toBe('llama-3.3-70b-versatile');
  });
});

const presetSmall = (id: string) => presetById(id)!.models.find((m) => m.small)!.id;
