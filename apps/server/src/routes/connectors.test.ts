import {
  TEST_STDIO_SERVER,
  startMockAuthServer,
  startTestHttpServer,
  type MockAuthServer,
  type TestHttpServer,
} from '@openbots/mcp/testing';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EVENTS_CHANNEL } from '@openbots/shared';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import {
  callToolForBot,
  closeMcpManager,
  listToolsForBot,
  mcpManager,
  openSecrets,
  sealPlaintextConnectorValues,
  stdioSpawnFor,
  userDirectory,
} from '../services/connectors.js';
import { connectorToolsFor } from '../builtins/index.js';
import { ensureWorkspace } from '../workspace.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';

interface Connector {
  id: string;
  name: string;
  slug: string;
  kind: string;
  catalogId: string | null;
  transport: string;
  command: string | null;
  args: string[] | null;
  env: string[] | null;
  headers: string[] | null;
  url: string | null;
  auth: string | null;
  params: Record<string, string>;
  secrets: { name: string; set: boolean; required: boolean }[];
  oauth: { clientConfigured: boolean; connected: boolean; expiresAt: string | null } | null;
  status: string;
  lastError: string | null;
  disabledByAdmin: boolean;
  trusted: boolean;
  local: boolean;
  toolCount: number;
}

interface Tool {
  name: string;
  title: string | null;
  annotations: Record<string, unknown>;
}

// Every secret value this suite stores; none may appear in any response body (P3).
const SECRETS = {
  // TEST-NET-3: a public address, as far as the private-host check is concerned.
  postgres: 'postgresql://ro:sekrit-pg-pass@203.0.113.7:5432/app',
  privatePostgres: 'postgresql://ro:sekrit-pg-private@127.0.0.1:5432/app',
  stdio: 'sekrit-stdio-value',
  env: 'sekrit-env-value',
  header: 'sekrit-header-value',
  legacyEnv: 'sekrit-legacy-env',
  legacyHeader: 'sekrit-legacy-header',
  bearer: 'sekrit-bearer-token',
  wrongBearer: 'sekrit-wrong-token',
  imported: 'sekrit-imported-env',
  importedHeader: 'sekrit-imported-bearer',
  clientSecret: 'sekrit-client-secret',
};

