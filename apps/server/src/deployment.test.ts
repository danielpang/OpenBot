import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/client.js';
import { botLimitReached } from './services/bots.js';
import { routineLimitReached } from './services/routines.js';
import { skillImportOverLimit, skillLimitReached } from './services/skills.js';
import { createTestApp, ORIGIN, type TestApp } from './test-app.js';
import { ensureWorkspace, updateSettings } from './workspace.js';

// OPENBOTS_DEPLOYMENT: a self-hosted install (the default) is one implicit
// organization with one account, its owner (plan 21.2). Sign-up closes once
// it exists; there are no organization routes, which the managed build
// (ee/server) adds; the settings that only matter with members keep their
// defaults. Audit rows are still written.

const ORGANIZATION_ROUTES: [string, string][] = [
  ['GET', '/api/v1/organizations'],
  ['POST', '/api/v1/organizations'],
  ['GET', '/api/v1/organization/members'],
  ['GET', '/api/v1/organization/audit'],
  ['GET', '/api/v1/admin/members'],
  ['GET', '/api/v1/admin/audit'],
];

function call(t: TestApp, method: string, path: string, cookie?: string, body?: unknown) {
  return t.app.request(path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('a self-hosted install', () => {
  let t: TestApp;
  let owner: string;

  beforeAll(async () => {
    t = await createTestApp();
    const res = await t.app.request('/api/v1/setup/admin', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'correct horse' }),
    });
    expect(res.status).toBe(201);
    owner = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
  });
  afterAll(() => t.close());

  it('reports itself as self-hosted', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(await res.json()).toMatchObject({ deployment: 'self_hosted' });
  });

  it('makes the setup account the owner of its one organization', async () => {
    const res = await call(t, 'GET', '/api/v1/me', owner);
    const workspace = await ensureWorkspace(t.db);
    expect(await res.json()).toMatchObject({
      role: 'owner',
      workspace: { id: workspace.id, suspended: false },
    });
  });

  it('closes sign-up after the owner', async () => {
    const first = await t.signUp('bob@example.com');
    expect(first.res.status).toBe(403);
    expect(await first.res.json()).toMatchObject({ code: 'SIGNUP_CLOSED' });
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  it('works in the implicit organization whatever a session names', async () => {
    const other = await t.createOrganization('Elsewhere');
    await t.switchOrganization(owner, other);
    const res = await call(t, 'GET', '/api/v1/me', owner);
    expect(await res.json()).toMatchObject({
      workspace: { id: (await ensureWorkspace(t.db)).id },
    });
    await t.switchOrganization(owner, null);
    expect((await call(t, 'GET', '/api/v1/bots', owner)).status).toBe(200);
  });

  it('names a webhook endpoint by its Bot handle', async () => {
    const bot = (await (
      await call(t, 'POST', '/api/v1/bots', owner, { name: 'Hooky' })
    ).json()) as {
      id: string;
      handle: string;
    };
    const res = await call(t, 'GET', `/api/v1/bots/${bot.id}/endpoints`, owner);
    const { items } = (await res.json()) as { items: { url: string }[] };
    expect(items[0]!.url).toBe(`${ORIGIN}/hooks/${bot.handle}`);
  });

  it('has no organization routes, even for the owner', async () => {
    for (const [method, path] of ORGANIZATION_ROUTES) {
      expect((await call(t, method, path, owner, method === 'GET' ? undefined : {})).status).toBe(
        404,
      );
      expect((await call(t, method, path)).status).toBe(404);
    }
  });

  it('still records audit rows', async () => {
    const rows = await t.db.select().from(schema.auditLog);
    expect(rows.map((r) => r.action)).toContain('auth.sign_in');
  });

  it('keeps the limits and custom stdio for the owner, and the rest at defaults', async () => {
    const workspace = await ensureWorkspace(t.db);
    await updateSettings(t.db, workspace, { auditRetentionDays: 7 });
    // The owner is the operator: no ceiling, and any limit up or down.
    const raised = await call(t, 'PATCH', '/api/v1/settings', owner, {
      limits: { botsPerAccount: 500 },
    });
    expect(await raised.json()).toMatchObject({ limits: { botsPerAccount: 500 }, ceilings: null });
    const res = await call(t, 'PATCH', '/api/v1/settings', owner, {
      limits: { botsPerGroup: 4 },
      customStdioEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      auditRetentionDays: 180,
      customStdioEnabled: true,
      limits: { botsPerGroup: 4 },
    });

    for (const body of [{ auditRetentionDays: 30 }]) {
      const refused = await call(t, 'PATCH', '/api/v1/settings', owner, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'MANAGED_ONLY' });
    }
  });
});

describe('the managed service', () => {
  let t: TestApp;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    admin = (await t.signUp('ada@example.com')).cookie!;
  });
  afterAll(() => t.close());

  it('reports itself as managed', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(await res.json()).toMatchObject({ deployment: 'managed' });
  });

  it('lets a second account sign up, and keeps the core free of organization routes', async () => {
    expect((await t.signUp('bob@example.com')).res.status).toBe(200);
    expect((await call(t, 'GET', '/api/v1/me', admin)).status).toBe(200);
    // The managed build (ee/server) adds them.
    expect((await call(t, 'GET', '/api/v1/organizations', admin)).status).toBe(404);
  });
});

describe('the single owner', () => {
  // PGlite runs the two one after the other; on Postgres the recheck under the
  // workspace lock in auth.ts is what keeps a second owner out.
  it('goes to one of two first signups sent together', async () => {
    const t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    try {
      const results = await Promise.all(
        ['ada@example.com', 'bob@example.com'].map((email) => t.signUp(email)),
      );
      expect(results.map((r) => r.res.status).sort()).toEqual([200, 403]);
      expect(await t.db.select().from(schema.users)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('is the only account that gets in once a managed install turns self-hosted', async () => {
    const t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    try {
      const ada = (await t.signUp('ada@example.com')).cookie!;
      const bob = (await t.signUp('bob@example.com')).cookie!;
      (t.deps.config as { deployment: string }).deployment = 'self_hosted';
      expect((await call(t, 'GET', '/api/v1/me', ada)).status).toBe(200);
      const me = await call(t, 'GET', '/api/v1/me', bob);
      expect(me.status).toBe(403);
      expect(await me.json()).toMatchObject({ code: 'NOT_OWNER' });
      const signIn = await t.app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'bob@example.com', password: 'correct horse battery' }),
      });
      expect(signIn.status).toBe(403);
      expect(await signIn.json()).toMatchObject({ code: 'NOT_OWNER' });
    } finally {
      await t.close();
    }
  });
});

describe('limit messages', () => {
  it('send a self-hosted owner to Settings > Limits, and managed members to an admin', () => {
    const selfHosted = { deployment: 'self_hosted' } as const;
    for (const error of [
      botLimitReached(2, selfHosted),
      routineLimitReached(2, selfHosted),
      skillLimitReached(2, selfHosted),
      skillImportOverLimit(3, 2, 0, selfHosted),
    ]) {
      expect(error.message).toContain('in Settings > Limits');
      expect(error.message).not.toMatch(/admin/i);
    }
    expect(botLimitReached(2, { deployment: 'managed' }).message).toContain(
      'ask an admin to raise it',
    );
  });
});
