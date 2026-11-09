import type { ModelNeed } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { endpointBody, isLoopbackUrl } from './add-endpoint.js';
import {
  deleteProvider,
  pickerModelsQuery,
  providerModelsQuery,
  presetsQuery,
  providersQuery,
  testProvider,
  type Provider,
  type ProviderModel,
  type ProviderPreset,
} from './api.js';
import { ErrorText } from './error-text.js';
import { mergeDiscovered, providerInUseText } from './format.js';
import { ModelRows, modelsPatch, type ModelDraft } from './model-editor.js';
import { chooseModel, ModelPicker, pickerNeeds } from './ModelPicker.js';
import { ModelsSettings } from './models-settings.js';
import { capabilitiesQuery } from '../../app/api.js';

// The API client binds `fetch` when its module loads, so the fake goes in
// before any import: it answers `server.handler` and 404s without one.
const server = vi.hoisted(() => {
  const state = {
    handler: undefined as ((request: Request) => Response) | undefined,
    realFetch: globalThis.fetch,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return state.handler?.(request) ?? new Response(null, { status: 404 });
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

const PROVIDER_ID = '00000000-0000-4000-8000-0000000000a1';
const CUSTOM_ID = '00000000-0000-4000-8000-0000000000a2';

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: PROVIDER_ID,
    name: 'Anthropic',
    slug: 'anthropic',
    kind: 'anthropic',
    protocol: 'native',
    baseUrl: null,
    local: false,
    headers: [],
    hasKey: true,
    keyHint: 'sk-ant-…a1b2',
    discovery: 'manual',
    presetId: 'anthropic',
    status: 'ok',
    lastTestedAt: null,
    testResult: {
      model_id: 'claude-x',
      streaming: true,
      tools: false,
      latency_ms: 412,
      error: null,
    },
    scope: 'organization',
    smallModelId: null,
    botCount: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function model(modelId: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: `00000000-0000-4000-8000-${modelId.padStart(12, '0').slice(-12)}`,
    providerId: PROVIDER_ID,
    modelId,
    displayName: modelId,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      context_window: null,
      max_output: null,
    },
    pricing: null,
    enabled: true,
    source: 'catalog',
    ...overrides,
  };
}

const preset = (id: string, name: string, kind: ProviderPreset['kind']): ProviderPreset => ({
  id,
  name,
  kind,
  protocol: kind === 'custom' ? 'openai_compatible' : 'native',
  baseUrl: kind === 'custom' ? 'http://localhost:11434/v1' : null,
  keyRequired: kind !== 'custom',
  discovery: kind === 'custom' ? 'list_models' : 'manual',
  notes: null,
  models: [],
});

const PRESETS = [
  preset('anthropic', 'Anthropic', 'anthropic'),
  preset('openai', 'OpenAI', 'openai'),
  preset('google', 'Google', 'google'),
  preset('xai', 'xAI', 'xai'),
  {
    ...preset('ollama', 'Ollama', 'ollama'),
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    discovery: 'list_models' as const,
  },
  preset('lmstudio', 'LM Studio', 'custom'),
];

function render(queryClient: QueryClient, node: ReactNode) {
  // Components that link need a router; one route rendering `node` is enough.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory(),
  });
  return router.load().then(() =>
    renderToString(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}

function settings(
  items: Provider[],
  canEdit: boolean,
  models: ProviderModel[] = [],
  deployment: 'self_hosted' | 'managed' = 'self_hosted',
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    deployment,
    localEndpoints: deployment === 'self_hosted',
  });
  queryClient.setQueryData(providersQuery.queryKey, { items });
  queryClient.setQueryData(presetsQuery.queryKey, { items: PRESETS });
  for (const p of items) {
    queryClient.setQueryData(providerModelsQuery(p.id).queryKey, {
      items: models.filter((m) => m.providerId === p.id),
    });
  }
  return render(queryClient, <ModelsSettings canEdit={canEdit} />);
}

