import { startFakeOpenAI, type FakeOpenAI } from '@openbots/models/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import type { ComputerProvider } from '@openbots/computer';
import { setComputerProvider } from '../services/computer.js';
import { sealPlaintextProviderHeaders } from '../services/providers.js';
import { createTestApp, type TestApp } from '../test-app.js';

interface Provider {
  id: string;
  name: string;
  slug: string;
  kind: string;
  protocol: string;
  baseUrl: string | null;
  local: boolean;
  headers: string[];
  hasKey: boolean;
  keyHint: string | null;
  status: string;
  presetId: string | null;
  testResult: {
    streaming: boolean;
    tools: boolean;
    latency_ms: number | null;
    error: string | null;
    model_id: string;
  } | null;
  smallModelId: string | null;
  botCount: number;
  scope: string;
}

interface Model {
  modelId: string;
  displayName: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    context_window: number | null;
  };
  pricing: { input: number; output: number } | null;
  enabled: boolean;
  source: string;
}

describe('/api/v1/providers', () => {
  let t: TestApp;
  let admin: string;
  let member: string;
  let fake: FakeOpenAI;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      // The fakes listen on 127.0.0.1; the hosted service keeps this off.
      OPENBOTS_LOCAL_ENDPOINTS: 'true',
    });
    admin = (await t.signUp('admin@example.com')).cookie!;
    member = (await t.signUp('member@example.com')).cookie!;
    fake = await startFakeOpenAI({ models: [{ id: 'qwen3' }, { id: 'llama3.2' }] });
  });
  afterAll(async () => {
    await fake.close();
    await t.close();
  });

  const call = (cookie: string | undefined, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const create = async (body: Record<string, unknown>) => {
    const res = await call(admin, 'POST', '/providers', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Provider;
  };

  const modelsOf = async (id: string) =>
    ((await (await call(member, 'GET', `/providers/${id}/models`)).json()) as { items: Model[] })
      .items;

  it('adds a built-in from its preset with the catalog models, never returning the key', async () => {
    const res = await call(admin, 'POST', '/providers', {
      presetId: 'anthropic',
      apiKey: 'sk-ant-secret',
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('sk-ant-secret');
    const provider = JSON.parse(text) as Provider;
    expect(provider).toMatchObject({
      name: 'Anthropic',
      slug: 'anthropic',
      kind: 'anthropic',
      protocol: 'native',
      baseUrl: null,
      hasKey: true,
      // A key under 20 characters keeps only its last two in the hint (P3).
      keyHint: '…et',
      status: 'untested',
      scope: 'organization',
      botCount: 0,
    });
    const models = await modelsOf(provider.id);
    expect(models.find((m) => m.modelId === 'claude-opus-5-5')).toMatchObject({
      source: 'catalog',
      pricing: { input: 4, output: 20 },
    });
  });

  it('validates presets, keys, protocols and placeholders', async () => {
    const codes = async (body: Record<string, unknown>) =>
      ((await (await call(admin, 'POST', '/providers', body)).json()) as { code: string }).code;
    expect(await codes({ presetId: 'openai' })).toBe('API_KEY_REQUIRED');
    expect(await codes({ presetId: 'nope', apiKey: 'k' })).toBe('UNKNOWN_PRESET');
    expect(
      await codes({ name: 'X', kind: 'custom', protocol: 'native', baseUrl: 'http://x/v1' }),
    ).toBe('INVALID_PROTOCOL');
    expect(await codes({ name: 'X', protocol: 'openai_compatible' })).toBe('BASE_URL_REQUIRED');
    expect(await codes({ presetId: 'azure-openai', apiKey: 'k' })).toBe('BASE_URL_PLACEHOLDER');
    expect(await codes({ presetId: 'anthropic', apiKey: 'again' })).toBe('SLUG_TAKEN');
  });

  it("lets members read but not change the organization's providers", async () => {
    const list = await call(member, 'GET', '/providers');
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: Provider[] };
    expect(items.map((p) => p.slug)).toEqual(['anthropic']);
    // Members learn that a key is set, not which (P3).
    expect(items[0]).toMatchObject({ hasKey: true, keyHint: null });
    const orgWide = { presetId: 'groq', apiKey: 'k', scope: 'organization' };
    expect((await call(member, 'POST', '/providers', orgWide)).status).toBe(403);
    expect((await call(member, 'DELETE', `/providers/${items[0]!.id}`)).status).toBe(403);
    expect((await call(member, 'POST', `/providers/${items[0]!.id}/test`)).status).toBe(403);
    expect((await call(member, 'PATCH', `/providers/${items[0]!.id}`, { name: 'X' })).status).toBe(
      403,
    );
    expect(
      (await call(member, 'PUT', `/providers/${items[0]!.id}/models`, { models: [] })).status,
    ).toBe(403);
    expect((await call(undefined, 'GET', '/providers')).status).toBe(401);
  });

  it("gives members their own providers, first for their Bots and hidden from everyone else's (L6)", async () => {
    const res = await call(member, 'POST', '/providers', {
      presetId: 'anthropic',
      apiKey: 'sk-ant-mine-0123456789',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const own = (await res.json()) as Provider;
    // The same slug as the organization's: they live side by side.
    expect(own).toMatchObject({ scope: 'account', slug: 'anthropic', keyHint: 'sk-ant-…6789' });
    const mine = ((await (await call(member, 'GET', '/providers')).json()) as { items: Provider[] })
      .items;
    expect(mine.map((p) => [p.scope, p.slug])).toEqual([
      ['account', 'anthropic'],
      ['organization', 'anthropic'],
    ]);
    // A new Bot of theirs gets their own provider's default.
    const bot = await call(member, 'POST', '/bots', { name: 'Mine first' });
    expect(
      ((await bot.json()) as { modelConfig: { provider_id: string } }).modelConfig,
    ).toMatchObject({ provider_id: own.id });
    // An admin neither sees nor changes it.
    const theirs = (
      (await (await call(admin, 'GET', '/providers')).json()) as { items: Provider[] }
    ).items;
    expect(theirs.map((p) => p.id)).not.toContain(own.id);
    expect((await call(admin, 'PATCH', `/providers/${own.id}`, { name: 'Taken' })).status).toBe(
      404,
    );
    expect((await call(admin, 'DELETE', `/providers/${own.id}`)).status).toBe(404);
    // Nor may another member's Bot name it.
    const adminBot = await call(admin, 'POST', '/bots', {
      name: 'Borrower',
      modelConfig: { provider_id: own.id, model_id: 'claude-opus-5-5' },
    });
    expect(adminBot.status).toBe(404);
    // Theirs to change and delete, once no Bot uses it.
    expect((await call(member, 'PATCH', `/providers/${own.id}`, { name: 'Mine' })).status).toBe(
      200,
    );
    await t.db.delete(schema.bots).where(eq(schema.bots.name, 'Mine first'));
    expect((await call(member, 'DELETE', `/providers/${own.id}`)).status).toBe(204);
  });

  it("shows a key's hint to admins, and to the owner of an account provider (P3)", async () => {
    const [anthropic] = (
      (await (await call(admin, 'GET', '/providers')).json()) as { items: Provider[] }
    ).items;
    expect(anthropic).toMatchObject({ hasKey: true, keyHint: '…et' });

    const { encryptSecret, keyringFromConfig } = await import('../secrets.js');
    const [owner] = await t.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'member@example.com'));
    const [own] = await t.db
      .insert(schema.providers)
      .values({
        workspaceId: (await t.db.select().from(schema.workspaces))[0]!.id,
        ownerId: owner!.id,
        kind: 'openai',
        protocol: 'native',
        name: 'My OpenAI',
        slug: 'my-openai',
        headers: [],
        secrets: encryptSecret('sk-proj-0123456789abcdefWXYZ', keyringFromConfig(t.deps.config)),
        keyHint: 'sk-proj-…WXYZ',
        status: 'untested',
      })
      .returning();
    const mine = ((await (await call(member, 'GET', '/providers')).json()) as { items: Provider[] })
      .items;
    expect(mine.find((p) => p.id === own!.id)).toMatchObject({
      scope: 'account',
      keyHint: 'sk-proj-…WXYZ',
    });
    expect(mine.find((p) => p.slug === 'anthropic')!.keyHint).toBeNull();
    await t.db.delete(schema.providers).where(eq(schema.providers.id, own!.id));
  });

  it('lists presets for the add-provider form', async () => {
    const res = await call(member, 'GET', '/providers/presets');
    const { items } = (await res.json()) as { items: { id: string; baseUrl: string | null }[] };
    expect(items.map((p) => p.id)).toEqual(
      expect.arrayContaining(['ollama', 'azure-openai', 'openrouter']),
    );
  });

  describe('a custom OpenAI-compatible endpoint', () => {
    let local: Provider;

    beforeAll(async () => {
      local = await create({
        name: 'Local LLM',
        protocol: 'openai_compatible',
        baseUrl: fake.baseUrl,
        local: true,
        apiKey: 'sk-local',
        headers: { 'x-team': 'ops' },
        models: [{ modelId: 'qwen3', capabilities: { vision: true } }],
      });
    });

    it('stores the endpoint and its manual model', async () => {
      expect(local).toMatchObject({
        slug: 'local-llm',
        kind: 'custom',
        local: true,
        headers: ['x-team'],
        hasKey: true,
        presetId: null,
      });
      // Header values are sealed and never returned (S-9).
      const [row] = await t.db
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, local.id));
      expect(row!.headers).toEqual(['x-team']);
      expect(row!.headerSecrets).not.toBeNull();
      expect(row!.headerSecrets!.toString('latin1')).not.toContain('ops');
      expect(await modelsOf(local.id)).toEqual([
        expect.objectContaining({
          modelId: 'qwen3',
          source: 'manual',
          capabilities: expect.objectContaining({ tools: true, vision: true }),
        }),
      ]);
    });

    it('discovers models and merges them without clobbering edits', async () => {
      const put = await call(admin, 'PUT', `/providers/${local.id}/models`, {
        models: [
          { modelId: 'qwen3', displayName: 'Qwen 3 (mine)', pricing: { input: 0, output: 0 } },
        ],
      });
      expect(put.status).toBe(200);

      const res = await call(admin, 'POST', `/providers/${local.id}/discover`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { added: number; items: Model[] };
      expect(body.added).toBe(1);
      expect(body.items.find((m) => m.modelId === 'qwen3')).toMatchObject({
        displayName: 'Qwen 3 (mine)',
        source: 'manual',
        pricing: { input: 0, output: 0 },
        capabilities: expect.objectContaining({ vision: true }),
      });
      expect(body.items.find((m) => m.modelId === 'llama3.2')).toMatchObject({
        source: 'discovered',
      });
      const discoverCall = fake.requests.find((r) => r.url === '/v1/models')!;
      expect(discoverCall.headers).toMatchObject({
        authorization: 'Bearer sk-local',
        'x-team': 'ops',
      });

      const again = (await (
        await call(admin, 'POST', `/providers/${local.id}/discover`)
      ).json()) as { added: number };
      expect(again.added).toBe(0);
    });

    it('edits, disables and removes models', async () => {
      const res = await call(admin, 'PUT', `/providers/${local.id}/models`, {
        models: [
          { modelId: 'llama3.2', enabled: false, capabilities: { context_window: 128000 } },
          { modelId: 'extra', displayName: 'Extra' },
        ],
        remove: ['extra'],
      });
      const { items } = (await res.json()) as { items: Model[] };
      expect(items.map((m) => m.modelId).sort()).toEqual(['llama3.2', 'qwen3']);
      expect(items.find((m) => m.modelId === 'llama3.2')).toMatchObject({
        enabled: false,
        capabilities: { tools: true, vision: false, reasoning: false, context_window: 128000 },
      });
    });

    it('tests streaming and tool calling and stores the result', async () => {
      const res = await call(admin, 'POST', `/providers/${local.id}/test`);
      expect(res.status).toBe(200);
      const provider = (await res.json()) as Provider;
      expect(provider.status).toBe('ok');
      expect(provider.testResult).toMatchObject({
        model_id: 'qwen3',
        streaming: true,
        tools: true,
        error: null,
      });
    });

    it('turns off the tools flag when the test disproves it', async () => {
      const noTools = await startFakeOpenAI({ toolCalls: false });
      try {
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: noTools.baseUrl });
        const res = await call(admin, 'POST', `/providers/${local.id}/test`, { modelId: 'qwen3' });
        const provider = (await res.json()) as Provider;
        expect(provider.status).toBe('degraded');
        expect(provider.testResult).toMatchObject({ streaming: true, tools: false });
        expect(
          (await modelsOf(local.id)).find((m) => m.modelId === 'qwen3')!.capabilities.tools,
        ).toBe(false);
      } finally {
        await noTools.close();
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: fake.baseUrl });
        await call(admin, 'PUT', `/providers/${local.id}/models`, {
          models: [{ modelId: 'qwen3', capabilities: { tools: true } }],
        });
      }
    });

    it('turns the tools flag back on when a later test passes', async () => {
      const noTools = await startFakeOpenAI({ toolCalls: false });
      const toolsOf = async () =>
        (await modelsOf(local.id)).find((m) => m.modelId === 'qwen3')!.capabilities.tools;
      const test = async () =>
        (await (
          await call(admin, 'POST', `/providers/${local.id}/test`, { modelId: 'qwen3' })
        ).json()) as Provider;
      try {
        // A transient failure turns the flag off; the next passing test restores it.
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: noTools.baseUrl });
        expect((await test()).status).toBe('degraded');
        expect(await toolsOf()).toBe(false);
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: fake.baseUrl });
        expect((await test()).status).toBe('ok');
        expect(await toolsOf()).toBe(true);

        // After a failure, the user confirms the flag off by hand: a pass leaves it off.
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: noTools.baseUrl });
        await test();
        await call(admin, 'PUT', `/providers/${local.id}/models`, {
          models: [{ modelId: 'qwen3', capabilities: { tools: false } }],
        });
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: fake.baseUrl });
        expect((await test()).status).toBe('ok');
        expect(await toolsOf()).toBe(false);

        // Editing another flag keeps what the failed test turned off.
        await call(admin, 'PUT', `/providers/${local.id}/models`, {
          models: [{ modelId: 'qwen3', capabilities: { tools: true } }],
        });
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: noTools.baseUrl });
        await test();
        await call(admin, 'PUT', `/providers/${local.id}/models`, {
          models: [{ modelId: 'qwen3', capabilities: { vision: true } }],
        });
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: fake.baseUrl });
        await test();
        expect(await toolsOf()).toBe(true);
        // The bookkeeping stays out of the API.
        const [row] = await t.db
          .select()
          .from(schema.providerModels)
          .where(eq(schema.providerModels.modelId, 'qwen3'));
        expect(row!.capabilities).not.toHaveProperty('off_by_test');
        expect((await modelsOf(local.id))[0]!.capabilities).not.toHaveProperty('off_by_test');
      } finally {
        await noTools.close();
        await call(admin, 'PATCH', `/providers/${local.id}`, { baseUrl: fake.baseUrl });
        await call(admin, 'PUT', `/providers/${local.id}/models`, {
          models: [{ modelId: 'qwen3', capabilities: { tools: true } }],
        });
      }
    });

    it('reports a failing endpoint in the result instead of failing the request', async () => {
      const down = await create({
        name: 'Down',
        protocol: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        local: true,
        models: [{ modelId: 'm' }],
      });
      const res = await call(admin, 'POST', `/providers/${down.id}/test`);
      expect(res.status).toBe(200);
      const provider = (await res.json()) as Provider;
      expect(provider.status).toBe('error');
      expect(provider.testResult).toMatchObject({
        streaming: false,
        tools: false,
        latency_ms: null,
      });
      expect(provider.testResult!.error).toMatch(/^Streaming failed/);
      expect((await modelsOf(down.id))[0]!.capabilities.tools).toBe(true);

      const discover = await call(admin, 'POST', `/providers/${down.id}/discover`);
      expect(discover.status).toBe(502);
      expect(((await discover.json()) as { code: string }).code).toBe('DISCOVERY_FAILED');
      expect((await call(admin, 'DELETE', `/providers/${down.id}`)).status).toBe(204);
    });

    it('sets and clears the small-model override', async () => {
      const set = await call(admin, 'PATCH', `/providers/${local.id}`, { smallModelId: 'qwen3' });
      expect(((await set.json()) as Provider).smallModelId).toBe('qwen3');
      const bad = await call(admin, 'PATCH', `/providers/${local.id}`, { smallModelId: 'nope' });
      expect(bad.status).toBe(400);
      const cleared = await call(admin, 'PATCH', `/providers/${local.id}`, { smallModelId: null });
      expect(((await cleared.json()) as Provider).smallModelId).toBeNull();
    });

    it('refuses private base URLs unless the endpoint is marked local (S-12)', async () => {
      const res = await call(admin, 'POST', '/providers', {
        name: 'Sneaky',
        protocol: 'openai_compatible',
        baseUrl: 'http://169.254.169.254/v1',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PRIVATE_HOST');
      const patched = await call(admin, 'PATCH', `/providers/${local.id}`, { local: false });
      expect(patched.status).toBe(400);
      expect(((await patched.json()) as { code: string }).code).toBe('PRIVATE_HOST');

      // A row that stopped being local, or a host that now resolves privately, is refused
      // at request time too: the test reports it instead of reaching the endpoint.
      await t.db
        .update(schema.providers)
        .set({ local: false })
        .where(eq(schema.providers.id, local.id));
      const before = fake.requests.length;
      const tested = (await (
        await call(admin, 'POST', `/providers/${local.id}/test`)
      ).json()) as Provider;
      expect(tested.status).toBe('error');
      expect(tested.testResult!.error).toContain('private or local network');
      const discover = await call(admin, 'POST', `/providers/${local.id}/discover`);
      expect(discover.status).toBe(502);
      expect(await discover.text()).toContain('private or local network');
      expect(fake.requests.length).toBe(before);
      // Through the guard, with the test exemption, streaming and tool calls still work.
      t.deps.net = { allowPrivateNetwork: true };
      try {
        const guarded = (await (
          await call(admin, 'POST', `/providers/${local.id}/test`)
        ).json()) as Provider;
        expect(guarded.status).toBe('ok');
      } finally {
        delete t.deps.net;
      }
      await t.db
        .update(schema.providers)
        .set({ local: true })
        .where(eq(schema.providers.id, local.id));
    });

    it('drops the stored key when the base URL moves to another host (S-12)', async () => {
      const moved = await create({
        name: 'Movable',
        protocol: 'openai_compatible',
        baseUrl: fake.baseUrl,
        local: true,
        apiKey: 'sk-movable',
      });
      const patch = async (body: Record<string, unknown>) => {
        const res = await call(admin, 'PATCH', `/providers/${moved.id}`, body);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as Provider;
      };
      // Same host, another path: the key stays.
      expect(await patch({ baseUrl: `${fake.baseUrl}/` })).toMatchObject({
        hasKey: true,
        keyHint: '…le',
      });
      // Another host: the key is gone and has to be entered again.
      const elsewhere = fake.baseUrl.replace('127.0.0.1', 'localhost');
      expect(await patch({ baseUrl: elsewhere })).toMatchObject({
        hasKey: false,
        keyHint: null,
        baseUrl: elsewhere,
        status: 'untested',
      });
      // A key sent with the move is kept, with its own hint.
      expect(
        await patch({ baseUrl: fake.baseUrl, apiKey: 'sk-again-0123456789abcdef' }),
      ).toMatchObject({ hasKey: true, keyHint: 'sk-…cdef' });
      const [audit] = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, moved.id));
      expect(JSON.stringify(audit)).not.toContain('sk-');
      expect((await call(admin, 'DELETE', `/providers/${moved.id}`)).status).toBe(204);
    });

    it('drops the extra headers when the base URL moves to another host (S-12)', async () => {
      const moved = await create({
        name: 'Headed',
        protocol: 'openai_compatible',
        baseUrl: fake.baseUrl,
        local: true,
        headers: { 'x-gateway-key': 'sekrit-gateway' },
      });
      const patch = async (body: Record<string, unknown>) => {
        const res = await call(admin, 'PATCH', `/providers/${moved.id}`, body);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as Provider;
      };
      const stored = async () =>
        (await t.db.select().from(schema.providers).where(eq(schema.providers.id, moved.id)))[0]!;
      const dropped = async () =>
        (
          await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, moved.id))
        ).filter((a) => (a.metadata as { headersDropped?: boolean }).headersDropped).length;
      // Same host: the headers stay.
      expect((await patch({ baseUrl: `${fake.baseUrl}/` })).headers).toEqual(['x-gateway-key']);
      // Another host: the names and sealed values are gone, and the audit entry says so.
      const elsewhere = fake.baseUrl.replace('127.0.0.1', 'localhost');
      expect(await patch({ baseUrl: elsewhere })).toMatchObject({
        headers: [],
        status: 'untested',
      });
      expect((await stored()).headerSecrets).toBeNull();
      expect(await dropped()).toBe(1);
      // Headers sent with the move are kept.
      expect(
        (await patch({ baseUrl: fake.baseUrl, headers: { 'x-gateway-key': 'sekrit-again' } }))
          .headers,
      ).toEqual(['x-gateway-key']);
      expect((await stored()).headerSecrets).not.toBeNull();
      expect(await dropped()).toBe(1);
      expect((await call(admin, 'DELETE', `/providers/${moved.id}`)).status).toBe(204);
    });

    it('updates and removes the key without returning it', async () => {
      const res = await call(admin, 'PATCH', `/providers/${local.id}`, {
        apiKey: null,
        name: 'Local',
      });
      expect(await res.clone().text()).not.toContain('sk-local');
      expect((await res.json()) as Provider).toMatchObject({
        hasKey: false,
        name: 'Local',
        status: 'untested',
      });
    });
  });

  it('seals header values stored before S-9 (data migration)', async () => {
    const workspaceId = (await t.db.select().from(schema.workspaces))[0]!.id;
    const [legacy] = await t.db
      .insert(schema.providers)
      .values({
        workspaceId,
        kind: 'custom',
        protocol: 'openai_compatible',
        name: 'Legacy',
        slug: 'legacy',
        baseUrl: fake.baseUrl,
        local: true,
        headers: { 'x-legacy': 'sekrit-legacy-header' },
        status: 'untested',
      })
      .returning();
    const listed = (await (await call(admin, 'GET', '/providers')).json()) as { items: Provider[] };
    expect(listed.items.find((p) => p.id === legacy!.id)!.headers).toEqual(['x-legacy']);

    expect(await sealPlaintextProviderHeaders(t.ownerDeps)).toBeGreaterThan(0);
    const [row] = await t.db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.id, legacy!.id));
    expect(row!.headers).toEqual(['x-legacy']);
    expect(JSON.stringify(row)).not.toContain('sekrit-legacy-header');
    // Sealed values still reach the endpoint.
    await call(admin, 'PUT', `/providers/${legacy!.id}/models`, { models: [{ modelId: 'qwen3' }] });
    await call(admin, 'POST', `/providers/${legacy!.id}/discover`);
    expect(fake.requests.at(-1)!.headers).toMatchObject({ 'x-legacy': 'sekrit-legacy-header' });
    expect(await sealPlaintextProviderHeaders(t.ownerDeps)).toBe(0);
    expect((await call(admin, 'DELETE', `/providers/${legacy!.id}`)).status).toBe(204);
  });

  it('refuses discovery on a non-OpenAI-compatible provider', async () => {
    const [anthropic] = await t.db.select().from(schema.providers);
    const res = await call(admin, 'POST', `/providers/${anthropic!.id}/discover`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('DISCOVERY_UNSUPPORTED');
  });

  it('refuses to delete a provider while a Bot uses it (L5)', async () => {
    const provider = await create({ presetId: 'groq', apiKey: 'gsk' });
    const other = await create({ presetId: 'mistral', apiKey: 'mk' });
    const botRes = await call(member, 'POST', '/bots', {
      name: 'Ada',
      modelConfig: { provider_id: provider.id, model_id: 'llama-3.3-70b-versatile' },
    });
    expect(botRes.status).toBe(201);
    const bot = (await botRes.json()) as { id: string };

    const listed = (
      (await (await call(admin, 'GET', '/providers')).json()) as { items: Provider[] }
    ).items;
    expect(listed.find((p) => p.id === provider.id)!.botCount).toBe(1);

    const refused = await call(admin, 'DELETE', `/providers/${provider.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'PROVIDER_IN_USE' });

    await call(member, 'PATCH', `/bots/${bot.id}`, {
      modelConfig: { provider_id: other.id, model_id: 'mistral-large-latest' },
    });
    expect((await call(admin, 'DELETE', `/providers/${provider.id}`)).status).toBe(204);
    expect((await call(admin, 'DELETE', `/providers/${provider.id}`)).status).toBe(404);
  });

  it('groups enabled models by provider and filters by needs', async () => {
    const get = async (query: string) => {
      const res = await call(member, 'GET', `/models${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { groups: { provider: { slug: string }; models: Model[] }[] })
        .groups;
    };
    const all = await get('');
    expect(all.map((g) => g.provider.slug)).toEqual(['anthropic', 'local-llm', 'mistral']);
    const local = all.find((g) => g.provider.slug === 'local-llm')!;
    // llama3.2 was disabled above.
    expect(local.models.map((m) => m.modelId)).toEqual(['qwen3']);

    const vision = await get('?needs=tools,vision');
    for (const group of vision) {
      for (const m of group.models)
        expect(m.capabilities).toMatchObject({ tools: true, vision: true });
    }
    const reasoning = await get('?needs=tools,vision,reasoning');
    expect(reasoning.map((g) => g.provider.slug)).toEqual(['anthropic']);

    expect((await call(member, 'GET', '/models?needs=telepathy')).status).toBe(400);
  });

  it('filters by what a Bot needs: vision once it has a computer (L4)', async () => {
    const ids = async (query: string) => {
      const res = await call(member, 'GET', `/models${query}`);
      expect(res.status).toBe(200);
      const { groups } = (await res.json()) as { groups: { models: Model[] }[] };
      return groups.flatMap((g) => g.models.map((m) => m.modelId)).sort();
    };
    const newBot = async (body: Record<string, unknown>) =>
      ((await (await call(member, 'POST', '/bots', body)).json()) as { id: string }).id;
    const [local] = await t.db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.slug, 'local-llm'));
    await call(admin, 'PUT', `/providers/${local!.id}/models`, {
      models: [{ modelId: 'text-only', capabilities: { tools: true, vision: false } }],
    });
    const seer = await newBot({ name: 'Seer' });
    const blind = await newBot({ name: 'Blind', toolPolicy: { groups: { computer: 'deny' } } });
    const withTools = await ids('?needs=tools');
    const withVision = await ids('?needs=tools,vision');
    expect(withTools).toContain('text-only');
    expect(withVision).not.toContain('text-only');

    // No computer on this install: tool calling is all any Bot needs.
    expect(await ids(`?botId=${seer}`)).toEqual(withTools);
    setComputerProvider(t.ownerDeps, {} as ComputerProvider);
    try {
      expect(await ids(`?botId=${seer}`)).toEqual(withVision);
      // Denying the computer group takes the computer, and the need, away.
      expect(await ids(`?botId=${blind}`)).toEqual(withTools);
    } finally {
      setComputerProvider(t.ownerDeps, null);
    }
    // Another user's Bot is not found.
    expect((await call(admin, 'GET', `/models?botId=${seer}`)).status).toBe(404);
  });

  it("gives a new Bot the first usable provider's catalog default, thinking on (plan 3)", async () => {
    const [anthropic, mistral] = await Promise.all(
      ['anthropic', 'mistral'].map(async (slug) =>
        (await t.db.select().from(schema.providers)).find((p) => p.slug === slug)!,
      ),
    );
    const modelOf = async (body: Record<string, unknown>) => {
      const res = await call(member, 'POST', '/bots', body);
      expect(res.status).toBe(201);
      return ((await res.json()) as { modelConfig: unknown }).modelConfig;
    };
    const opus = { provider_id: anthropic!.id, model_id: 'claude-opus-5-5', reasoning: true };
    expect(await modelOf({ name: 'Defaulted' })).toEqual(opus);
    const listed = (await (await call(member, 'GET', '/models')).json()) as { default: unknown };
    expect(listed.default).toEqual(opus);
    // A model given, or none on purpose, is kept as it is.
    expect(await modelOf({ name: 'Unset', modelConfig: null })).toBeNull();

    // With the default turned off, or the provider failing, the next provider's default.
    const setOpus = (enabled: boolean) =>
      call(admin, 'PUT', `/providers/${anthropic!.id}/models`, {
        models: [{ modelId: 'claude-opus-5-5', enabled }],
      });
    await setOpus(false);
    try {
      expect(await modelOf({ name: 'Moved on' })).toEqual({
        provider_id: mistral!.id,
        model_id: 'mistral-large-latest',
      });
    } finally {
      await setOpus(true);
    }
    await t.db
      .update(schema.providers)
      .set({ status: 'error' })
      .where(eq(schema.providers.id, anthropic!.id));
    try {
      expect(await modelOf({ name: 'Skipped' })).toMatchObject({ provider_id: mistral!.id });
    } finally {
      await t.db
        .update(schema.providers)
        .set({ status: 'untested' })
        .where(eq(schema.providers.id, anthropic!.id));
    }
  });

  it('prefers a default with vision for a Bot that can use the computer (L4)', async () => {
    const providers = await t.db.select().from(schema.providers);
    const anthropic = providers.find((p) => p.slug === 'anthropic')!;
    const mistral = providers.find((p) => p.slug === 'mistral')!;
    const defaultOf = async (needs: string) =>
      ((await (await call(member, 'GET', `/models?needs=${needs}`)).json()) as { default: unknown })
        .default;
    const opusVision = (vision: boolean) =>
      call(admin, 'PUT', `/providers/${anthropic.id}/models`, {
        models: [{ modelId: 'claude-opus-5-5', capabilities: { vision } }],
      });
    await opusVision(false);
    setComputerProvider(t.ownerDeps, {} as ComputerProvider);
    try {
      // The first provider's default cannot see the screen; the next one's can.
      const res = await call(member, 'POST', '/bots', { name: 'Operator' });
      expect(((await res.json()) as { modelConfig: unknown }).modelConfig).toEqual({
        provider_id: mistral.id,
        model_id: 'mistral-large-latest',
      });
      expect(await defaultOf('tools,vision')).toMatchObject({ provider_id: mistral.id });
      // Without the computer, the first provider's default as before.
      expect(await defaultOf('tools')).toMatchObject({
        provider_id: anthropic.id,
        model_id: 'claude-opus-5-5',
      });
      const blind = await call(member, 'POST', '/bots', {
        name: 'Deskless',
        toolPolicy: { groups: { computer: 'deny' } },
      });
      expect(((await blind.json()) as { modelConfig: unknown }).modelConfig).toMatchObject({
        provider_id: anthropic.id,
      });
    } finally {
      setComputerProvider(t.ownerDeps, null);
      await opusVision(true);
    }
  });
});
