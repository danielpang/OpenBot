import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { setCoderApiKey } from './coder-accounts.js';
import {
  resolveConnectedModel,
  subscriptionFor,
  recordSubscriptionAuthState,
} from './model-connections.js';
import { SUBSCRIPTION_AUTH_ERROR } from '@openbots/shared';
import { createProvider } from './providers.js';

describe('subscription priority', () => {
  it('matches native subscriptions before pi and never matches a key or another pi plan', () => {
    const pi = {
      agent: 'pi',
      authKind: 'subscription',
      accountLabel: 'OpenAI (ChatGPT Plus/Pro), xAI',
    };
    expect(subscriptionFor('openai', [pi])).toEqual({ agent: 'pi', provider: 'openai-codex' });
    expect(subscriptionFor('xai', [pi])).toEqual({ agent: 'pi', provider: 'xai' });
    expect(subscriptionFor('anthropic', [pi])).toBeNull();
    expect(subscriptionFor('google', [pi])).toBeNull();
    expect(
      subscriptionFor('openai', [
        pi,
        { agent: 'codex', authKind: 'subscription', accountLabel: null },
      ]),
    ).toEqual({ agent: 'codex', provider: 'openai-codex' });
    expect(
      subscriptionFor('anthropic', [{ agent: 'claude', authKind: 'api_key', accountLabel: null }]),
    ).toBeNull();
  });
});

describe('connected model resolution', () => {
  let t: TestApp;
  let owner: { id: string; workspaceId: string };
  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('owner@example.com');
    const id = await t.userId('owner@example.com');
    owner = { id, workspaceId: await t.defaultOrganization() };
  });
  afterAll(() => t.close());
  it('requires a key or a real owner subscription when adding a built-in', async () => {
    await expect(
      createProvider(t.ownerDeps, owner, { presetId: 'anthropic' }),
    ).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
    await t.db.insert(schema.coderAccounts).values({
      ...owner,
      ownerId: owner.id,
      agent: 'claude',
      authKind: 'subscription',
      lastError: '401 expired',
    });
    const { row } = await createProvider(t.ownerDeps, owner, { presetId: 'anthropic' });
    expect(row.secrets).toBeNull();
    const config = { provider_id: row.id, model_id: 'claude-opus-5-5' };
    const resolved = await resolveConnectedModel(t.ownerDeps, config, owner);
    expect(typeof resolved.model !== 'string' && resolved.model.provider).toBe(
      'anthropic.subscription',
    );
    expect(resolved.info?.pricing).toBeNull();
    // A lapsed subscription stays selected instead of switching to API charges.
    await setCoderApiKey(t.ownerDeps, owner, 'claude', row.id);
    const [account] = await t.db
      .select()
      .from(schema.coderAccounts)
      .where(
        and(eq(schema.coderAccounts.ownerId, owner.id), eq(schema.coderAccounts.agent, 'claude')),
      );
    expect(account).toMatchObject({ authKind: 'subscription', lastError: '401 expired' });
  });
  it('does not reuse another owner’s subscription on an organization provider', async () => {
    await t.signUp('other@example.com');
    const id = await t.userId('other@example.com');
    const [provider] = await t.db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.slug, 'anthropic'));
    const resolved = await resolveConnectedModel(
      t.ownerDeps,
      { provider_id: provider!.id, model_id: 'claude-opus-5-5' },
      { id, workspaceId: owner.workspaceId },
    );
    expect(typeof resolved.model !== 'string' && resolved.model.provider).not.toBe(
      'anthropic.subscription',
    );
  });

  it('records sanitized auth failures without API fallback and ignores stale login results', async () => {
    const [account] = await t.db
      .select()
      .from(schema.coderAccounts)
      .where(eq(schema.coderAccounts.ownerId, owner.id));
    await recordSubscriptionAuthState(t.ownerDeps, owner, account!, true);
    const read = async () =>
      (
        await t.db
          .select()
          .from(schema.coderAccounts)
          .where(eq(schema.coderAccounts.id, account!.id))
      )[0]!;
    expect(await read()).toMatchObject({
      authKind: 'subscription',
      lastError: SUBSCRIPTION_AUTH_ERROR,
    });
    await recordSubscriptionAuthState(t.ownerDeps, owner, account!, false);
    expect((await read()).lastError).toBeNull();
    await t.db
      .update(schema.coderAccounts)
      .set({ signedInAt: new Date(), lastError: null })
      .where(eq(schema.coderAccounts.id, account!.id));
    await recordSubscriptionAuthState(t.ownerDeps, owner, account!, true);
    expect((await read()).lastError).toBeNull();
  });

  it('never sends a subscription to an overridden host', async () => {
    const { row } = await createProvider(t.ownerDeps, owner, {
      presetId: 'anthropic',
      slug: 'anthropic-local',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com',
    });
    const resolved = await resolveConnectedModel(
      t.ownerDeps,
      { provider_id: row.id, model_id: 'claude-opus-5-5' },
      owner,
    );
    expect(typeof resolved.model !== 'string' && resolved.model.provider).not.toBe(
      'anthropic.subscription',
    );
  });
});