describe('Settings > Models on the managed service (L6)', () => {
  it("lists the organization's providers and the caller's own apart", async () => {
    const html = await settings(
      [
        provider({}),
        provider({
          id: '00000000-0000-4000-8000-0000000000f1',
          name: 'My Anthropic',
          scope: 'account',
          keyHint: 'sk-ant-…9999',
        }),
      ],
      false,
      [],
      'managed',
    );
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).toContain('Organization');
    expect(text).toContain('Yours');
    expect(text.indexOf('Anthropic')).toBeLessThan(text.indexOf('Yours'));
    expect(text.indexOf('My Anthropic')).toBeGreaterThan(text.indexOf('Yours'));
    // A member adds their own custom providers, not the organization's.
    expect(html.match(/Add provider/g)).toHaveLength(1);
    // No private network on the hosted service.
    expect(html).not.toContain('Runs on my network');
  });

  it('shows one list on a self-hosted install', async () => {
    const text = (await settings([provider({})], true)).replace(/<[^>]*>/g, ' ');
    expect(text).not.toContain('Yours');
  });
});

describe('Settings > Models', () => {
  const stored = [
    // A key in the payload must never reach the page, even if a server sent one.
    { ...provider({}), apiKey: 'sk-ant-secret' } as Provider,
    provider({
      id: CUSTOM_ID,
      name: 'LM Studio',
      slug: 'lmstudio',
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'http://localhost:1234/v1',
      local: true,
      headers: ['X-Token'],
      hasKey: false,
      discovery: 'list_models',
      presetId: 'lmstudio',
    }),
  ];

  it('keeps vendor subscription setup visible beside customized API endpoints', async () => {
    const html = await settings([provider({ baseUrl: 'https://proxy.example/v1' })], true);
    expect(html).toContain('anthropic subscription unavailable');
    expect(html).toContain('Configure a computer to connect a subscription');
    expect(html).toContain('data-key-status');
  });

  it('offers Ollama as a built-in with its address and no key', async () => {
    const html = await settings([], true);
    expect(html).toContain('aria-label="Ollama"');
    expect(html).toMatch(
      /aria-label="Ollama address"[^>]*value="http:\/\/localhost:11434\/v1"|value="http:\/\/localhost:11434\/v1"[^>]*aria-label="Ollama address"/,
    );
    expect(html).toContain('No API key needed');
  });

  it('shows a connected Ollama with its address and an optional key', async () => {
    const ollama = provider({
      id: CUSTOM_ID,
      name: 'Ollama',
      slug: 'ollama',
      kind: 'ollama',
      protocol: 'native',
      baseUrl: 'http://host.docker.internal:11434/v1',
      local: true,
      hasKey: false,
      keyHint: null,
      discovery: 'list_models',
      presetId: 'ollama',
    });
    const html = await settings([ollama], true);
    expect(html).toContain('data-base-url');
    expect(html).toContain('http://host.docker.internal:11434/v1');
    expect(html).toContain('none (optional)');
    expect(html).not.toContain('aria-label="Ollama address"');
    expect(html).not.toContain('ollama connection');
  });

  it('shows key status without ever rendering a key', async () => {
    const html = await settings(stored, true);
    // The hint tells keys apart (P3).
    expect(html).toContain('sk-ant-…a1b2');
    expect(html).toContain('>not set<'); // OpenAI, not configured yet
    expect(html).not.toContain('sk-ant-secret');
    expect(html).not.toContain('header-secret');
    expect(html).toContain('headers: X-Token');
    expect(html).toContain('on my network');
    // Key inputs start empty: no password field carries a value.
    expect(html).not.toMatch(/type="password"[^>]*value=/);
  });

  it('shows the stored test result', async () => {
    const html = await settings(stored, true);
    expect(html).toContain('streaming works · tools fail · 412 ms · claude-x');
  });

  it('lets the admin pick which model Test checks (L3)', async () => {
    const html = await settings([provider({})], true, [model('claude-x'), model('claude-y')]);
    expect(html).toContain('aria-label="Model to test"');
    expect(html).toContain('>Default model</option>');
    expect(html).toContain('<option value="claude-y">claude-y</option>');

    const bodies: unknown[] = [];
    server.handler = (request) => {
      if (request.method !== 'POST' || !request.url.endsWith(`/providers/${PROVIDER_ID}/test`)) {
        return new Response(null, { status: 404 });
      }
      void request.json().then((body) => bodies.push(body));
      return Response.json(provider({}));
    };
    await testProvider(PROVIDER_ID, 'claude-y');
    await testProvider(PROVIDER_ID);
    await vi.waitFor(() => expect(bodies).toEqual([{ modelId: 'claude-y' }, {}]));
  });

  it('gives admins the edit controls and members a read-only view', async () => {
    const admin = await settings(stored, true);
    expect(admin).toContain('Add provider');
    expect(admin).toContain('aria-label="Test"');
    expect(admin).toContain('type="password"');

    const member = await settings(stored, false);
    expect(member).toContain('LM Studio');
    // Members get no hint from the server, only that a key is set.
    const forMember = stored.map((p) => ({ ...p, keyHint: null }));
    expect(await settings(forMember, false)).toContain('>set<');
    expect(member).not.toContain('Add provider');
    expect(member).not.toContain('aria-label="Test"');
    expect(member).not.toContain('aria-label="Delete"');
    expect(member).not.toContain('type="password"');
  });
});

