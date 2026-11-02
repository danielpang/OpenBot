import { Writable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  backfillProviderKeyHints,
  keyHint,
  ollamaBaseUrl,
  providerRegistry,
  seedProvidersFromEnv,
  smallModelFor,
} from './providers.js';

describe('seedProvidersFromEnv', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      ANTHROPIC_API_KEY: 'sk-ant-env',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g-env',
      OLLAMA_BASE_URL: 'http://ollama:11434',
    });
  });
  afterAll(() => t.close());

  const providers = () => t.db.select().from(schema.providers);
  const models = (providerId: string) =>
    t.db
      .select()
      .from(schema.providerModels)
      .where(eq(schema.providerModels.providerId, providerId));
  const bySlug = async (slug: string) => (await providers()).find((p) => p.slug === slug)!;
  const keyring = () => keyringFromConfig(t.deps.config);

  it('creates an instance-level provider per key with sealed secrets and catalog models', async () => {
    await seedProvidersFromEnv(t.ownerDeps);
    const rows = await providers();
    expect(rows.map((r) => r.slug).sort()).toEqual(['anthropic', 'google', 'ollama']);
    for (const row of rows) expect(row.ownerId).toBeNull();

    const anthropic = await bySlug('anthropic');
    expect(anthropic).toMatchObject({
      kind: 'anthropic',
      protocol: 'native',
      presetId: 'anthropic',
      status: 'untested',
    });
    expect(anthropic.secrets!.includes(Buffer.from('sk-ant-env'))).toBe(false);
    expect(decryptSecretString(anthropic.secrets!, keyring())).toBe('sk-ant-env');
    expect(anthropic.keyHint).toBe('…nv');
    const anthropicModels = await models(anthropic.id);
    expect(anthropicModels.map((m) => m.modelId)).toContain('claude-opus-5-5');
    expect(anthropicModels.every((m) => m.source === 'catalog')).toBe(true);

    const ollama = await bySlug('ollama');
    expect(ollama).toMatchObject({
      kind: 'custom',
      protocol: 'openai_compatible',
      baseUrl: 'http://ollama:11434/v1',
      secrets: null,
      discovery: 'list_models',
    });
  });

  it('is idempotent and keeps user edits', async () => {
    const anthropic = await bySlug('anthropic');
    const [opus] = await t.db
      .select()
      .from(schema.providerModels)
      .where(
        and(
          eq(schema.providerModels.providerId, anthropic.id),
          eq(schema.providerModels.modelId, 'claude-opus-5-5'),
        ),
      );
    // An admin renames the provider, edits a model and removes another.
    await t.db
      .update(schema.providers)
      .set({ name: 'Claude (team)' })
      .where(eq(schema.providers.id, anthropic.id));
    await t.db
      .update(schema.providerModels)
      .set({ displayName: 'Opus', enabled: false, pricing: { input: 1, output: 1 } })
      .where(eq(schema.providerModels.id, opus!.id));
    const before = (await models(anthropic.id)).length;

    await seedProvidersFromEnv(t.ownerDeps);
    await seedProvidersFromEnv(t.ownerDeps);

    expect(await providers()).toHaveLength(3);
    expect((await bySlug('anthropic')).name).toBe('Claude (team)');
    expect(await models(anthropic.id)).toHaveLength(before);
    const [after] = await t.db
      .select()
      .from(schema.providerModels)
      .where(eq(schema.providerModels.id, opus!.id));
    expect(after).toMatchObject({
      displayName: 'Opus',
      enabled: false,
      pricing: { input: 1, output: 1 },
    });
  });

  it('keeps a key set in Settings over a different one in .env', async () => {
    const google = await bySlug('google');
    const { encryptSecret } = await import('../secrets.js');
    await t.db
      .update(schema.providers)
      .set({ secrets: encryptSecret('g-settings', keyring()) })
      .where(eq(schema.providers.id, google.id));
    await seedProvidersFromEnv(t.ownerDeps);
    expect(decryptSecretString((await bySlug('google')).secrets!, keyring())).toBe('g-settings');
  });

  it('fills in a key removed in Settings when .env still has one', async () => {
    const google = await bySlug('google');
    await t.db
      .update(schema.providers)
      .set({ secrets: null })
      .where(eq(schema.providers.id, google.id));
    await seedProvidersFromEnv(t.ownerDeps);
    expect(decryptSecretString((await bySlug('google')).secrets!, keyring())).toBe('g-env');
    // Too short to show any of it.
    expect((await bySlug('google')).keyHint).toBeNull();
  });

  it('fills and rewrites stored hints at start-up, logging nothing about the keys (P3)', async () => {
    const key = 'sk-ant-api03-backfill-0123456789';
    const google = await bySlug('google');
    const anthropic = await bySlug('anthropic');
    await t.db
      .update(schema.providers)
      .set({ secrets: encryptSecret(key, keyring()), keyHint: null })
      .where(eq(schema.providers.id, google.id));
    // A hint in the first format, the key's leading characters, is recomputed.
    await t.db
      .update(schema.providers)
      .set({ keyHint: 'sk-an…' })
      .where(eq(schema.providers.id, anthropic.id));
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ level: 'trace' }, sink);

    // Start-up order, as in main.ts: the seed sees a different key, then the backfill runs.
    await seedProvidersFromEnv({ ...t.ownerDeps, logger });
    expect(await backfillProviderKeyHints(t.ownerDeps)).toBe(2);
    expect((await bySlug('google')).keyHint).toBe('sk-ant-…6789');
    expect((await bySlug('anthropic')).keyHint).toBe('…nv');
    // Once stored, the next start leaves it alone.
    expect(await backfillProviderKeyHints(t.ownerDeps)).toBe(0);
    // Ollama has no key, so no hint.
    expect((await bySlug('ollama')).keyHint).toBeNull();

    const logged = lines.join('');
    expect(logged).toContain('differs from .env');
    for (const part of [key, '6789', 'sk-ant-', 'g-env', 'sk-ant-env']) {
      expect(logged).not.toContain(part);
    }
  });

  it('resolves a seeded provider through the registry and picks a small model', async () => {
    const anthropic = await bySlug('anthropic');
    const resolved = await providerRegistry(t.ownerDeps).resolve({
      provider_id: anthropic.id,
      model_id: 'claude-sonnet-5-5',
      reasoning: true,
    });
    expect(resolved.provider.apiKey).toBe('sk-ant-env');
    expect(resolved.info?.capabilities.tools).toBe(true);
    expect(resolved.providerOptions).toEqual({ anthropic: { thinking: { type: 'adaptive' } } });
    expect((resolved.model as { modelId: string }).modelId).toBe('claude-sonnet-5-5');
    expect((await smallModelFor(t.ownerDeps, anthropic.id))?.modelId).toBe('claude-haiku-4-5');
  });

  it('keeps the catalog small model when no model has pricing', async () => {
    const anthropic = await bySlug('anthropic');
    await t.db
      .update(schema.providerModels)
      .set({ pricing: null })
      .where(eq(schema.providerModels.providerId, anthropic.id));
    // Display-name order alone would pick Claude Fable 5.1.
    expect((await smallModelFor(t.ownerDeps, anthropic.id))?.modelId).toBe('claude-haiku-4-5');
  });
});