describe('/api/v1/connectors', () => {
  let t: TestApp;
  let admin: string;
  let member: string;
  /** A second admin, who runs the custom stdio servers (S-1). */
  let ops: string;
  let filesDir: string;
  /** Stands in for the image's catalog install (S-20). */
  let mcpDir: string;
  const bodies: string[] = [];

  const userId = async (email: string) =>
    (await t.db.select().from(schema.users).where(eq(schema.users.email, email)))[0]!.id;

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'openbots-connectors-'));
    mcpDir = mkdtempSync(join(tmpdir(), 'openbots-mcp-install-'));
    mkdirSync(join(mcpDir, 'node_modules', '.bin'), { recursive: true });
    for (const bin of ['mcp-server-filesystem', 'mcp-server-postgres']) {
      writeFileSync(join(mcpDir, 'node_modules', '.bin', bin), '');
    }
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_FILES_DIR: filesDir,
      OPENBOTS_MCP_DIR: mcpDir,
      // Both stay off on the hosted service (plan 21.6); this suite covers them.
      OPENBOTS_CUSTOM_STDIO: 'true',
      OPENBOTS_LOCAL_ENDPOINTS: 'true',
      // As is host stdio, which this suite covers; computer-stdio.test.ts runs them in computers.
      OPENBOTS_STDIO_RUNNER: 'host',
      OPENBOTS_ALLOW_HOST_STDIO: '1',
    });
    admin = (await t.signUp('admin@example.com')).cookie!;
    member = (await t.signUp('member@example.com')).cookie!;
    ops = (await t.signUp('ops@example.com')).cookie!;
    await t.db
      .update(schema.workspaceMembers)
      .set({ role: 'admin' })
      .where(eq(schema.workspaceMembers.userId, await userId('ops@example.com')));
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await t.close();
    rmSync(filesDir, { recursive: true, force: true });
    rmSync(mcpDir, { recursive: true, force: true });
  });

  const call = async (cookie: string | undefined, method: string, path: string, body?: unknown) => {
    const res = await t.app.request(path.startsWith('/api/') ? path : `/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    bodies.push(await res.clone().text());
    return res;
  };

  const create = async (cookie: string, body: Record<string, unknown>) => {
    const res = await call(cookie, 'POST', '/connectors', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Connector;
  };

  const test = async (cookie: string, id: string) => {
    const res = await call(cookie, 'POST', `/connectors/${id}/test`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { connector: Connector; tools: Tool[] };
  };

  const stdioConnector = (cookie: string, slug: string) =>
    create(cookie, {
      name: 'Test stdio',
      slug,
      transport: 'stdio',
      command: process.execPath,
      args: [TEST_STDIO_SERVER],
      secrets: { TEST_SECRET: SECRETS.stdio },
    });

  const newBot = async (cookie: string, name: string) => {
    const res = await call(cookie, 'POST', '/bots', { name });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  it('refuses custom stdio servers to members, and to admins until it is turned on (S-1)', async () => {
    const body = {
      transport: 'stdio',
      command: process.execPath,
      args: [TEST_STDIO_SERVER],
    };
    let res = await call(member, 'POST', '/connectors', body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'CUSTOM_STDIO_ADMIN_ONLY',
      title: expect.stringContaining('Only an admin'),
    });
    // Off by default, even for admins.
    expect(await (await call(admin, 'GET', '/settings')).json()).toMatchObject({
      customStdioEnabled: false,
    });
    res = await call(ops, 'POST', '/connectors', body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CUSTOM_STDIO_DISABLED' });
    // Pasted JSON cannot add one either, but the rest of the paste is imported.
    res = await call(member, 'POST', '/connectors/import', {
      mcpServers: {
        local: { command: process.execPath, args: [TEST_STDIO_SERVER] },
        remote: { url: 'https://mcp.pasted.example/mcp' },
        // A catalog server runs its pinned command, so a member may paste it (S-1).
        files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    });
    expect(res.status).toBe(200);
    const pasted = (await res.json()) as {
      items: Connector[];
      errors: { name: string; message: string }[];
    };
    expect(pasted.items.map((c) => [c.name, c.transport, c.catalogId])).toEqual([
      ['remote', 'http', null],
      ['files', 'stdio', 'filesystem'],
    ]);
    expect(pasted.errors).toEqual([{ name: 'local', message: expect.any(String) }]);
    // The reason, and what a member can do instead.
    expect(pasted.errors[0]!.message).toContain('Only an admin');
    expect(pasted.errors[0]!.message).toContain('from the catalog');
    expect(pasted.errors[0]!.message).toContain('HTTP URL');
    for (const c of pasted.items) {
      expect((await call(member, 'DELETE', `/connectors/${c.id}`)).status).toBe(204);
    }
    // A member cannot turn it on.
    expect((await call(member, 'PATCH', '/settings', { customStdioEnabled: true })).status).toBe(
      403,
    );

    res = await call(admin, 'PATCH', '/settings', { customStdioEnabled: true });
    expect(await res.json()).toMatchObject({ customStdioEnabled: true });
    expect((await call(member, 'POST', '/connectors', body)).status).toBe(403);
    // Catalog stdio servers run their pinned command, so members may still add those.
    expect((await call(member, 'POST', '/connectors', { catalogId: 'filesystem' })).status).toBe(
      201,
    );
  });

  it('lists the catalog with built-ins and admin flags', async () => {
    const res = await call(member, 'GET', '/connectors/catalog');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: { id: string; kind: string; version: string | null; disabledByAdmin: boolean }[];
    };
    expect(items.map((i) => i.id)).toEqual([
      'github',
      'gmail',
      'google_docs',
      'slack',
      'cloudflare',
      'vercel',
      'supabase',
      'neon',
      'railway',
      'firecrawl',
      'filesystem',
      'postgres',
      'web_search',
      'web_fetch',
      'http_request',
      'email',
      'github_builtin',
    ]);
    expect(items.filter((i) => i.kind === 'builtin')).toHaveLength(5);
    expect(items.every((i) => !i.disabledByAdmin)).toBe(true);
  });

  it('adds catalog connectors with their pinned command, checking required settings and secrets', async () => {
    let res = await call(member, 'POST', '/connectors', {
      catalogId: 'filesystem',
      params: { root: 'notes' },
      command: 'sh',
    });
    expect(((await res.json()) as { code: string }).code).toBe('PINNED');

    const fs = await create(member, { catalogId: 'filesystem', params: { root: './notes/' } });
    expect(fs).toMatchObject({
      slug: 'filesystem-2',
      kind: 'mcp_stdio',
      catalogId: 'filesystem',
      command: 'npx',
      params: { root: 'notes' },
      status: 'untested',
    });
    expect(fs.args).toContain('@modelcontextprotocol/server-filesystem@2026.8.31');

    res = await call(member, 'POST', '/connectors', { catalogId: 'postgres' });
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_SECRET');
    const pg = await create(member, {
      catalogId: 'postgres',
      secrets: { POSTGRES_URL: SECRETS.postgres },
    });
    expect(pg.secrets).toEqual([
      { name: 'POSTGRES_URL', label: 'Connection URL', required: true, set: true },
    ]);

    const builtin = await create(member, { catalogId: 'web_search' });
    expect(builtin).toMatchObject({ kind: 'builtin', transport: 'builtin', builtin: 'web_search' });
    res = await call(member, 'POST', `/connectors/${builtin.id}/test`);
    expect(res.status).toBe(400);

    const github = await create(member, { catalogId: 'github', auth: 'oauth' });
    expect(github.oauth).toEqual({
      clientConfigured: true,
      connected: false,
      expiresAt: null,
      installationUrl: 'https://github.com/apps/openbots-github/installations/new',
    });
    // Device authorization itself is tested with a mocked GitHub endpoint in github-device.test.ts.
  });

  it('runs a stdio connector, caches its tools and stores resources and prompts', async () => {
    const c = await stdioConnector(ops, 'local');
    expect(c.secrets).toEqual([{ name: 'TEST_SECRET', label: null, required: false, set: true }]);
    const { connector, tools } = await test(ops, c.id);
    expect(connector.status).toBe('ok');
    expect(connector.lastError).toBeNull();
    expect(connector.toolCount).toBe(3);
    expect(tools.map((x) => x.name)).toEqual(['echo', 'grow', 'whoami']);
    expect(tools[0]).toMatchObject({ title: 'Echo', annotations: { readOnlyHint: true } });

    const res = await call(ops, 'GET', `/connectors/${c.id}/tools`);
    expect(((await res.json()) as { items: Tool[] }).items).toHaveLength(3);

    const [row] = await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id));
    expect(row!.config).toMatchObject({
      discovered: {
        server: { name: 'openbots-test-stdio' },
        resources: [{ uri: 'test://readme' }],
        prompts: [{ name: 'greet' }],
      },
    });
    // The secrets column is the sealed envelope, not readable JSON.
    expect(Buffer.from(row!.secrets!).toString('utf8')).not.toContain(SECRETS.stdio);
  });

  it('records a failing server in status and last_error', async () => {
    const c = await create(ops, {
      name: 'Broken',
      transport: 'stdio',
      command: '/nonexistent/mcp-server',
      args: ['--port', '1'],
      secrets: { TEST_SECRET: SECRETS.stdio },
    });
    const { connector } = await test(ops, c.id);
    expect(connector.status).toBe('error');
    expect(connector.lastError).toBeTruthy();
  });

  it('seals a custom server env and returns only its names, which reach the child (S-9)', async () => {
    const c = await create(ops, {
      name: 'Env stdio',
      slug: 'env-stdio',
      transport: 'stdio',
      command: process.execPath,
      args: [TEST_STDIO_SERVER],
      env: { TEST_SECRET: SECRETS.env },
    });
    expect(c.env).toEqual(['TEST_SECRET']);
    expect(c.secrets).toEqual([{ name: 'TEST_SECRET', label: null, required: false, set: true }]);
    const [row] = await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id));
    expect(JSON.stringify(row!.config)).not.toContain(SECRETS.env);
    expect(row!.config).toMatchObject({ env: {} });
    expect(Buffer.from(row!.secrets!).toString('utf8')).not.toContain(SECRETS.env);

    // Round trip: the sealed value is what the server process sees.
    expect((await test(ops, c.id)).connector.status).toBe('ok');
    const botId = await newBot(ops, 'Env reader');
    const who = await t.inOrganization(() =>
      callToolForBot(t.ownerDeps, botId, 'env-stdio', 'whoami', {}),
    );
    const text = (who.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ secret: SECRETS.env });

    // A PATCH sets variables without returning them; the others stay.
    const res = await call(ops, 'PATCH', `/connectors/${c.id}`, { env: { OTHER: SECRETS.env } });
    expect(((await res.json()) as Connector).env).toEqual(['TEST_SECRET', 'OTHER']);
  });

  // The test servers listen on 127.0.0.1, which the outbound guard refuses (S-8).
  const allowLocal = () => {
    beforeAll(() => {
      t.deps.net = { allowPrivateNetwork: true };
    });
    afterAll(() => {
      delete t.deps.net;
    });
  };

  describe('Streamable HTTP with a bearer token', () => {
    let server: TestHttpServer;
    allowLocal();
    beforeAll(async () => {
      server = await startTestHttpServer({
        authorize: (a) => a === `Bearer ${SECRETS.bearer}` || a === `Bearer ${SECRETS.header}`,
      });
    });

    it('seals header values and returns only their names (S-9)', async () => {
      const c = await create(member, {
        name: 'Header server',
        url: server.url,
        headers: { Authorization: `Bearer ${SECRETS.header}` },
      });
      expect(c.headers).toEqual(['Authorization']);
      expect(c.secrets).toEqual([
        { name: 'HEADER_AUTHORIZATION', label: null, required: false, set: true },
      ]);
      const [row] = await t.db
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.id, c.id));
      expect(JSON.stringify(row!.config)).not.toContain(SECRETS.header);
      expect((await test(member, c.id)).connector.status).toBe('ok');
    });
    afterAll(() => server.close());

    it("lists a new connector's tools for a run without anyone pressing Test (plan 8)", async () => {
      const c = await create(member, {
        name: 'Untested',
        url: server.url,
        auth: 'bearer',
        secrets: { BEARER_TOKEN: SECRETS.wrongBearer },
      });
      expect(c.status).toBe('untested');
      const botId = await newBot(member, 'Discoverer');
      const names = async () =>
        (await t.inOrganization(() => connectorToolsFor(t.ownerDeps, botId))).entries
          .filter((e) => e.connectorId === c.id)
          .map((e) => e.tool);
      // A refused start is recorded, and the run goes on without the connector.
      expect(await names()).toEqual([]);
      const status = async () =>
        (await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id)))[0]!
          .status;
      expect(await status()).toMatch(/needs_auth|error/);

      // Fixing the token makes it untested again, and the next run lists its tools.
      const res = await call(member, 'PATCH', `/connectors/${c.id}`, {
        secrets: { BEARER_TOKEN: SECRETS.bearer },
      });
      expect(((await res.json()) as Connector).status).toBe('untested');
      expect(await names()).toEqual(['add', 'delete_everything']);
      expect(await status()).toBe('ok');
      expect((await call(member, 'DELETE', `/connectors/${c.id}`)).status).toBe(204);
    });

    it('stops a session in every process when its connector is blocked or deleted (T3)', async () => {
      // A worker: its own manager (one per process, keyed by its config) on the same bus.
      const worker = { ...t.ownerDeps, config: { ...t.deps.config } };
      const started = async (name: string) => {
        const c = await create(member, {
          name,
          url: server.url,
          auth: 'bearer',
          secrets: { BEARER_TOKEN: SECRETS.bearer },
        });
        await mcpManager(worker).test(c.id);
        expect(mcpManager(worker).running(c.id)).toBe(true);
        return c;
      };
      const stopped = (id: string) =>
        vi.waitFor(() => expect(mcpManager(worker).running(id)).toBe(false), { timeout: 2_000 });
      try {
        const doomed = await started('Doomed');
        expect((await call(member, 'DELETE', `/connectors/${doomed.id}`)).status).toBe(204);
        await stopped(doomed.id);

        const blocked = await started('Blocked');
        const policy = (urlPatterns: string[]) =>
          call(admin, 'PUT', '/connector-policy', { catalogIds: [], urlPatterns });
        expect((await policy([new URL(server.url).host])).status).toBe(200);
        try {
          await stopped(blocked.id);
        } finally {
          await policy([]);
        }
        expect((await call(member, 'DELETE', `/connectors/${blocked.id}`)).status).toBe(204);
      } finally {
        await closeMcpManager(worker);
      }
    });

    it('connects with the stored token and reports a refused token without echoing it', async () => {
      const ok = await create(member, {
        name: 'Remote',
        url: server.url,
        auth: 'bearer',
        secrets: { BEARER_TOKEN: SECRETS.bearer },
      });
      expect(ok).toMatchObject({ transport: 'http', auth: 'bearer', url: server.url });
      const tested = await test(member, ok.id);
      expect(tested.connector.status).toBe('ok');
      expect(tested.tools.map((x) => x.name)).toEqual(['add', 'delete_everything']);

      const bad = await create(member, {
        name: 'Remote wrong',
        url: server.url,
        auth: 'bearer',
        secrets: { BEARER_TOKEN: SECRETS.wrongBearer },
      });
      const failed = await test(member, bad.id);
      expect(failed.connector.status).toMatch(/needs_auth|error/);

      const missing = await create(member, { name: 'No token', url: server.url, auth: 'bearer' });
      expect((await test(member, missing.id)).connector.status).toBe('needs_auth');
    });
  });

  describe('HTTP servers on the admin network (S-8)', () => {
    let as: MockAuthServer;
    let server: TestHttpServer;
    beforeAll(async () => {
      as = await startMockAuthServer();
      server = await startTestHttpServer({
        authorize: (a) => a === `Bearer ${SECRETS.bearer}` || as.validates(a),
        authorizationServer: as.url,
      });
    });
    afterAll(async () => {
      await server.close();
      await as.close();
    });

    const setLocal = (cookie: string, id: string, local: boolean) =>
      call(cookie, 'PUT', `/connectors/${id}/local`, { local });

    it('reaches a server on 127.0.0.1 only once an admin marks the connector local', async () => {
      const c = await create(ops, {
        name: 'Home server',
        url: server.url,
        auth: 'bearer',
        secrets: { BEARER_TOKEN: SECRETS.bearer },
      });
      expect(c.local).toBe(false);
      let tested = await test(ops, c.id);
      expect(tested.connector.status).toBe('error');
      expect(tested.connector.lastError).toContain('private or local network');

      // Not a member, even on their own connector; and an admin marks only
      // their own, since admins do not act on members' connectors (U2, plan 21.6).
      const theirs = await create(member, { name: 'Their server', url: server.url });
      let res = await setLocal(member, theirs.id, true);
      expect(res.status).toBe(403);
      expect((await setLocal(admin, theirs.id, true)).status).toBe(404);
      // Not through create or edit either.
      res = await call(ops, 'PATCH', `/connectors/${c.id}`, { local: true });
      expect(res.status).toBe(400);
      res = await call(ops, 'POST', '/connectors', {
        name: 'Sneaky',
        url: server.url,
        local: true,
      });
      expect(res.status).toBe(400);
      expect(
        (
          (await (await call(ops, 'GET', '/connectors')).json()) as { items: Connector[] }
        ).items.find((i) => i.id === c.id)?.local,
      ).toBe(false);

      res = await setLocal(ops, c.id, true);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Connector).local).toBe(true);
      tested = await test(ops, c.id);
      expect(tested.connector.status).toBe('ok');
      expect(tested.tools.map((x) => x.name)).toEqual(['add', 'delete_everything']);
      const [entry] = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'connector.local'));
      expect(entry).toMatchObject({
        actorId: await userId('ops@example.com'),
        targetId: c.id,
        metadata: { local: true },
      });

      // The mark was for that server: a new name keeps it, a new URL clears it.
      res = await call(ops, 'PATCH', `/connectors/${c.id}`, { name: 'My home server' });
      expect(((await res.json()) as Connector).local).toBe(true);
      res = await call(ops, 'PATCH', `/connectors/${c.id}`, {
        url: server.url.replace('127.0.0.1', 'localhost'),
      });
      expect(((await res.json()) as Connector).local).toBe(false);
      tested = await test(ops, c.id);
      expect(tested.connector.lastError).toContain('private or local network');

      // Only HTTP connectors reach the network.
      const stdio = await stdioConnector(ops, 'local-stdio');
      res = await setLocal(ops, stdio.id, true);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('NOT_HTTP');
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await setLocal(ops, missing, true)).status).toBe(404);
    });

    it("lets a local connector's OAuth requests reach a private sign-in server", async () => {
      const c = await create(ops, { name: 'Home sign-in', url: server.url, auth: 'oauth' });
      let res = await call(ops, 'GET', `/connectors/${c.id}/oauth/start`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('private or local network');

      expect((await setLocal(ops, c.id, true)).status).toBe(200);
      res = await call(ops, 'GET', `/connectors/${c.id}/oauth/start`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
      const redirect = await as.consent(authorizationUrl);
      const done = await call(ops, 'GET', `${redirect.pathname}${redirect.search}`);
      expect(new URL(done.headers.get('location')!).searchParams.get('oauth')).toBe('connected');
      expect((await test(ops, c.id)).connector.status).toBe('ok');
    });

    it('still connects a local connector to the address its lookup answered', async () => {
      // rebind.example resolves only through the guard's lookup, so every connection the
      // session makes went through it, and connected to the address it answered.
      const answers: string[] = [];
      t.deps.net = {
        resolve: async (host) => {
          answers.push(host);
          return [{ address: '127.0.0.1', family: 4 }];
        },
      };
      try {
        const c = await create(ops, {
          name: 'Rebinding',
          url: server.url.replace('127.0.0.1', 'rebind.example'),
          auth: 'bearer',
          secrets: { BEARER_TOKEN: SECRETS.bearer },
        });
        expect((await setLocal(ops, c.id, true)).status).toBe(200);
        expect((await test(ops, c.id)).connector.status).toBe('ok');
        expect(answers.length).toBeGreaterThan(0);
        expect(new Set(answers)).toEqual(new Set(['rebind.example']));
      } finally {
        delete t.deps.net;
      }
    });
  });

  describe('OAuth 2.1', () => {
    let as: MockAuthServer;
    let server: TestHttpServer;
    allowLocal();
    beforeAll(async () => {
      as = await startMockAuthServer();
      server = await startTestHttpServer({
        authorize: (a) => as.validates(a),
        authorizationServer: as.url,
      });
    });
    afterAll(async () => {
      await server.close();
      await as.close();
    });

    it('signs in through start and callback, then connects with the token', async () => {
      const c = await create(member, { name: 'OAuth server', url: server.url, auth: 'oauth' });
      expect((await test(member, c.id)).connector.status).toBe('needs_auth');

      const res = await call(member, 'GET', `/connectors/${c.id}/oauth/start`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
      expect(as.registrations).toBe(1);
      expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
        `${ORIGIN}/api/v1/connectors/oauth/callback`,
      );

      const redirect = await as.consent(authorizationUrl);
      expect(redirect.pathname).toBe('/api/v1/connectors/oauth/callback');
      const callbackPath = `${redirect.pathname}${redirect.search}`;

      // Someone else's session cannot complete it.
      const other = await call(admin, 'GET', callbackPath);
      expect(other.status).toBe(403);
      expect(await other.text()).toContain('another account');

      const done = await call(member, 'GET', callbackPath);
      expect(done.status).toBe(302);
      expect(done.headers.get('location')).toBe(
        `${ORIGIN}/connectors?connector=${c.id}&oauth=connected`,
      );

      // Single use: replaying the redirect fails, with a page and no redirect.
      const replay = await call(member, 'GET', callbackPath);
      expect(replay.status).toBe(400);
      expect(replay.headers.get('content-type')).toContain('text/html');
      expect(await replay.text()).toContain('not valid');

      const listed = (await (await call(member, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      const after = listed.items.find((x) => x.id === c.id)!;
      expect(after.oauth).toMatchObject({ clientConfigured: true, connected: true });
      expect(after.oauth!.expiresAt).not.toBeNull();

      const tested = await test(member, c.id);
      expect(tested.connector.status).toBe('ok');
      expect(tested.tools).toHaveLength(2);
    });

    it('rejects a forged state and asks for a client id when registration is unavailable', async () => {
      const c = await create(member, { name: 'OAuth again', url: server.url, auth: 'oauth' });
      await call(member, 'GET', `/connectors/${c.id}/oauth/start`);
      const forged = await call(
        member,
        'GET',
        `/api/v1/connectors/oauth/callback?code=x&state=${c.id}.forged`,
      );
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain('This sign-in link is not valid.');
      const junk = await call(member, 'GET', '/api/v1/connectors/oauth/callback?code=x&state=junk');
      expect(junk.status).toBe(400);
      expect(junk.headers.get('location')).toBeNull();

      const noDcr = await startMockAuthServer({ dynamicRegistration: false });
      const noDcrServer = await startTestHttpServer({
        authorize: (a) => noDcr.validates(a),
        authorizationServer: noDcr.url,
      });
      try {
        const d = await create(member, { name: 'No DCR', url: noDcrServer.url, auth: 'oauth' });
        let res = await call(member, 'GET', `/connectors/${d.id}/oauth/start`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('OAUTH_CLIENT_REQUIRED');
        const patched = await call(member, 'PATCH', `/connectors/${d.id}`, {
          oauthClient: { clientId: 'my-app', clientSecret: SECRETS.clientSecret },
        });
        expect(((await patched.json()) as Connector).oauth).toMatchObject({
          clientConfigured: true,
        });
        res = await call(member, 'GET', `/connectors/${d.id}/oauth/start`);
        expect(res.status).toBe(200);
        const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
        expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('my-app');
      } finally {
        await noDcrServer.close();
        await noDcr.close();
      }
    });

    it('keeps MCP sessions, OAuth discovery and token requests off private networks (S-8)', async () => {
      const exemption = t.deps.net;
      const signIn = await create(member, {
        name: 'Guarded sign-in',
        url: server.url,
        auth: 'oauth',
      });
      // Started while the exemption holds, so only the token request meets the guard.
      const started = await call(member, 'GET', `/connectors/${signIn.id}/oauth/start`);
      expect(started.status).toBe(200);
      const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
      const redirect = await as.consent(authorizationUrl);
      delete t.deps.net;
      try {
        const bearer = await create(member, {
          name: 'Guarded bearer',
          url: server.url,
          auth: 'bearer',
          secrets: { BEARER_TOKEN: SECRETS.bearer },
        });
        const tested = await test(member, bearer.id);
        expect(tested.connector.status).toBe('error');
        expect(tested.connector.lastError).toContain('private or local network');

        const discovery = await create(member, {
          name: 'Guarded discovery',
          url: server.url,
          auth: 'oauth',
        });
        const res = await call(member, 'GET', `/connectors/${discovery.id}/oauth/start`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          code: 'OAUTH_DISCOVERY_FAILED',
          title: expect.stringContaining('private or local network'),
        });

        const done = await call(member, 'GET', `${redirect.pathname}${redirect.search}`);
        const location = new URL(done.headers.get('location')!);
        expect(location.searchParams.get('oauth')).toBe('error');
        expect(location.searchParams.get('message')).toContain('private or local network');
        const listed = (await (await call(member, 'GET', '/connectors')).json()) as {
          items: Connector[];
        };
        expect(listed.items.find((x) => x.id === signIn.id)!.oauth).toMatchObject({
          connected: false,
        });
      } finally {
        t.deps.net = exemption;
      }
    });
  });

  describe('one-click sign-in pages', () => {
    let as: MockAuthServer;
    let server: TestHttpServer;
    allowLocal();
    beforeAll(async () => {
      as = await startMockAuthServer();
      server = await startTestHttpServer({
        authorize: (a) => as.validates(a),
        authorizationServer: as.url,
      });
    });
    afterAll(async () => {
      await server.close();
      await as.close();
    });

    const begin = async (name: string, mode: string) => {
      const c = await create(member, { name, url: server.url, auth: 'oauth' });
      const res = await call(member, 'GET', `/connectors/${c.id}/oauth/start?mode=${mode}`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
      const redirect = await as.consent(authorizationUrl);
      return { c, path: `${redirect.pathname}${redirect.search}` };
    };

    const events = async () => {
      const seen: { type: string; user_id?: string; payload: Record<string, unknown> }[] = [];
      const off = await t.deps.infra.bus.subscribe<(typeof seen)[number]>(EVENTS_CHANNEL, (e) =>
        seen.push(e),
      );
      return { seen, off };
    };

    const signInFirst = async (res: Response) => {
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('Sign in to OpenBots in this browser, then try again.');
    };

    it('finishes a popup sign-in for the session that started it, telling the opener and the owner', async () => {
      const { c, path } = await begin('Popup <b>&</b> "Co"', 'popup');
      // The popup's browser has the session; without one it is refused and stays pending.
      await signInFirst(await call(undefined, 'GET', path));
      const { seen, off } = await events();
      const res = await call(member, 'GET', path);
      await off();
      expect(res.status).toBe(200);
      const page = await res.text();
      // The provider's name is escaped.
      expect(page).toContain('Popup &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot; is connected');
      expect(page).not.toContain('<b>&</b>');
      expect(page).toContain('You can close this window.');
      // Only the status and the connector go to the opener, at our own origin.
      expect(page).toContain(
        `postMessage({"type":"openbots:oauth","status":"connected","connectorId":"${c.id}"}, "${ORIGIN}")`,
      );
      expect(page).toContain('window.close()');
      expect(page).not.toMatch(/at_|rt_|code_verifier/);

      const csp = res.headers.get('content-security-policy')!;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(page).toContain(`<script nonce="${nonce}">`);
      expect(page.match(/<script/g)).toHaveLength(1);
      expect(page).not.toMatch(/<script[^>]+src=|<link|<img/);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toContain('text/html');

      expect(seen).toContainEqual(
        expect.objectContaining({
          type: 'connector.updated',
          user_id: await userId('member@example.com'),
          payload: { connectorId: c.id, oauth: 'connected' },
        }),
      );
      const listed = (await (await call(member, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      expect(listed.items.find((x) => x.id === c.id)!.oauth).toMatchObject({ connected: true });
    });

    it('stays as a confirmation in the default browser, with a way back to the app', async () => {
      const { path } = await begin('Browser sign-in', 'external');
      // Managed: the default browser must be signed in too, until the app hands off the flow.
      await signInFirst(await call(undefined, 'GET', path));
      const res = await call(member, 'GET', path);
      const page = await res.text();
      expect(res.status).toBe(200);
      expect(page).toContain('Browser sign-in is connected');
      expect(page).toContain('href="openbots://connectors"');
      expect(page).toContain('Return to OpenBots');
      // Nothing to tell and nothing to close.
      expect(page).not.toContain('<script');
    });

    it('says why it failed, and tells the opener without closing', async () => {
      const c = await create(member, { name: 'Refused', url: server.url, auth: 'oauth' });
      const started = await call(member, 'GET', `/connectors/${c.id}/oauth/start?mode=popup`);
      const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const { seen, off } = await events();
      const res = await call(
        member,
        'GET',
        `/api/v1/connectors/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=${encodeURIComponent('You said <no>')}`,
      );
      await off();
      expect(res.status).toBe(400);
      const page = await res.text();
      expect(page).toContain('Refused did not connect');
      expect(page).toContain('You said &lt;no&gt;');
      expect(page).toContain('You can close this window and try again.');
      expect(page).toContain('"status":"error"');
      expect(page).not.toContain('window.close()');
      expect(seen).toContainEqual(
        expect.objectContaining({
          type: 'connector.updated',
          payload: { connectorId: c.id, oauth: 'error', error: 'You said <no>' },
        }),
      );
    });

    it('refuses an expired sign-in after 10 minutes', async () => {
      const { path } = await begin('Slow sign-in', 'popup');
      const now = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 1_000);
      let res;
      try {
        res = await call(undefined, 'GET', path);
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(400);
      const page = await res.text();
      expect(page).toContain('Slow sign-in did not connect');
      expect(page).toContain('This sign-in took too long. Start again.');
    });

    it('keeps the redirect for a sign-in in the same tab', async () => {
      const { c, path } = await begin('Same tab', 'redirect');
      // Without the session it shows the page instead of redirecting.
      await signInFirst(await call(undefined, 'GET', path));
      const res = await call(member, 'GET', path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${ORIGIN}/connectors?connector=${c.id}&oauth=connected`,
      );
    });

    it('checks a pasted URL: OAuth with or without registration, a token, or nothing', async () => {
      const check = async (url: string) => {
        const res = await call(member, 'POST', '/connectors/discover', { url });
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as Record<string, unknown>;
      };
      expect(await check(server.url)).toEqual({
        auth: 'oauth',
        dynamicRegistration: true,
        reachable: true,
        message: null,
        oauthCallbackUrl: `${ORIGIN}/api/v1/connectors/oauth/callback`,
      });
      const noDcr = await startMockAuthServer({ dynamicRegistration: false });
      const noDcrServer = await startTestHttpServer({
        authorize: (a) => noDcr.validates(a),
        authorizationServer: noDcr.url,
      });
      const open = await startTestHttpServer();
      const token = await startTestHttpServer({ authorize: (a) => a === 'Bearer x' });
      try {
        expect(await check(noDcrServer.url)).toMatchObject({
          auth: 'oauth',
          dynamicRegistration: false,
        });
        expect(await check(open.url)).toMatchObject({ auth: 'none', reachable: true });
        expect(await check(token.url)).toMatchObject({ auth: 'bearer', reachable: true });
      } finally {
        await Promise.all([noDcrServer.close(), noDcr.close(), open.close(), token.close()]);
      }
      // Off the private network, the probe is refused and the URL is added as is.
      const exemption = t.deps.net;
      delete t.deps.net;
      try {
        expect(await check(server.url)).toMatchObject({
          auth: 'none',
          reachable: false,
          message: expect.stringContaining('private or local network'),
        });
      } finally {
        t.deps.net = exemption;
      }
      expect(
        (await call(undefined, 'POST', '/connectors/discover', { url: server.url })).status,
      ).toBe(401);
    });
  });

  it('imports pasted mcpServers JSON, sealing env values and headers', async () => {
    const res = await call(ops, 'POST', '/connectors/import', {
      mcpServers: {
        'Imported Local': {
          command: process.execPath,
          args: [TEST_STDIO_SERVER],
          env: { TEST_SECRET: SECRETS.imported },
        },
        'imported remote': {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer ${SECRETS.importedHeader}` },
        },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(res.status).toBe(200);
    const { items, errors } = (await res.json()) as {
      items: Connector[];
      errors: { name: string }[];
    };
    expect(items.map((c) => [c.slug, c.transport])).toEqual([
      ['imported-local', 'stdio'],
      ['imported-remote', 'http'],
    ]);
    expect(items[0]!.secrets).toEqual([
      { name: 'TEST_SECRET', label: null, required: false, set: true },
    ]);
    expect(items[1]).toMatchObject({ auth: 'bearer' });
    expect(errors.map((e) => e.name)).toEqual(['legacy']);

    const bad = await call(ops, 'POST', '/connectors/import', { servers: {} });
    expect(bad.status).toBe(400);
  });

  it('edits secrets without ever returning them and keeps catalog commands pinned', async () => {
    const pg = (await (await call(member, 'GET', '/connectors')).json()) as { items: Connector[] };
    const target = pg.items.find((c) => c.catalogId === 'postgres')!;
    let res = await call(member, 'PATCH', `/connectors/${target.id}`, { args: ['--evil'] });
    expect(((await res.json()) as { code: string }).code).toBe('PINNED');
    // A secret reaches a stdio server as env, so only declared ones are taken.
    res = await call(member, 'PATCH', `/connectors/${target.id}`, {
      name: 'Prod DB',
      secrets: { NODE_OPTIONS: '--require /tmp/evil.js' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('UNDECLARED_ENV');
    res = await call(member, 'PATCH', `/connectors/${target.id}`, { name: 'Prod DB' });
    const updated = (await res.json()) as Connector;
    expect(updated.name).toBe('Prod DB');
    expect(updated.secrets.map((s) => [s.name, s.set])).toEqual([['POSTGRES_URL', true]]);
    res = await call(member, 'PATCH', `/connectors/${target.id}`, {
      secrets: { POSTGRES_URL: null },
    });
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_SECRET');
    res = await call(member, 'PATCH', `/connectors/${target.id}`, {
      secrets: { POSTGRES_URL: SECRETS.privatePostgres },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PRIVATE_HOST');
  });

  describe('confined catalog servers (S-3)', () => {
    const rowOf = async (id: string) =>
      (await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, id)))[0]!;

    it('roots the filesystem server in a folder of the owner directory', async () => {
      for (const root of ['/etc', '../ops', 'a/../../b']) {
        const res = await call(member, 'POST', '/connectors', {
          catalogId: 'filesystem',
          params: { root },
        });
        expect(res.status, root).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_PATH');
      }
      const c = await create(member, {
        catalogId: 'filesystem',
        params: { root: 'projects/site' },
      });
      const spec = await stdioSpawnFor(t.ownerDeps, await rowOf(c.id));
      const base = userDirectory(t.deps.config, {
        id: await userId('member@example.com'),
        workspaceId: await t.defaultOrganization(),
      });
      expect(spec.command).toBe(join(mcpDir, 'node_modules', '.bin', 'mcp-server-filesystem'));
      expect(spec.args).toHaveLength(1);
      expect(spec.args.at(-1)).toBe(join(realpathSync(base), 'projects', 'site'));
      expect(existsSync(spec.args.at(-1)!)).toBe(true);

      // Rows from before, or a symlink out of the directory, do not start.
      await t.db
        .update(schema.connectors)
        .set({ config: { ...((await rowOf(c.id)).config as object), params: { root: '/etc' } } })
        .where(eq(schema.connectors.id, c.id));
      await expect(stdioSpawnFor(t.ownerDeps, await rowOf(c.id))).rejects.toThrow(
        /inside your own/,
      );
      mkdirSync(base, { recursive: true });
      symlinkSync(tmpdir(), join(base, 'escape'));
      await t.db
        .update(schema.connectors)
        .set({ config: { ...((await rowOf(c.id)).config as object), params: { root: 'escape' } } })
        .where(eq(schema.connectors.id, c.id));
      await expect(stdioSpawnFor(t.ownerDeps, await rowOf(c.id))).rejects.toThrow(
        /inside your own/,
      );
    });

    it('refuses private and internal Postgres hosts and keeps the password out of argv (S-9)', async () => {
      for (const url of [
        SECRETS.privatePostgres,
        'postgresql://ro:sekrit-pg-private@10.1.2.3/app',
        'postgresql://ro:sekrit-pg-private@[::1]/app',
        'postgresql://ro:sekrit-pg-private@postgres.invalid/app',
        'postgresql://ro:sekrit-pg-private@203.0.113.7/app?host=127.0.0.1',
      ]) {
        const res = await call(member, 'POST', '/connectors', {
          catalogId: 'postgres',
          secrets: { POSTGRES_URL: url },
        });
        expect(res.status, url).toBe(400);
      }
      const c = await create(member, {
        catalogId: 'postgres',
        slug: 'pg-public',
        secrets: { POSTGRES_URL: SECRETS.postgres },
      });
      const spec = await stdioSpawnFor(t.ownerDeps, await rowOf(c.id));
      expect(spec.command).toBe(join(mcpDir, 'node_modules', '.bin', 'mcp-server-postgres'));
      expect(spec.args.join(' ')).not.toContain('sekrit-pg-pass');
      expect(spec.args).toEqual(['postgresql://ro@203.0.113.7:5432/app']);
      expect(spec.env).toMatchObject({
        PGPASSWORD: 'sekrit-pg-pass',
        POSTGRES_URL: SECRETS.postgres,
      });
    });

    it('runs the pre-installed server, and npx only when the dev fallback allows it (S-20)', async () => {
      const c = await create(member, { catalogId: 'filesystem', slug: 'fs-install' });
      const row = await rowOf(c.id);
      const missing = { dir: join(mcpDir, 'missing'), allowNpx: false };
      await expect(
        stdioSpawnFor({ config: { ...t.deps.config, mcpCatalog: missing } }, row),
      ).rejects.toThrow(/Filesystem is not installed: .*mcp-server-filesystem is missing/);
      const dev = await stdioSpawnFor(
        { config: { ...t.deps.config, mcpCatalog: { ...missing, allowNpx: true } } },
        row,
      );
      expect(dev.command).toBe('npx');
      expect(dev.args.slice(0, 2)).toEqual([
        '-y',
        '@modelcontextprotocol/server-filesystem@2026.8.31',
      ]);
    });

    it('gives a catalog stdio server only the env its entry declares', async () => {
      // A custom server the catalog matches runs the pinned package: no NODE_OPTIONS on top.
      const matched = {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres@0.6.2', 'postgresql://x'],
      };
      let res = await call(member, 'POST', '/connectors', {
        ...matched,
        env: { NODE_OPTIONS: '--require /tmp/evil.js' },
        secrets: { POSTGRES_URL: SECRETS.postgres },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'UNDECLARED_ENV',
        title: expect.stringContaining('NODE_OPTIONS'),
      });
      res = await call(member, 'POST', '/connectors/import', {
        mcpServers: {
          pg: { ...matched, env: { POSTGRES_URL: SECRETS.postgres, NODE_OPTIONS: '-r x' } },
        },
      });
      expect(await res.json()).toMatchObject({
        items: [],
        errors: [{ name: 'pg', message: expect.stringContaining('NODE_OPTIONS') }],
      });
      const c = await create(member, {
        ...matched,
        slug: 'pg-matched',
        secrets: { POSTGRES_URL: SECRETS.postgres },
      });
      expect(c.catalogId).toBe('postgres');

      // A row stored before the check keeps its extra value, which never reaches the child.
      const keyring = keyringFromConfig(t.deps.config);
      await t.db
        .update(schema.connectors)
        .set({
          secrets: encryptSecret(
            JSON.stringify({ values: { POSTGRES_URL: SECRETS.postgres, NODE_OPTIONS: '-r x' } }),
            keyring,
          ),
        })
        .where(eq(schema.connectors.id, c.id));
      const spec = await stdioSpawnFor(t.ownerDeps, await rowOf(c.id));
      expect(Object.keys(spec.env).sort()).toEqual(['PGPASSWORD', 'POSTGRES_URL']);
    });
  });

  it('seals env and header values stored before S-9 (data migration)', async () => {
    const owner = await userId('ops@example.com');
    const workspace = await ensureWorkspace(t.db);
    const keyring = keyringFromConfig(t.deps.config);
    const [stdio, http] = await t.db
      .insert(schema.connectors)
      .values([
        {
          workspaceId: workspace.id,
          ownerId: owner,
          name: 'Legacy stdio',
          slug: 'legacy-stdio',
          kind: 'mcp_stdio',
          config: {
            transport: 'stdio',
            command: process.execPath,
            args: [TEST_STDIO_SERVER],
            env: { LEGACY: SECRETS.legacyEnv, TEST_SECRET: 'overridden' },
          },
          secrets: encryptSecret(
            JSON.stringify({ values: { TEST_SECRET: SECRETS.stdio } }),
            keyring,
          ),
          status: 'untested',
        },
        {
          workspaceId: workspace.id,
          ownerId: owner,
          name: 'Legacy http',
          slug: 'legacy-http',
          kind: 'mcp_http',
          config: {
            transport: 'http',
            url: 'https://mcp.example.com/mcp',
            auth: 'none',
            headers: { 'X-Api-Key': SECRETS.legacyHeader },
          },
          status: 'untested',
        },
      ])
      .returning();
    expect(await sealPlaintextConnectorValues(t.ownerDeps)).toBe(2);
    expect(await sealPlaintextConnectorValues(t.ownerDeps)).toBe(0);

    const rows = await t.db.select().from(schema.connectors);
    const after = (id: string) => rows.find((r) => r.id === id)!;
    for (const id of [stdio!.id, http!.id]) {
      expect(JSON.stringify(after(id).config)).not.toMatch(/sekrit/);
    }
    // A secret stored under the same name keeps winning, as it did at start.
    expect(openSecrets(t.ownerDeps, after(stdio!.id)).values).toEqual({
      LEGACY: SECRETS.legacyEnv,
      TEST_SECRET: SECRETS.stdio,
    });
    expect(openSecrets(t.ownerDeps, after(http!.id)).values).toEqual({
      HEADER_X_API_KEY: SECRETS.legacyHeader,
    });
    expect(after(http!.id).config).toMatchObject({
      headers: {},
      secretHeaders: { 'X-Api-Key': 'HEADER_X_API_KEY' },
    });

    const listed = (await (await call(ops, 'GET', '/connectors')).json()) as { items: Connector[] };
    expect(listed.items.find((c) => c.id === stdio!.id)!.env).toEqual(['LEGACY', 'TEST_SECRET']);
    expect(listed.items.find((c) => c.id === http!.id)!.headers).toEqual(['X-Api-Key']);
    await call(ops, 'DELETE', `/connectors/${stdio!.id}`);
    await call(ops, 'DELETE', `/connectors/${http!.id}`);
  });

  it('keeps connectors private to their owner', async () => {
    const mine = (await (await call(member, 'GET', '/connectors')).json()) as {
      items: Connector[];
    };
    const id = mine.items[0]!.id;
    expect(
      ((await (await call(admin, 'GET', '/connectors')).json()) as { items: [] }).items,
    ).toEqual([]);
    expect((await call(admin, 'PATCH', `/connectors/${id}`, { name: 'x' })).status).toBe(404);
    expect((await call(admin, 'POST', `/connectors/${id}/test`)).status).toBe(404);
    expect((await call(admin, 'GET', `/connectors/${id}/tools`)).status).toBe(404);
    expect((await call(admin, 'DELETE', `/connectors/${id}`)).status).toBe(404);
    expect((await call(undefined, 'GET', '/connectors')).status).toBe(401);
  });

  describe('per-Bot permissions (T1)', () => {
    it('lists every connector for a Bot and filters tools by allow and deny lists', async () => {
      const c = await stdioConnector(admin, 'tools');
      await test(admin, c.id);
      const botId = await newBot(admin, 'Helper');

      let res = await call(admin, 'GET', `/bots/${botId}/connectors`);
      const listed = (await res.json()) as {
        items: { connector: Connector; permission: { toolAllowlist: null }; customized: boolean }[];
      };
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        customized: false,
        permission: {
          connectorId: c.id,
          toolAllowlist: null,
          toolDenylist: [],
          approvalOverride: null,
        },
      });

      const names = async () =>
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).map((x) => x.tool);
      expect(await names()).toEqual(['echo', 'grow', 'whoami']);
      const [first] = await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId));
      expect(first).toMatchObject({
        connectorSlug: 'tools',
        connectorName: 'Test stdio',
        tool: 'echo',
        title: 'Echo',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object' },
      });

      const put = (items: unknown[]) => call(admin, 'PUT', `/bots/${botId}/connectors`, { items });
      res = await put([
        {
          connectorId: c.id,
          toolAllowlist: null,
          toolDenylist: ['whoami'],
          approvalOverride: 'ask',
        },
      ]);
      expect(res.status).toBe(200);
      expect(await names()).toEqual(['echo', 'grow']);
      expect(
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId)))[0]!.approvalOverride,
      ).toBe('ask');

      await expect(
        t.inOrganization(() => callToolForBot(t.ownerDeps, botId, 'tools', 'whoami', {})),
      ).rejects.toMatchObject({
        code: 'TOOL_NOT_PERMITTED',
      });
      const checkedAt = async () =>
        (await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, c.id)))[0]!
          .lastCheckedAt;
      const started = await checkedAt();
      const echoed = await t.inOrganization(() =>
        callToolForBot(t.ownerDeps, botId, 'tools', 'echo', { text: 'via bot' }),
      );
      expect(echoed.content).toEqual([{ type: 'text', text: 'via bot' }]);
      // One session: storing what it discovered does not count as a config change.
      expect(await checkedAt()).toEqual(started);
      expect(mcpManager(t.ownerDeps).running(c.id)).toBe(true);

      await put([
        {
          connectorId: c.id,
          toolAllowlist: ['echo', 'whoami'],
          toolDenylist: ['whoami'],
          approvalOverride: null,
        },
      ]);
      expect(await names()).toEqual(['echo']);
      await put([
        { connectorId: c.id, toolAllowlist: [], toolDenylist: [], approvalOverride: null },
      ]);
      expect(await names()).toEqual([]);
      await put([]);
      expect(await names()).toEqual(['echo', 'grow', 'whoami']);

      // Another user's Bot and another user's connector are both 404.
      expect((await call(member, 'GET', `/bots/${botId}/connectors`)).status).toBe(404);
      const memberBot = await newBot(member, 'Mine');
      const foreign = await call(member, 'PUT', `/bots/${memberBot}/connectors`, {
        items: [
          { connectorId: c.id, toolAllowlist: null, toolDenylist: [], approvalOverride: null },
        ],
      });
      expect(foreign.status).toBe(404);
      // A Bot only sees its own owner's connectors.
      expect(
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, memberBot))).every(
          (x) => x.connectorSlug !== 'tools',
        ),
      ).toBe(true);
    });
  });

  describe('Bot tool defaults (T5)', () => {
    interface BotTool {
      name: string;
      group: string;
      connectorId: string | null;
      needsConnector: boolean;
      disabledByAdmin: boolean;
      decision: string;
      why: string;
      byArguments: boolean;
    }
    const toolsOf = async (cookie: string, botId: string) => {
      const res = await call(cookie, 'GET', `/bots/${botId}/tools`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { items } = (await res.json()) as { items: BotTool[] };
      return new Map(items.map((i) => [i.name, i]));
    };

    it("lists every tool group with the engine's own defaults", async () => {
      const botId = await newBot(member, 'Defaults');
      const tools = await toolsOf(member, botId);
      expect(tools.get('bash')).toMatchObject({
        group: 'computer',
        decision: 'ask',
        why: 'bash runs commands on the computer',
      });
      expect(tools.get('computer')).toMatchObject({ group: 'computer', decision: 'auto' });
      expect(tools.get('ask_user')).toMatchObject({ group: 'conversation', decision: 'auto' });
      expect(tools.get('propose_routine')).toMatchObject({ group: 'conversation' });
      expect(tools.get('create_artifact')).toMatchObject({ group: 'artifacts', decision: 'auto' });
      expect(tools.get('web_fetch')).toMatchObject({
        group: 'builtin',
        connectorId: null,
        needsConnector: false,
        disabledByAdmin: false,
      });
      expect(tools.get('http_request')).toMatchObject({ decision: 'ask', byArguments: true });
      expect(tools.get('send_email')).toMatchObject({
        decision: 'ask',
        needsConnector: true,
        connectorId: null,
      });
      // Another user's Bot is 404.
      expect((await call(admin, 'GET', `/bots/${botId}/tools`)).status).toBe(404);
    });

    it("asks for an untrusted connector's read-only tools, as a run would (S-16)", async () => {
      const c = await create(member, {
        name: 'Wiki',
        slug: 'wiki-defaults',
        url: 'https://mcp.wiki.example/mcp',
      });
      const [row] = await t.db
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.id, c.id));
      await t.db.insert(schema.connectorTools).values([
        {
          workspaceId: row!.workspaceId,
          connectorId: c.id,
          name: 'read_page',
          annotations: { readOnlyHint: true },
        },
        {
          workspaceId: row!.workspaceId,
          connectorId: c.id,
          name: 'wipe',
          annotations: { destructiveHint: true },
        },
      ]);
      const botId = await newBot(member, 'Reader');
      let tools = await toolsOf(member, botId);
      expect(tools.get('wiki-defaults__read_page')).toMatchObject({
        group: 'connector',
        connectorId: c.id,
        decision: 'ask',
      });
      expect(tools.get('wiki-defaults__wipe')).toMatchObject({
        decision: 'ask',
        why: 'wiki-defaults__wipe is marked destructive',
      });
      // As an admin's trust would; the trust API and its audit entry are covered below.
      await t.db
        .update(schema.connectors)
        .set({ trusted: true })
        .where(eq(schema.connectors.id, c.id));
      tools = await toolsOf(member, botId);
      expect(tools.get('wiki-defaults__read_page')!.decision).toBe('auto');

      // A built-in an admin blocks reads as disabled even without a connector row.
      const policy = (body: object) =>
        call(admin, 'PUT', '/connector-policy', { catalogIds: [], urlPatterns: [], ...body });
      expect((await policy({ catalogIds: ['web_fetch'] })).status).toBe(200);
      try {
        tools = await toolsOf(member, botId);
        expect(tools.get('web_fetch')!.disabledByAdmin).toBe(true);
        expect(tools.get('web_search')!.disabledByAdmin).toBe(false);
      } finally {
        await policy({ allowedCatalogIds: [] });
      }
    });
  });

  describe('admin block list (T3)', () => {
    it('blocks by catalog id and URL pattern for every member', async () => {
      expect(
        (await call(member, 'PUT', '/connector-policy', { catalogIds: [], urlPatterns: [] }))
          .status,
      ).toBe(403);
      expect(
        (await call(admin, 'PUT', '/connector-policy', { catalogIds: ['nope'], urlPatterns: [] }))
          .status,
      ).toBe(400);

      const botId = await newBot(ops, 'Blocked helper');
      const local = (await (await call(ops, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      const stdio = local.items.find((c) => c.slug === 'local')!;
      expect(
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).some(
          (x) => x.connectorSlug === 'local',
        ),
      ).toBe(true);

      let res = await call(admin, 'PUT', '/connector-policy', {
        catalogIds: ['postgres'],
        urlPatterns: ['*.slack.com', `*${TEST_STDIO_SERVER.split('/').at(-1)}*`],
      });
      expect(res.status).toBe(200);
      const policy = {
        catalogIds: ['postgres'],
        urlPatterns: ['*.slack.com', '*stdio-server.mjs*'],
        allowedCatalogIds: [],
      };
      expect(await res.json()).toEqual(policy);
      expect(await (await call(admin, 'GET', '/connector-policy')).json()).toEqual(policy);
      expect((await call(member, 'GET', '/connector-policy')).status).toBe(403);

      const catalog = (await (await call(member, 'GET', '/connectors/catalog')).json()) as {
        items: { id: string; disabledByAdmin: boolean }[];
      };
      expect(catalog.items.filter((i) => i.disabledByAdmin).map((i) => i.id)).toEqual([
        'slack',
        'postgres',
      ]);

      // Nor probed by URL before adding.
      res = await call(member, 'POST', '/connectors/discover', { url: 'https://x.slack.com/mcp' });
      expect(res.status).toBe(403);

      // Cannot be created, from the catalog or typed in.
      res = await call(member, 'POST', '/connectors', {
        catalogId: 'postgres',
        secrets: { POSTGRES_URL: SECRETS.postgres },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'CONNECTOR_BLOCKED',
        title: expect.stringContaining('blocked by the connector policy'),
      });
      res = await call(ops, 'POST', '/connectors', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', 'x'],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'CONNECTOR_BLOCKED' });
      res = await call(member, 'POST', '/connectors', { catalogId: 'slack' });
      expect(res.status).toBe(403);

      // Existing ones read as disabled, cannot start, and give Bots no tools.
      const after = (await (await call(member, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      const opsAfter = (await (await call(ops, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      expect(after.items.find((c) => c.catalogId === 'postgres')!.disabledByAdmin).toBe(true);
      expect(opsAfter.items.find((c) => c.id === stdio.id)!.disabledByAdmin).toBe(true);
      expect(after.items.find((c) => c.catalogId === 'filesystem')!.disabledByAdmin).toBe(false);
      expect((await call(ops, 'POST', `/connectors/${stdio.id}/test`)).status).toBe(403);
      expect(
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).some(
          (x) => x.connectorSlug === 'local',
        ),
      ).toBe(false);
      await expect(
        t.inOrganization(() => callToolForBot(t.ownerDeps, botId, 'local', 'echo', { text: 'x' })),
      ).rejects.toThrow();

      res = await call(admin, 'PUT', '/connector-policy', { catalogIds: [], urlPatterns: [] });
      expect(await res.json()).toEqual({ catalogIds: [], urlPatterns: [], allowedCatalogIds: [] });
      expect(
        (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).some(
          (x) => x.connectorSlug === 'local',
        ),
      ).toBe(true);
    });
  });

  describe('admin allow list (U3)', () => {
    it('lets only listed catalog entries be added or used once it has one', async () => {
      const put = (body: Record<string, unknown>) => call(admin, 'PUT', '/connector-policy', body);
      expect(
        (
          await call(member, 'PUT', '/connector-policy', {
            catalogIds: [],
            urlPatterns: [],
            allowedCatalogIds: ['github'],
          })
        ).status,
      ).toBe(403);
      let res = await put({ catalogIds: [], urlPatterns: [], allowedCatalogIds: ['nope'] });
      expect(res.status).toBe(400);
      res = await put({ catalogIds: ['github'], urlPatterns: [], allowedCatalogIds: ['github'] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('POLICY_CONFLICT');

      res = await put({
        catalogIds: ['slack'],
        urlPatterns: [],
        allowedCatalogIds: ['filesystem', 'web_search'],
      });
      expect(await res.json()).toEqual({
        catalogIds: ['slack'],
        urlPatterns: [],
        allowedCatalogIds: ['filesystem', 'web_search'],
      });
      // Leaving the allow list out of a PUT keeps it.
      res = await put({ catalogIds: [], urlPatterns: [] });
      expect(await res.json()).toEqual({
        catalogIds: [],
        urlPatterns: [],
        allowedCatalogIds: ['filesystem', 'web_search'],
      });
      expect(await (await call(admin, 'GET', '/connector-policy')).json()).toMatchObject({
        allowedCatalogIds: ['filesystem', 'web_search'],
      });

      const catalog = (await (await call(member, 'GET', '/connectors/catalog')).json()) as {
        items: { id: string; disabledByAdmin: boolean }[];
      };
      expect(catalog.items.filter((i) => !i.disabledByAdmin).map((i) => i.id)).toEqual([
        'filesystem',
        'web_search',
      ]);
      expect((await call(member, 'POST', '/connectors', { catalogId: 'web_search' })).status).toBe(
        201,
      );
      res = await call(member, 'POST', '/connectors', {
        catalogId: 'postgres',
        secrets: { POSTGRES_URL: SECRETS.postgres },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'CONNECTOR_BLOCKED' });
      // Custom servers are not on the list.
      res = await call(member, 'POST', '/connectors', { url: 'https://mcp.example.com/other' });
      expect(res.status).toBe(403);
      const listed = (await (await call(member, 'GET', '/connectors')).json()) as {
        items: Connector[];
      };
      expect(listed.items.find((c) => c.catalogId === 'postgres')!.disabledByAdmin).toBe(true);
      expect(listed.items.find((c) => c.catalogId === 'filesystem')!.disabledByAdmin).toBe(false);

      res = await put({ catalogIds: [], urlPatterns: [], allowedCatalogIds: [] });
      expect(await res.json()).toEqual({ catalogIds: [], urlPatterns: [], allowedCatalogIds: [] });
      expect(
        (await call(member, 'POST', '/connectors', { url: 'https://mcp.example.com/other' }))
          .status,
      ).toBe(201);
    });
  });

  it("lets only admins trust a connector's MCP hints (S-16)", async () => {
    const theirs = await create(member, {
      name: 'Their notes',
      slug: 'notes-theirs',
      url: 'https://mcp.notes.example/mcp',
    });
    // Not even the owner, unless an admin; and an admin vouches only for
    // their own, since admins do not act on members' connectors (U2, plan 21.6).
    let res = await call(member, 'PUT', `/connectors/${theirs.id}/trusted`, { trusted: true });
    expect(res.status).toBe(403);
    res = await call(admin, 'PUT', `/connectors/${theirs.id}/trusted`, { trusted: true });
    expect(res.status).toBe(404);
    const c = await create(admin, {
      name: 'Notes',
      slug: 'notes-trust',
      url: 'https://mcp.notes.example/mcp',
    });
    expect(c.trusted).toBe(false);
    res = await call(admin, 'PUT', `/connectors/${c.id}/trusted`, { trusted: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Connector).trusted).toBe(true);
    const list = (await (await call(admin, 'GET', '/connectors')).json()) as {
      items: Connector[];
    };
    expect(list.items.find((i) => i.id === c.id)?.trusted).toBe(true);
    const [entry] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'connector.trust'));
    expect(entry).toMatchObject({
      actorId: await userId('admin@example.com'),
      targetId: c.id,
      metadata: { trusted: true },
    });

    // Trust was for the server as it was: a new URL clears it, a new name does not.
    res = await call(admin, 'PATCH', `/connectors/${c.id}`, { name: 'My notes' });
    expect(((await res.json()) as Connector).trusted).toBe(true);
    res = await call(admin, 'PATCH', `/connectors/${c.id}`, {
      url: 'https://mcp.other.example/mcp',
    });
    expect(((await res.json()) as Connector).trusted).toBe(false);

    const missing = '00000000-0000-4000-8000-000000000000';
    res = await call(admin, 'PUT', `/connectors/${missing}/trusted`, { trusted: true });
    expect(res.status).toBe(404);
  });

  it('stops idle MCP sessions after OPENBOTS_MCP_IDLE_STOP_MINUTES (10 by default)', async () => {
    expect(mcpManager(t.ownerDeps).idleMs).toBe(10 * 60_000);
    const { config } = t.ownerDeps;
    const deps = {
      ...t.ownerDeps,
      config: { ...config, processLimits: { ...config.processLimits, mcpIdleStopMinutes: 3 } },
    };
    try {
      expect(mcpManager(deps).idleMs).toBe(3 * 60_000);
    } finally {
      await closeMcpManager(deps);
    }
  });

  it('deletes a connector with its tools', async () => {
    const c = await stdioConnector(ops, 'gone');
    await test(ops, c.id);
    expect((await call(ops, 'DELETE', `/connectors/${c.id}`)).status).toBe(204);
    const rows = await t.db.select().from(schema.connectorTools);
    expect(rows.some((r) => r.connectorId === c.id)).toBe(false);
  });

  it('stops custom stdio servers when an admin turns them off (S-1)', async () => {
    const c = await stdioConnector(ops, 'switched');
    expect((await test(ops, c.id)).connector.status).toBe('ok');
    const botId = await newBot(ops, 'Switched');
    expect(
      (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).some(
        (x) => x.connectorSlug === 'switched',
      ),
    ).toBe(true);
    expect(mcpManager(t.ownerDeps).running(c.id)).toBe(true);
    await call(admin, 'PATCH', '/settings', { customStdioEnabled: false });
    // The running child stops at once, not at the idle sweep.
    await vi.waitFor(() => expect(mcpManager(t.ownerDeps).running(c.id)).toBe(false));
    const listed = (await (await call(ops, 'GET', '/connectors')).json()) as { items: Connector[] };
    expect(listed.items.find((x) => x.id === c.id)!.disabledByAdmin).toBe(true);
    const res = await call(ops, 'POST', `/connectors/${c.id}/test`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CUSTOM_STDIO_DISABLED' });
    expect(
      (await t.inOrganization(() => listToolsForBot(t.ownerDeps, botId))).some(
        (x) => x.connectorSlug === 'switched',
      ),
    ).toBe(false);
    // Catalog stdio servers are unaffected.
    const fs = (await (await call(member, 'GET', '/connectors')).json()) as { items: Connector[] };
    expect(fs.items.find((x) => x.catalogId === 'filesystem')!.disabledByAdmin).toBe(false);
  });

  it('never returns a secret value in any response', () => {
    expect(bodies.length).toBeGreaterThan(50);
    for (const body of bodies) {
      for (const [label, value] of Object.entries(SECRETS)) {
        expect(body.includes(value), `${label} leaked in ${body.slice(0, 200)}`).toBe(false);
      }
      expect(body).not.toMatch(/sekrit/);
    }
  });
});

// A self-hosted install has one owner, who is the only one who can start a
// sign-in: the Mac app's default browser may finish it without a session.
// Popup and same-tab flows still need the session, which that browser has.
describe('the OAuth callback on a self-hosted install', () => {
  let t: TestApp;
  let owner: string;
  let as: MockAuthServer;
  let server: TestHttpServer;
  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'self_hosted' });
    t.deps.net = { allowPrivateNetwork: true };
    owner = (await t.signUp('owner@example.com')).cookie!;
    as = await startMockAuthServer();
    server = await startTestHttpServer({
      authorize: (a) => as.validates(a),
      authorizationServer: as.url,
    });
  });
  afterAll(async () => {
    await server.close();
    await as.close();
    await closeMcpManager(t.ownerDeps);
    await t.close();
  });

  const begin = async (name: string, mode: string) => {
    const created = await t.app.request('/api/v1/connectors', {
      method: 'POST',
      headers: { cookie: owner, 'content-type': 'application/json' },
      body: JSON.stringify({ name, url: server.url, auth: 'oauth' }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const started = await t.app.request(`/api/v1/connectors/${id}/oauth/start?mode=${mode}`, {
      headers: { cookie: owner },
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
    const redirect = await as.consent(authorizationUrl);
    return `${redirect.pathname}${redirect.search}`;
  };

  it("finishes the Mac app's sign-in in a browser with no session", async () => {
    const res = await t.app.request(await begin('Desk', 'external'));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('Desk is connected');
    expect(page).toContain('href="openbots://connectors"');
  });

  it('still needs the session for a popup or same-tab sign-in', async () => {
    for (const mode of ['popup', 'redirect']) {
      const path = await begin(`Web ${mode}`, mode);
      const res = await t.app.request(path);
      expect(res.status, mode).toBe(401);
      expect(await res.text()).toContain('Sign in to OpenBots in this browser, then try again.');
      const done = await t.app.request(path, { headers: { cookie: owner } });
      expect(done.status, mode).toBe(mode === 'popup' ? 200 : 302);
    }
  });
});