describe('ModelPicker', () => {
  function picker(needs: ModelNeed[], models: ProviderModel[], value = null) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(pickerModelsQuery(pickerNeeds(needs)).queryKey, {
      groups: [
        {
          provider: {
            id: PROVIDER_ID,
            name: 'Anthropic',
            slug: 'anthropic',
            kind: 'anthropic',
            status: 'ok',
          },
          models,
        },
      ],
    });
    return render(queryClient, <ModelPicker value={value} onChange={() => {}} needs={needs} />);
  }

  it('always needs tools', () => {
    expect(pickerNeeds()).toEqual(['tools']);
    expect(pickerNeeds(['vision', 'tools'])).toEqual(['tools', 'vision']);
  });

  it('hides models lacking what the Bot needs and groups by provider', async () => {
    const both = model('sees-and-calls', {
      capabilities: {
        tools: true,
        vision: true,
        reasoning: false,
        context_window: 200_000,
        max_output: null,
      },
      pricing: { input: 3, output: 15 },
    });
    const toolsOnly = model('calls-only');
    const noTools = model('chats-only', {
      capabilities: { ...toolsOnly.capabilities, tools: false, vision: true },
    });
    const disabled = model('switched-off', { enabled: false, capabilities: both.capabilities });

    const html = await picker(['vision'], [both, toolsOnly, noTools, disabled]);
    expect(html).toContain('<optgroup label="Anthropic"');
    expect(html).toContain('>sees-and-calls · 200k context</option>');
    // Prices stay in the model editor, out of the picker.
    expect(html).not.toMatch(/\$|per 1M/);
    for (const hidden of ['calls-only', 'chats-only', 'switched-off']) {
      expect(html).not.toContain(hidden);
    }

    const toolsHtml = await picker([], [toolsOnly, noTools]);
    expect(toolsHtml).toContain('>calls-only · unknown context</option>');
    expect(toolsHtml).not.toContain('no estimate');
    expect(toolsHtml).not.toContain('chats-only');
  });

  it('asks the server for what the named Bot needs', async () => {
    const queryClient = new QueryClient();
    const botId = '00000000-0000-4000-8000-0000000000b1';
    const seeing = { ...model('x').capabilities, vision: true };
    queryClient.setQueryData(pickerModelsQuery(pickerNeeds(['vision']), botId).queryKey, {
      groups: [
        {
          provider: {
            id: PROVIDER_ID,
            name: 'Anthropic',
            slug: 'a',
            kind: 'anthropic',
            status: 'ok',
          },
          models: [model('for-this-bot', { capabilities: seeing })],
        },
      ],
    });
    const html = await render(
      queryClient,
      <ModelPicker value={null} onChange={() => {}} needs={['vision']} botId={botId} />,
    );
    expect(html).toContain('for-this-bot');
  });

  it('resets thinking to the picked model’s default (plan 3)', () => {
    const reasons = { ...model('x').capabilities, reasoning: true };
    const summary = (id: string, kind: 'anthropic' | 'openai' | 'custom', compatible = false) => ({
      id,
      name: kind,
      slug: kind,
      kind,
      status: 'ok' as const,
      ...(compatible ? { protocol: 'anthropic_compatible' as const } : {}),
    });
    const groups = [
      {
        provider: summary(PROVIDER_ID, 'anthropic'),
        models: [model('opus', { capabilities: reasons })],
      },
      {
        provider: summary(CUSTOM_ID, 'openai'),
        models: [model('o-think', { capabilities: reasons })],
      },
      {
        provider: summary('p3', 'custom', true),
        models: [model('proxy', { capabilities: reasons }), model('plain')],
      },
    ];
    const current = {
      provider_id: CUSTOM_ID,
      model_id: 'o-think',
      max_steps: 12,
      reasoning: 'high' as const,
    };
    expect(chooseModel(groups, current, `${PROVIDER_ID}/opus`)).toEqual({
      provider_id: PROVIDER_ID,
      model_id: 'opus',
      max_steps: 12,
      reasoning: true,
    });
    expect(chooseModel(groups, current, `${CUSTOM_ID}/o-think`)).toEqual({
      provider_id: CUSTOM_ID,
      model_id: 'o-think',
      max_steps: 12,
    });
    expect(chooseModel(groups, null, 'p3/proxy')).toEqual({
      provider_id: 'p3',
      model_id: 'proxy',
      reasoning: true,
    });
    expect(chooseModel(groups, null, 'p3/plain')).toEqual({ provider_id: 'p3', model_id: 'plain' });
  });

  it('points to Settings when nothing qualifies', async () => {
    const html = await picker(['vision'], [model('calls-only')]);
    expect(html).toContain('No model supports what this Bot needs (tools, vision)');
    expect(html).toContain('href="/settings/models"');
  });
});

