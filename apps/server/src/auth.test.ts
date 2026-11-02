import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptStoredOAuthTokens } from './auth.js';
import { schema } from './db/client.js';
import { createTestApp, ORIGIN, type TestApp } from './test-app.js';

// Sessions and API keys (U4) end to end through the HTTP surface, and the
// active organization they work in (plan 21.2). Sign-up policy,
// organizations and invitations on the managed service are ee/server's and
// tested there; a self-hosted install's owner is in deployment.test.ts.

describe('sessions and API keys on the managed service', () => {
  let t: TestApp;
  let adaCookie: string;
  let adaId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
  });
  afterAll(() => t.close());

  const me = (headers: Record<string, string>) => t.app.request('/api/v1/me', { headers });
  const newKey = async (cookie: string, name = 'script') => {
    const created = await t.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    return (await created.json()) as { id: string; key: string };
  };

  it('answers /me with the active organization and the role there', async () => {
    const { res, cookie } = await t.signUp('ada@example.com');
    expect(res.status).toBe(200);
    adaCookie = cookie!;
    adaId = await t.userId('ada@example.com');
    const body = await (await me({ cookie: adaCookie })).json();
    expect(body).toMatchObject({
      user: { email: 'ada@example.com', name: 'ada' },
      role: 'owner',
      workspace: { name: 'OpenBots', suspended: false },
      limits: { botsPerAccount: 50, botsPerGroup: 6 },
    });
  });

  it('keeps settings to owners and admins', async () => {
    const { cookie } = await t.signUp('frank@example.com');
    expect((await me({ cookie: cookie! })).status).toBe(200);
    const res = await t.app.request('/api/v1/settings', { headers: { cookie: cookie! } });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('answers /me without an organization, and refuses the rest, until there is one', async () => {
    const { cookie } = await t.signUp('nomad@example.com');
    await t.switchOrganization(cookie!, null);
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({
      role: null,
      workspace: null,
      limits: null,
    });
    const bots = await t.app.request('/api/v1/bots', { headers: { cookie: cookie! } });
    expect(bots.status).toBe(403);
    expect(await bots.json()).toMatchObject({ code: 'NO_ORGANIZATION' });
    // An organization they are not in is no organization at all (a stale session).
    const elsewhere = await t.createOrganization('Elsewhere');
    await t.switchOrganization(cookie!, elsewhere);
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({ workspace: null });
    expect((await t.app.request('/api/v1/bots', { headers: { cookie: cookie! } })).status).toBe(
      403,
    );
  });

  it('rejects /me without credentials', async () => {
    const res = await me({});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('authenticates /me with an API key as a bearer token or x-api-key', async () => {
    const { id, key } = await newKey(adaCookie);
    expect(key).toMatch(/^obk_/);

    const credentials: Record<string, string>[] = [
      { authorization: `Bearer ${key}` },
      { 'x-api-key': key },
    ];
    for (const headers of credentials) {
      const res = await me(headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ user: { email: 'ada@example.com' }, role: 'owner' });
    }

    const list = await t.app.request('/api/v1/api-keys', {
      headers: { authorization: `Bearer ${key}` },
    });
    const { items } = (await list.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, name: 'script' });
    expect(items[0]).not.toHaveProperty('key');

    const revoked = await t.app.request(`/api/v1/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie: adaCookie },
    });
    expect(revoked.status).toBe(204);
    expect((await me({ authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it('opens with a key only the organization it was made in, whatever the session switches to', async () => {
    const home = await t.defaultOrganization();
    const { key } = await newKey(adaCookie, 'home');
    const second = await t.createOrganization('Second');
    await t.addMember(adaId, second, 'owner');
    await t.switchOrganization(adaCookie, second);
    try {
      expect(await (await me({ cookie: adaCookie })).json()).toMatchObject({
        workspace: { id: second, name: 'Second' },
      });
      expect(await (await me({ authorization: `Bearer ${key}` })).json()).toMatchObject({
        workspace: { id: home },
      });
      // Each organization lists only its own keys.
      const listed = await t.app.request('/api/v1/api-keys', { headers: { cookie: adaCookie } });
      expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    } finally {
      await t.switchOrganization(adaCookie, home);
    }
  });

  it('stops a key, and a session, in an organization that suspended or removed its user', async () => {
    const { cookie } = await t.signUp('sam@example.com');
    const samId = await t.userId('sam@example.com');
    const home = await t.defaultOrganization();
    const { key } = await newKey(cookie!, 'sam');
    const membership = and(
      eq(schema.workspaceMembers.userId, samId),
      eq(schema.workspaceMembers.workspaceId, home),
    );
    await t.db.update(schema.workspaceMembers).set({ suspendedAt: new Date() }).where(membership);
    const both: Record<string, string>[] = [
      { authorization: `Bearer ${key}` },
      { cookie: cookie! },
    ];
    for (const headers of both) {
      const res = await t.app.request('/api/v1/bots', { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MEMBER_SUSPENDED' });
    }
    // /me still answers, so the app can say why.
    expect(await (await me({ cookie: cookie! })).json()).toMatchObject({
      workspace: { suspended: true },
    });
    await t.db.delete(schema.workspaceMembers).where(membership);
    const res = await me({ authorization: `Bearer ${key}` });
    expect(await res.json()).toMatchObject({ workspace: null });
    expect(
      (await t.app.request('/api/v1/bots', { headers: { authorization: `Bearer ${key}` } })).status,
    ).toBe(403);
  });

  it('refuses a key made without an organization', async () => {
    const created = await t.deps.auth.api.createApiKey({
      body: { name: 'stray', userId: adaId, expiresIn: null },
    });
    const res = await t.app.request('/api/v1/bots', {
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NO_ORGANIZATION' });
  });

  it("does not revoke another user's API key", async () => {
    const { id } = await newKey(adaCookie, 'mine');
    const { cookie } = await t.signUp('gina@example.com');
    const res = await t.app.request(`/api/v1/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie: cookie! },
    });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown API key', async () => {
    expect((await me({ authorization: 'Bearer obk_nope' })).status).toBe(401);
  });

  it('answers CORS preflight only for the public URL origin', async () => {
    const preflight = (origin: string) =>
      t.app.request('/api/v1/me', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    const ok = await preflight(ORIGIN);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const other = await preflight('https://evil.example.com');
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });
});

