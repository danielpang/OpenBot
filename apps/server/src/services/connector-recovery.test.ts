import { TEST_STDIO_SERVER } from '@openbots/mcp/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
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
    await t.db.delete(schema.bots);
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

  it('reuses one plain catalog connector across concurrent Connect requests', async () => {
    const responses = await Promise.all([
      post({ catalogId: 'web_search' }),
      post({ catalogId: 'web_search' }),
    ]);
    const rows = await Promise.all(
      responses.map(async (response) => {
        expect(response.status, await response.clone().text()).toBe(201);
        return response.json() as Promise<{ id: string }>;
      }),
    );
    expect(rows[0]!.id).toBe(rows[1]!.id);
    expect(await t.db.select().from(schema.connectors)).toHaveLength(1);
  });

  it('reuses a default connector after successful discovery has added cached metadata', async () => {
    const c = await create({ catalogId: 'github' });
    const [row] = await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id));
    await t.db
      .update(schema.connectors)
      .set({
        config: {
          ...(row!.config as object),
          discovered: { server: { name: 'GitHub', version: '1' }, resources: [], prompts: [] },
        },
        status: 'ok',
        lastCheckedAt: new Date(),
      })
      .where(eq(schema.connectors.id, c.id));
    expect((await create({ catalogId: 'github' })).id).toBe(c.id);
    expect(await t.db.select().from(schema.connectors)).toHaveLength(1);
  });

  it.each([true, false])(
    'preserves inherited denial when merging duplicate Bot permissions (canonical inherits: %s)',
    async (canonicalInherits) => {
      const canonical = await create({ catalogId: 'github' });
      const duplicate = await create({ catalogId: 'github', auth: 'bearer' });
      const [row] = await t.db
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.id, canonical.id));
      const secrets = connectors.openSecrets(t.deps, row!);
      secrets.oauth = { tokens: { access_token: 'ghu_keep', token_type: 'bearer' } };
      await t.db
        .update(schema.connectors)
        .set({ secrets: encryptSecret(JSON.stringify(secrets), keyringFromConfig(t.deps.config)) })
        .where(eq(schema.connectors.id, canonical.id));
      const [bot] = await t.db
        .insert(schema.bots)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          handle: `inherit-${canonicalInherits}`,
          name: 'Inherited denial',
          toolPolicy: { groups: { connector: 'deny' } },
        })
        .returning();
      await t.db.insert(schema.botConnectors).values([
        {
          workspaceId: owner.workspaceId,
          botId: bot!.id,
          connectorId: canonical.id,
          approvalOverride: canonicalInherits ? null : 'ask',
        },
        {
          workspaceId: owner.workspaceId,
          botId: bot!.id,
          connectorId: duplicate.id,
          approvalOverride: canonicalInherits ? 'ask' : null,
        },
      ]);
      await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps));
      expect(
        await t.db
          .select()
          .from(schema.botConnectors)
          .where(eq(schema.botConnectors.botId, bot!.id)),
      ).toMatchObject([{ connectorId: canonical.id, approvalOverride: 'deny' }]);
      expect(await t.db.select().from(schema.connectors)).toHaveLength(1);
    },
  );

  it.each(['bot', 'webhook'])(
    'preserves configured compatibility rows whose slug has a specific %s policy',
    async (location) => {
      const canonical = await create({ catalogId: 'github' });
      const duplicate = await create({ catalogId: 'github', auth: 'bearer' });
      const [row] = await t.db
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.id, canonical.id));
      const secrets = connectors.openSecrets(t.deps, row!);
      secrets.oauth = { tokens: { access_token: 'ghu_keep', token_type: 'bearer' } };
      await t.db
        .update(schema.connectors)
        .set({ secrets: encryptSecret(JSON.stringify(secrets), keyringFromConfig(t.deps.config)) })
        .where(eq(schema.connectors.id, canonical.id));
      const [old] = await t.db
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.id, duplicate.id));
      const policy = { tools: { [`${old!.slug}__write`]: 'deny' } };
      const [bot] = await t.db
        .insert(schema.bots)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          handle: 'slug-policy',
          name: 'Specific denial',
          toolPolicy: location === 'bot' ? policy : {},
        })
        .returning();
      await t.db
        .insert(schema.botConnectors)
        .values({ workspaceId: owner.workspaceId, botId: bot!.id, connectorId: duplicate.id });
      if (location === 'webhook')
        await t.db.insert(schema.webhookEndpoints).values({
          workspaceId: owner.workspaceId,
          botId: bot!.id,
          slug: 'legacy-policy',
          tokenHash: 'test-hash',
          toolPolicyOverride: policy,
        });
      await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps));
      expect(new Set((await t.db.select().from(schema.connectors)).map((row) => row.id))).toEqual(
        new Set([canonical.id, duplicate.id]),
      );
      expect(
        (
          await t.db
            .select()
            .from(schema.botConnectors)
            .where(eq(schema.botConnectors.botId, bot!.id))
        )[0]!.connectorId,
      ).toBe(duplicate.id);
      expect(
        (await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot!.id)))[0]!.toolPolicy,
      ).toEqual(location === 'bot' ? policy : {});
    },
  );

  it('consolidates empty default GitHub duplicates and preserves Bot permissions and credentials', async () => {
    const first = await create({ catalogId: 'github', auth: 'bearer' });
    const duplicate = await create({ catalogId: 'github', auth: 'bearer' });
    const third = await create({ catalogId: 'github', auth: 'bearer' });
    const working = await create({ catalogId: 'github' });
    const pat = await create({
      catalogId: 'github',
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'github_pat_keep' },
    });
    const named = await create({
      catalogId: 'github',
      name: 'Deliberate separate account',
      auth: 'bearer',
    });
    const other = await create({
      catalogId: 'github',
      oauthClient: { clientId: 'Iv.custom', githubAppSlug: 'custom-app' },
    });
    const [row] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, working.id));
    const secrets = connectors.openSecrets(t.deps, row!);
    secrets.oauth = { tokens: { access_token: 'ghu_keep', token_type: 'bearer' } };
    await t.db
      .update(schema.connectors)
      .set({
        secrets: encryptSecret(JSON.stringify(secrets), keyringFromConfig(t.deps.config)),
        config: {
          ...(row!.config as object),
          discovered: { server: { name: 'GitHub', version: '1' } },
        },
        status: 'ok',
      })
      .where(eq(schema.connectors.id, working.id));
    const [bot, onlyDuplicateBot] = await t.db
      .insert(schema.bots)
      .values([
        { workspaceId: owner.workspaceId, ownerId: owner.id, handle: 'dedup-both', name: 'Both' },
        { workspaceId: owner.workspaceId, ownerId: owner.id, handle: 'dedup-one', name: 'One' },
      ])
      .returning();
    await t.db.insert(schema.botConnectors).values([
      {
        workspaceId: owner.workspaceId,
        botId: bot!.id,
        connectorId: first.id,
        toolAllowlist: ['read', 'write'],
        toolDenylist: ['danger'],
        approvalOverride: 'ask',
      },
      {
        workspaceId: owner.workspaceId,
        botId: bot!.id,
        connectorId: working.id,
        toolAllowlist: ['read'],
        approvalOverride: 'auto',
      },
      {
        workspaceId: owner.workspaceId,
        botId: onlyDuplicateBot!.id,
        connectorId: duplicate.id,
        toolAllowlist: ['read'],
        approvalOverride: 'deny',
      },
    ]);
    expect(await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps))).toBe(4);
    expect(await t.inOrganization(() => connectors.repairEmptyGitHubAuth(t.deps))).toBe(0);
    const saved = await t.db.select().from(schema.connectors);
    expect(new Set(saved.map((row) => row.id))).toEqual(
      new Set([working.id, pat.id, named.id, other.id]),
    );
    expect(saved.some((row) => [first.id, duplicate.id, third.id].includes(row.id))).toBe(false);
    expect(
      connectors.openSecrets(
        t.deps,
        saved.find((row) => row.id === working.id)!,
      ).oauth?.tokens?.access_token,
    ).toBe('ghu_keep');
    expect(
      connectors.openSecrets(
        t.deps,
        saved.find((row) => row.id === pat.id)!,
      ).values.GITHUB_PERSONAL_ACCESS_TOKEN,
    ).toBe('github_pat_keep');
    expect(
      await t.db.select().from(schema.botConnectors).where(eq(schema.botConnectors.botId, bot!.id)),
    ).toMatchObject([
      {
        connectorId: working.id,
        toolAllowlist: ['read'],
        toolDenylist: ['danger'],
        approvalOverride: 'ask',
      },
    ]);
    expect(
      await t.db
        .select()
        .from(schema.botConnectors)
        .where(eq(schema.botConnectors.botId, onlyDuplicateBot!.id)),
    ).toMatchObject([
      { connectorId: working.id, toolAllowlist: ['read'], approvalOverride: 'deny' },
    ]);
    expect((await create({ catalogId: 'github' })).id).toBe(working.id);
  });

  it('repairs empty legacy bearer rows without overwriting working PATs', async () => {
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
    const test = vi.spyOn(connectors.mcpManager(t.ownerDeps), 'test');
    expect(await t.inOrganization(() => recheckConnectorsOnBoot(t.deps))).toBe(0);
    expect(test).not.toHaveBeenCalled();
  });

  it('does not start a stopped computer just to check stdio', async () => {
    await create({ name: 'Computer echo', command: process.execPath, args: [TEST_STDIO_SERVER] });
    const test = vi.spyOn(connectors.mcpManager(t.ownerDeps), 'test');
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
      return { checked: true } as Awaited<ReturnType<typeof connectors.testConnector>>;
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
    const test = vi.spyOn(connectors.mcpManager(t.ownerDeps), 'test');
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