describe('model editor', () => {
  const draft = (m: ProviderModel): ModelDraft => ({
    modelId: m.modelId,
    displayName: m.displayName,
    capabilities: m.capabilities,
    pricing: m.pricing,
    enabled: m.enabled,
    source: m.source,
  });

  it('merges discovered models into the list, keeping unsaved edits', async () => {
    const saved = [draft(model('llama3'))];
    const edited: ModelDraft[] = [
      { ...saved[0]!, enabled: false, pricing: { input: 1, output: 2 } },
    ];
    const discovered = [
      draft(model('llama3', { source: 'catalog' })),
      draft(model('qwen3', { source: 'discovered' })),
    ];
    const merged = mergeDiscovered(edited, discovered);
    expect(merged.map((m) => m.modelId)).toEqual(['llama3', 'qwen3']);
    expect(merged[0]).toEqual(edited[0]);

    const html = renderToString(<ModelRows models={merged} canEdit />);
    expect(html).toContain('qwen3');
    expect(html).toContain('discovered');

    // Saving sends only the edit; the discovered model is already stored.
    expect(modelsPatch(discovered, merged)).toEqual({
      models: [
        {
          modelId: 'llama3',
          displayName: 'llama3',
          pricing: { input: 1, output: 2 },
          enabled: false,
        },
      ],
      remove: [],
    });
  });

  it('sends only the capability flags that changed, so Test keeps its own (L3)', () => {
    // A failed Test turned tools off; the admin then edits only the price and vision.
    const tested = model('qwen3');
    const saved = [draft({ ...tested, capabilities: { ...tested.capabilities, tools: false } })];
    const edited: ModelDraft[] = [
      {
        ...saved[0]!,
        capabilities: { ...saved[0]!.capabilities, vision: !saved[0]!.capabilities.vision },
        pricing: { input: 1, output: 2 },
      },
    ];
    const [sent] = modelsPatch(saved, edited).models;
    expect(sent!.capabilities).toEqual({ vision: !saved[0]!.capabilities.vision });
    expect(sent!.capabilities).not.toHaveProperty('tools');
    // A new model goes out whole.
    const added = draft(model('fresh'));
    expect(modelsPatch(saved, [...saved, added]).models).toEqual([
      expect.objectContaining({ modelId: 'fresh', capabilities: added.capabilities }),
    ]);
  });

  it('sends removed models by id', () => {
    const saved = [draft(model('a')), draft(model('b'))];
    expect(modelsPatch(saved, saved.slice(1))).toEqual({ models: [], remove: ['a'] });
  });
});