describe('sign-in provider tokens (S-9)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    });
  });
  afterAll(() => t.close());

  it('encrypts tokens stored in plain text and still hands them out', async () => {
    const { cookie } = await t.signUp('octo@example.com');
    const [user] = await t.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'octo@example.com'));
    const [account] = await t.db
      .insert(schema.accounts)
      .values({
        accountId: '583231',
        providerId: 'github',
        userId: user!.id,
        accessToken: 'gho_plaintext-access',
        refreshToken: 'ghr_plaintext-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();

    expect(await encryptStoredOAuthTokens(t.ownerDeps)).toBe(1);
    const [row] = await t.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account!.id));
    expect(row!.accessToken).not.toContain('plaintext');
    expect(row!.refreshToken).not.toContain('plaintext');
    expect(await encryptStoredOAuthTokens(t.ownerDeps)).toBe(0);

    const res = await t.app.request('/api/auth/get-access-token', {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ accountId: account!.id }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { accessToken: string }).accessToken).toBe(
      'gho_plaintext-access',
    );
  });
});

describe('settings', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_LIMITS_BOTS_PER_ACCOUNT: '20',
    });
    cookie = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(() => t.close());

  const patch = (body: unknown) =>
    t.app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts from the environment', async () => {
    const res = await t.app.request('/api/v1/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      limits: { botsPerAccount: 20, botsPerGroup: 6 },
      customStdioEnabled: false,
    });
  });

  it("persists changes on the organization's row, for that organization only", async () => {
    const res = await patch({ limits: { botsPerGroup: 4 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      limits: { botsPerAccount: 20, botsPerGroup: 4 },
    });
    const home = await t.defaultOrganization();
    const [workspace] = await t.testDb.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, home));
    expect(workspace!.settings).toEqual({
      limits: { botsPerGroup: 4 },
    });

    const { cookie: memberCookie } = await t.signUp('open@example.com');
    const me = await t.app.request('/api/v1/me', { headers: { cookie: memberCookie! } });
    expect(await me.json()).toMatchObject({ role: 'member', limits: { botsPerGroup: 4 } });

    // Another organization keeps its own.
    const other = await t.createOrganization('Other');
    await t.addMember(await t.userId('ada@example.com'), other, 'owner');
    await t.switchOrganization(cookie, other);
    try {
      const theirs = await t.app.request('/api/v1/settings', { headers: { cookie } });
      expect(await theirs.json()).toMatchObject({ limits: { botsPerGroup: 6 } });
    } finally {
      await t.switchOrganization(cookie, home);
    }
  });

  it("lets an admin lower a limit but never raise it above the operator's (plan 21.6)", async () => {
    // OPENBOTS_LIMITS_BOTS_PER_ACCOUNT is 20 here, and Bots per group defaults to 6.
    const raised = await patch({ limits: { botsPerAccount: 21 } });
    expect(raised.status).toBe(400);
    expect(await raised.json()).toMatchObject({ code: 'ABOVE_PLAN_LIMIT' });
    expect((await patch({ limits: { botsPerGroup: 7 } })).status).toBe(400);
    const lowered = await patch({ limits: { botsPerAccount: 5 } });
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toMatchObject({
      limits: { botsPerAccount: 5 },
      ceilings: { botsPerAccount: 20, botsPerGroup: 6 },
    });
    // A higher number in the row counts as the ceiling, wherever limits are read.
    const home = await t.defaultOrganization();
    await t.testDb.db
      .update(schema.workspaces)
      .set({ settings: { limits: { botsPerAccount: 500, botsPerGroup: 99 } } })
      .where(eq(schema.workspaces.id, home));
    const settings = await t.app.request('/api/v1/settings', { headers: { cookie } });
    expect(await settings.json()).toMatchObject({
      limits: { botsPerAccount: 20, botsPerGroup: 6 },
    });
    const me = await t.app.request('/api/v1/me', { headers: { cookie } });
    expect(await me.json()).toMatchObject({ limits: { botsPerAccount: 20, botsPerGroup: 6 } });
    const { organizationSettings } = await import('./workspace.js');
    expect((await organizationSettings(t.ownerDeps, home)).limits.botsPerAccount).toBe(20);
    await t.testDb.db
      .update(schema.workspaces)
      .set({ settings: { limits: { botsPerGroup: 4 } } })
      .where(eq(schema.workspaces.id, home));
  });

  it("caps limits at a ceiling the managed build sets per organization (its plan's)", async () => {
    const home = await t.defaultOrganization();
    const deps = {
      ...t.ownerDeps,
      extensions: {
        limitsCeiling: () => ({ ...t.deps.config.limits, botsPerAccount: 3 }),
      },
    };
    const { organizationSettings } = await import('./workspace.js');
    expect((await organizationSettings(deps, home)).limits.botsPerAccount).toBe(3);
  });

  it('refuses custom stdio on the managed service (S-1)', async () => {
    const res = await patch({ customStdioEnabled: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'SELF_HOSTED_ONLY' });
  });

  it('rejects invalid settings as a problem document', async () => {
    const res = await patch({ signupMode: 'open' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect((await patch({ limits: { botsPerGroup: 0 } })).status).toBe(400);
    expect((await patch({ unknown: true })).status).toBe(400);
  });

  it('has no computer limits to set: 1.0 fixes them (PRD section 6)', async () => {
    const res = await t.app.request('/api/v1/settings', { headers: { cookie } });
    const { limits } = (await res.json()) as { limits: Record<string, number> };
    expect(limits).not.toHaveProperty('computersPerAccount');
    expect(limits).not.toHaveProperty('computerTasksPerBot');
    expect((await patch({ limits: { computersPerAccount: 2 } })).status).toBe(400);

    // An override an older version stored is dropped; the other settings still apply.
    const home = await t.defaultOrganization();
    const [workspace] = await t.testDb.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, home));
    await t.testDb.db
      .update(schema.workspaces)
      .set({
        settings: {
          ...(workspace!.settings as object),
          signupMode: 'open',
          limits: { botsPerGroup: 4, computersPerAccount: 2, computerTasksPerBot: 3 },
        },
      })
      .where(eq(schema.workspaces.id, home));
    const after = await t.app.request('/api/v1/settings', { headers: { cookie } });
    expect(await after.json()).toMatchObject({ limits: { botsPerAccount: 20, botsPerGroup: 4 } });
  });
});