describe('keyHint', () => {
  it('keeps a known vendor prefix and the last four characters (P3)', () => {
    expect(keyHint('sk-ant-api03-AbCdEfGhIjKlMnOp-a1b2')).toBe('sk-ant-…a1b2');
    expect(keyHint('sk-proj-AbCdEfGhIjKlMnOpQrSt')).toBe('sk-proj-…QrSt');
    expect(keyHint('sk-or-v1-AbCdEfGhIjKlMnOpQrSt')).toBe('sk-or-…QrSt');
    expect(keyHint('xai-AbCdEfGhIjKlMnOpQrSt')).toBe('xai-…QrSt');
    expect(keyHint('gsk_AbCdEfGhIjKlMnOpQrSt')).toBe('gsk_…QrSt');
    expect(keyHint('AIzaSyAbCdEfGhIjKlMnOpQrSt')).toBe('AIza…QrSt');
    expect(keyHint('sk-AbCdEfGhIjKlMnOpQrSt')).toBe('sk-…QrSt');
  });

  it('drops a prefix it does not know, whose characters may be secret', () => {
    expect(keyHint('abc-def-0123456789abcdef')).toBe('…cdef');
    expect(keyHint('sk_live_0123456789abcdef')).toBe('…cdef');
    expect(keyHint('0123456789abcdefghij')).toBe('…ghij');
  });

  it('never shows more than half of a key', () => {
    // Exactly half: sk-ant- and the last 4 are 11 of 22 characters.
    expect(keyHint('sk-ant-0123456789abcde')).toBe('sk-ant-…bcde');
    // One fewer would pass half, so only the last 2.
    expect(keyHint('sk-ant-0123456789abcd')).toBe('…cd');
    // Under 20 characters: only the last 2.
    expect(keyHint('sk-ant-0123456789a')).toBe('…9a');
    expect(keyHint('01234567')).toBe('…67');
    // An allowlisted prefix and nothing more, a very short key, and no key: nothing.
    expect(keyHint('sk-ant-')).toBeNull();
    expect(keyHint('abc')).toBeNull();
    expect(keyHint('')).toBeNull();
  });
});

describe('ollamaBaseUrl', () => {
  it('appends /v1 once', () => {
    expect(ollamaBaseUrl('http://h:11434')).toBe('http://h:11434/v1');
    expect(ollamaBaseUrl('http://h:11434/')).toBe('http://h:11434/v1');
    expect(ollamaBaseUrl('http://h:11434/v1/')).toBe('http://h:11434/v1');
  });
});