describe('add custom model provider', () => {
  const form = {
    name: 'Box',
    baseUrl: 'http://box:8000/v1',
    protocol: 'anthropic_compatible' as const,
    apiKey: '',
    headers: 'X-Org: acme\n',
    models: 'a\nb, a',
    local: false,
  };

  it('sends protocol and discovery when no preset is chosen', () => {
    expect(endpointBody(undefined, form)).toEqual({
      name: 'Box',
      baseUrl: 'http://box:8000/v1',
      kind: 'custom',
      protocol: 'anthropic_compatible',
      discovery: 'manual',
      headers: { 'X-Org': 'acme' },
      models: [{ modelId: 'a' }, { modelId: 'b' }],
    });
  });

  it('lets the preset fill kind and protocol', () => {
    const body = endpointBody(PRESETS[5], { ...form, apiKey: ' k ', headers: '' });
    expect(body).toMatchObject({ presetId: 'lmstudio', apiKey: 'k' });
    expect(body).not.toHaveProperty('protocol');
    expect(body).not.toHaveProperty('headers');
  });

  it('marks an endpoint on the admin network as local (S-12)', () => {
    expect(endpointBody(undefined, { ...form, local: true })).toMatchObject({ local: true });
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(isLoopbackUrl(null)).toBe(false);
  });

  it('rejects headers that are not "Name: value"', () => {
    expect(() => endpointBody(undefined, { ...form, headers: 'nonsense' })).toThrow(/Name: value/);
  });
});

describe('deleting a provider in use', () => {
  it('turns Delete off and says why while Bots use the provider (L5)', async () => {
    const used = await settings([provider({ botCount: 2 })], true);
    expect(used).toMatch(/<button(?=[^>]*aria-label="Delete")(?=[^>]*disabled="")/);
    expect(used).toContain('Used by 2 Bots. Move them to another provider first.');
    expect(providerInUseText(1)).toBe('Used by 1 Bot. Move it to another provider first.');
    expect(providerInUseText(0)).toBeNull();

    const free = await settings([provider({ botCount: 0 })], true);
    expect(free).not.toMatch(/<button(?=[^>]*aria-label="Delete")(?=[^>]*disabled="")/);
    expect(free).not.toContain('Used by');
  });

  it("shows the server's 409 message", async () => {
    const detail = '2 Bots use this provider. Move them to another model first.';
    server.handler = (request) =>
      request.method === 'DELETE' && request.url.endsWith(`/api/v1/providers/${PROVIDER_ID}`)
        ? Response.json(
            { title: 'Conflict', status: 409, code: 'PROVIDER_IN_USE', detail },
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          )
        : new Response(null, { status: 404 });
    const error = await deleteProvider(PROVIDER_ID).catch((e: Error) => e);
    expect(error).toMatchObject({ status: 409, code: 'PROVIDER_IN_USE' });
    expect(renderToString(<ErrorText error={error as Error} />)).toContain(detail);
  });
});
