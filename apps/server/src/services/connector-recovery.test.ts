import { TEST_STDIO_SERVER } from '@openbots/mcp/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import * as connectors from './connectors.js';
import { recheckConnectorsOnBoot } from './connector-startup.js';

describe('default GitHub auth, retries and boot recovery', () => {
  let t: TestApp;
  let cookie: string;
  let second: string;
  let owner: { id: string; workspaceId: string };
  const post = (body: object, session = cookie) =>
    t.app.request('/api/v1/connectors', {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const create = async (body: object) => {
    const response = await post(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as {
      id: string;
      auth: string;
      oauth: { connected: boolean } | null;
    };
  };
  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_CUSTOM_STDIO: 'true',
      OPENBOTS_STDIO_RUNNER: 'host',
      OPENBOTS_ALLOW_HOST_STDIO: '1',
    });
    cookie = (await t.signUp('recovery-owner@example.com')).cookie!;
    second = (await t.signUp('recovery-member@example.com')).cookie!;
    owner = {
      id: await t.userId('recovery-owner@example.com'),
      workspaceId: await t.defaultOrganization(),
    };
    const settings = await t.app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customStdioEnabled: true }),
    });
    expect(settings.status).toBe(200);
  });
  beforeEach(async () => {
    await connectors.closeMcpManager(t.ownerDeps);
    await t.db.delete(schema.connectors);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await connectors.closeMcpManager(t.ownerDeps);
    await t.close();
  });

  it('defaults the bare GitHub button request to OAuth while preserving explicit PATs', async () => {
    expect(await create({ catalogId: 'github' })).toMatchObject({
      auth: 'oauth',
      oauth: { connected: false },
    });
    expect(
      await create({
        catalogId: 'github',
        secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'github_pat_test' },
      }),
    ).toMatchObject({ auth: 'bearer', oauth: null });
    expect(await create({ catalogId: 'github', auth: 'bearer' })).toMatchObject({
      auth: 'bearer',
      oauth: null,
    });
  });

  it('reuses one default sign-in across parallel requests and retries without merging named or other-owner connections', async () => {
    const responses = await Promise.all([
      post({ catalogId: 'github' }),
      post({ catalogId: 'github' }),
      post({ catalogId: 'github' }),
    ]);
    const rows = await Promise.all(
      responses.map(async (response) => {
        expect(response.status, await response.clone().text()).toBe(201);
        return response.json() as Promise<{ id: string }>;
      }),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect((await create({ catalogId: 'github' })).id).toBe(rows[0]!.id);
    expect((await create({ catalogId: 'github', name: 'Another account' })).id).not.toBe(
      rows[0]!.id,
    );
    expect(
      ((await (await post({ catalogId: 'github' }, second)).json()) as { id: string }).id,
    ).not.toBe(rows[0]!.id);
  });

  it('repairs empty legacy bearer rows without deleting duplicates or overwriting working PATs', async () => {
    const empty = await create({ catalogId: 'github', auth: 'bearer' });
    const pat = await create({
      catalogId: 'github',
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'github_pat_keep' },
    });
    expect(await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps))).toBe(1);
    expect(await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps))).toBe(0);
    const repaired = await t.inOrganization(() => connectors.getConnector(t.deps, owner, empty.id));
    expect({
      auth: repaired.config.transport === 'http' ? repaired.config.auth : null,
      oauth: repaired.oauth,
    }).toMatchObject({ auth: 'oauth', oauth: { clientConfigured: true, connected: false } });
    const saved = (
      await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, pat.id))
    )[0]!;
    expect(connectors.openSecrets(t.deps, saved).values.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      'github_pat_keep',
    );
    expect(await t.db.select().from(schema.connectors)).toHaveLength(2);
  });

  it('leaves unreadable credentials untouched instead of failing server startup', async () => {
    const broken = await create({ catalogId: 'github', auth: 'bearer' });
    await t.db
      .update(schema.connectors)
      .set({ secrets: Buffer.from('unreadable-envelope') })
      .where(eq(schema.connectors.id, broken.id));
    await create({ catalogId: 'github', auth: 'bearer' });
    expect(await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps))).toBe(1);
    const [saved] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, broken.id));
    expect(Buffer.from(saved!.secrets!).toString()).toBe('unreadable-envelope');
  });

  it('recovers a stale red MCP after boot and refreshes persisted tools and status', async () => {
    const c = await create({
      name: 'Boot echo',
      command: process.execPath,
      args: [TEST_STDIO_SERVER],
    });
    await t.db
      .update(schema.connectors)
      .set({ status: 'error', lastError: 'Previous process closed' })
      .where(eq(schema.connectors.id, c.id));
    expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(1);
    const [saved] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, c.id));
    expect(saved).toMatchObject({ status: 'ok', lastError: null });
    expect(saved!.lastCheckedAt).toBeInstanceOf(Date);
    expect(
      await t.db
        .select()
        .from(schema.connectorTools)
        .where(eq(schema.connectorTools.connectorId, c.id)),
    ).not.toHaveLength(0);
  });

  it('skips OAuth without consent, empty bearer credentials and built-ins', async () => {
    await create({ catalogId: 'github' });
    await create({ catalogId: 'github', auth: 'bearer' });
    await create({ catalogId: 'web_search' });
    const test = vi.spyOn(connectors, 'testConnector');
    expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(0);
    expect(test).not.toHaveBeenCalled();
  });

  it('does not start a stopped computer just to check stdio', async () => {
    await create({ name: 'Computer echo', command: process.execPath, args: [TEST_STDIO_SERVER] });
    const test = vi.spyOn(connectors, 'testConnector');
    expect(
      await t.inOrganization(() =>
        recheckConnectorsOnBoot({
          ...t.deps,
          config: { ...t.deps.config, stdioRunner: 'computer' },
        }),
      ),
    ).toBe(0);
    expect(test).not.toHaveBeenCalled();
  });

  it('bounds concurrent checks and continues after one fails', async () => {
    for (let index = 0; index < 7; index++)
      await create({
        name: `HTTP ${index}`,
        url: `https://mcp.example.com/${index}`,
        auth: 'none',
      });
    let active = 0;
    let maximum = 0;
    let started = 0;
    const test = vi.spyOn(connectors, 'testConnector').mockImplementation(async () => {
      const first = ++started === 1;
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (first) throw new Error('Unavailable');
      return {} as Awaited<ReturnType<typeof connectors.testConnector>>;
    });
    expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(6);
    expect(test).toHaveBeenCalledTimes(7);
    expect(maximum).toBe(3);
  });

  it('respects suspended membership, policy blocks and shutdown cancellation', async () => {
    const c = await create({
      name: 'Skip echo',
      command: process.execPath,
      args: [TEST_STDIO_SERVER],
    });
    const test = vi.spyOn(connectors, 'testConnector');
    await t.db
      .update(schema.workspaceMembers)
      .set({ suspendedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceMembers.userId, owner.id),
          eq(schema.workspaceMembers.workspaceId, owner.workspaceId),
        ),
      );
    try {
      expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(0);
    } finally {
      await t.db
        .update(schema.workspaceMembers)
        .set({ suspendedAt: null })
        .where(eq(schema.workspaceMembers.userId, owner.id));
    }
    await t.db
      .insert(schema.connectorPolicy)
      .values({ workspaceId: owner.workspaceId, urlPattern: '*', blocked: true });
    try {
      expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(0);
    } finally {
      await t.db.delete(schema.connectorPolicy);
    }
    const abort = new AbortController();
    abort.abort();
    expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps, abort.signal))).toBe(0);
    expect(test).not.toHaveBeenCalled();
    expect(
      (await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id)))[0]!
        .status,
    ).toBe('untested');
  });
});
