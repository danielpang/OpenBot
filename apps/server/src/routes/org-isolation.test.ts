import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { wsEvent, type ServerFrame } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { schema } from '../db/client.js';
import { fanOut } from '../hooks/outbound.js';
import { createArtifact } from '../services/artifacts.js';
import { canUseProvider } from '../services/bots.js';
import { listToolsForBot } from '../services/connectors.js';
import { insertRun } from '../services/runs.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { attachGateway, type Gateway } from '../ws/gateway.js';

// Organizations isolate everything they own (plan 21.3). Every route in the
// OpenAPI document that names a resource is tried against organization A's
// resources twice: by Bob, an owner of organization B, and by Carol, a
// member of A, working in B, against her own data in A. Each must refuse
// with 403 or 404 and echo nothing; every list they can reach must leave A's
// rows out. Workers, outbound events and the realtime gateway keep to the
// organization too.

const spec = JSON.parse(
  readFileSync(new URL('../../../../packages/api-client/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.keys(ops).map((method) => ({ method, path })),
);

/** Routes that name no tenant resource of anyone's, or are outside the API. */
const UNSCOPED = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/api/v1/capabilities',
  '/api/v1/setup',
  '/api/v1/setup/admin',
  '/api/v1/setup/sandbox-image',
  '/api/v1/local/session',
  '/api/v1/connectors/oauth/callback',
  // GitHub's browser redirects, whose signed state names the owner, and the
  // redirect to the App's install page (this app has no App).
  '/api/v1/git-connections/github-app/manifest/callback',
  '/api/v1/git-connections/github-app/callback',
  '/api/v1/git-connections/github-app/install',
  // The caller's own agent card and a new sign-in for it: `{agent}` names no one's resource.
  '/api/v1/coders/{agent}/login',
  '/api/v1/coders/{agent}/sign-out',
  '/api/v1/coders/{agent}/check',
]);

const withParams = operations.filter(({ path }) => path.includes('{') && !UNSCOPED.has(path));
const lists = operations.filter(
  ({ method, path }) => method === 'get' && !path.includes('{') && !UNSCOPED.has(path),
);

/**
 * GET routes an owner does not read with this test's data: an OAuth start
 * with no sign-in to begin, a computer this app does not have, a run's event
 * stream that stays open.
 */
const OWNER_GET_EXCEPTIONS = new Set([
  '/api/v1/connectors/{id}/oauth/start',
  '/api/v1/computer/files/{path}',
  '/api/v1/runs/{id}/events',
  // Lists the repositories from GitHub, which this test does not reach.
  '/api/v1/git-connections/{id}/repositories',
  // A redirect to GitHub for an App connection; the seeded one is a token connection (409).
  '/api/v1/git-connections/{id}/reauthorize',
  // A rescue's results live ten minutes in memory; this test starts none.
  '/api/v1/repos/rescue/{requestId}',
  // Likewise a prepared reset's (fifteen minutes); this test prepares none.
  '/api/v1/computer/reset/{requestId}',
]);

/** Lists only owners and admins read; Carol is a member in B. */
const ADMIN_LISTS = new Set(['/api/v1/settings', '/api/v1/connector-policy']);

/** Lists of the computer's files: this test app has no computer, so they answer 503. */
const NO_COMPUTER = new Set(['/api/v1/computer/files']);

const SAMPLE_BODIES: Record<string, unknown> = {
  'patch /api/v1/bots/{id}': { name: 'Taken' },
  'patch /api/v1/git-connections/{id}': { actAs: 'owner' },
  'post /api/v1/bots/{id}/memories': { content: 'a fact', kind: 'fact' },
  'patch /api/v1/bots/{id}/memories/{memoryId}': { content: 'changed' },
  'put /api/v1/bots/{id}/connectors': { items: [] },
  'put /api/v1/bots/{id}/skills': { skillIds: [] },
  'post /api/v1/bots/{id}/screen/control': { action: 'take' },
  'post /api/v1/bots/{id}/routines': {
    name: 'Daily',
    prompt: 'Report',
    trigger: { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
  },
  'post /api/v1/bots/{id}/endpoints': { slug: 'stolen' },
  'post /api/v1/chats/{id}/members': { botIds: ['00000000-0000-4000-8000-000000000000'] },
  'post /api/v1/chats/{id}/messages': { text: 'hello' },
  'post /api/v1/messages/{id}/reactions': { emoji: '👍' },
  'post /api/v1/messages/{id}/widgets/{part}/action': { action: { type: 'answer' } },
  'post /api/v1/approvals/{id}/decide': { decision: 'approve' },
  'patch /api/v1/providers/{id}': { name: 'Taken' },
  'put /api/v1/providers/{id}/models': { models: [] },
  'patch /api/v1/connectors/{id}': { name: 'Taken' },
  'put /api/v1/connectors/{id}/trusted': { trusted: true },
  'put /api/v1/connectors/{id}/local': { local: false },
  'put /api/v1/artifacts/{id}': { content: 'overwritten' },
  'patch /api/v1/routines/{id}': { name: 'Taken' },
  'patch /api/v1/skills/{id}': { name: 'Taken' },
  'patch /api/v1/endpoints/{id}': { slug: 'taken' },
  'post /api/v1/endpoints/{id}/test': { payload: {} },
  'patch /api/v1/event-subscriptions/{id}': { enabled: false },
  'put /api/v1/devices/{id}/push': { token: 'ab'.repeat(32), environment: 'sandbox' },
  'post /api/v1/coding-sessions/{id}/continue': { prompt: 'Keep going' },
  'post /api/v1/coders/{agent}/login/{loginId}/code': { code: 'stolen-code' },
  // Another owner's provider is refused in routes/coders.test.ts.
  'put /api/v1/coders/{agent}/api-key': { providerId: '00000000-0000-4000-8000-000000000000' },
};

/** What one person owns in organization A, and the words that would give it away. */
interface Owned {
  marker: string;
  ids: Record<string, string>;
}

describe('organizations are isolated (plan 21.3)', () => {
  let t: TestApp;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let bob: string;
  /** Carol's session working in A, and another of hers working in B. */
  let carolInA: string;
  let carolInB: string;
  const owned: Record<'alice' | 'carol', Owned> = {} as never;

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(path, {
      method: method.toUpperCase(),
      headers: {
        origin: ORIGIN,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as T;
  }

  async function signIn(email: string) {
    const res = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'correct horse battery' }),
    });
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
  }

  /** Everything a member can own, made through the API where it can be, in their active organization. */
  async function seed(cookie: string, marker: string): Promise<Owned> {
    const userId = await t.userId(`${marker.split('-')[0]!.toLowerCase()}@example.com`);
    const bot = await json<{ id: string; chatId: string; workspaceId?: string }>(
      call(cookie, 'post', '/api/v1/bots', { name: `${marker} Bot`, modelConfig: null }),
      201,
    );
    const peer = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/bots', { name: `${marker} Peer`, modelConfig: null }),
      201,
    );
    const group = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/chats', {
        botIds: [bot.id, peer.id],
        title: `${marker} Group`,
      }),
      201,
    );
    const memory = await json<{ id: string }>(
      call(cookie, 'post', `/api/v1/bots/${bot.id}/memories`, {
        content: `${marker} remembers this`,
        kind: 'fact',
      }),
      201,
    );
    const message = await json<{ id: string }>(
      call(cookie, 'post', `/api/v1/chats/${group.id}/messages`, { text: `${marker} says hi` }),
      201,
    );
    const skill = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/skills', { name: `${marker} Skill`, content: 'Do it.' }),
      201,
    );
    const connector = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/connectors', {
        name: `${marker} Connector`,
        url: 'https://203.0.113.20/mcp',
      }),
      201,
    );
    const form = new FormData();
    form.set('file', new File([`${marker} file body`], `${marker}.txt`, { type: 'text/plain' }));
    const file = await json<{ id: string }>(
      t.app.request('/api/v1/files', {
        method: 'POST',
        headers: { origin: ORIGIN, cookie },
        body: form,
      }),
      201,
    );
    const routine = await json<{ id: string }>(
      call(cookie, 'post', `/api/v1/bots/${bot.id}/routines`, {
        name: `${marker} Routine`,
        prompt: 'Report',
        trigger: { type: 'schedule', preset: { kind: 'daily', time: '08:00' } },
      }),
      201,
    );
    const endpoints = await json<{ items: { id: string }[] }>(
      call(cookie, 'get', `/api/v1/bots/${bot.id}/endpoints`),
    );
    const subscription = await json<{ subscription: { id: string } }>(
      call(cookie, 'post', '/api/v1/event-subscriptions', {
        url: `https://203.0.113.21/${marker}`,
        events: ['run.completed', 'artifact.created'],
      }),
      201,
    );
    const provider = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/providers', {
        name: `${marker} Provider`,
        protocol: 'openai_compatible',
        baseUrl: 'https://203.0.113.22/v1',
        apiKey: `${marker}-key-0123456789`,
        scope: 'account',
        models: [{ modelId: 'm' }],
      }),
      201,
    );
    const key = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/api-keys', { name: marker.slice(0, 20) }),
      201,
    );
    const pairing = await json<{ qr: { code: string } }>(
      call(cookie, 'post', '/api/v1/devices/pairings', { name: `${marker} Server` }),
      201,
    );
    // One left open, for the cancel route.
    const openPairing = await json<{ id: string }>(
      call(cookie, 'post', '/api/v1/devices/pairings', { name: `${marker} Open` }),
      201,
    );
    const device = await json<{ device: { id: string } }>(
      call(cookie, 'post', '/api/v1/devices/pair', {
        code: pairing.qr.code,
        name: `${marker} Phone`,
        platform: 'ios',
        publicKey: randomBytes(32).toString('base64url'),
        pushKey: randomBytes(32).toString('base64url'),
      }),
    );

    const [botRow] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
    const owner = { id: userId, workspaceId: botRow!.workspaceId };
    const { artifact } = await createArtifact(
      t.ownerDeps,
      owner,
      { title: `${marker} Artifact`, kind: 'document', botId: bot.id, content: `${marker} doc` },
      { userId },
    );
    const run = await insertRun(t.db, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    const [approval] = await t.db
      .insert(schema.approvals)
      .values({
        workspaceId: owner.workspaceId,
        runId: run.id,
        toolName: 'send_email',
        args: { to: `${marker}@example.com` },
      })
      .returning();
    const [delivery] = await t.db
      .insert(schema.webhookDeliveries)
      .values({
        workspaceId: owner.workspaceId,
        endpointId: endpoints.items[0]!.id,
        status: 'received',
        bodyPreview: `${marker} payload`,
      })
      .returning();
    const repo = await json<{ repo: { id: string } }>(
      call(cookie, 'post', '/api/v1/repos', {
        remoteUrl: `https://github.com/${marker.toLowerCase()}/app`,
      }),
      201,
    );
    const [session] = await t.db
      .insert(schema.codingSessions)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: userId,
        botId: bot.id,
        agent: 'claude',
        repoId: repo.repo.id,
        repoFullName: `${marker.toLowerCase()}/app`,
        worktreePath: `/home/bot/repos/${marker.toLowerCase()}/app/.worktrees/bot-x`,
        branch: 'bot/x',
        base: 'main',
        mode: 'edit',
        prompt: `${marker} task`,
        status: 'settled',
      })
      .returning();
    const [gitConnection] = await t.db
      .insert(schema.gitConnections)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: userId,
        kind: 'token',
        accountLogin: marker.toLowerCase(),
      })
      .returning();
    const [login] = await t.db
      .insert(schema.coderLogins)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: userId,
        agent: 'claude',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    return {
      marker,
      ids: {
        repo: repo.repo.id,
        session: session!.id,
        login: login!.id,
        gitConnection: gitConnection!.id,
        bot: bot.id,
        peer: peer.id,
        chat: bot.chatId,
        group: group.id,
        memory: memory.id,
        message: message.id,
        skill: skill.id,
        connector: connector.id,
        file: file.id,
        routine: routine.id,
        endpoint: endpoints.items[0]!.id,
        delivery: delivery!.id,
        subscription: subscription.subscription.id,
        provider: provider.id,
        apiKey: key.id,
        device: device.device.id,
        pairing: openPairing.id,
        artifact: artifact.id,
        run: run.id,
        approval: approval!.id,
      },
    };
  }

  /** The path with its parameters filled from what the target owns. */
  function fill(path: string, { ids }: Owned): string {
    const first = /^\/api\/v1\/([a-z-]+)\/\{id\}/.exec(path)?.[1];
    const byPrefix: Record<string, string> = {
      bots: ids.bot!,
      chats: ids.group!,
      messages: ids.message!,
      files: ids.file!,
      providers: ids.provider!,
      runs: ids.run!,
      approvals: ids.approval!,
      connectors: ids.connector!,
      artifacts: ids.artifact!,
      routines: ids.routine!,
      skills: ids.skill!,
      endpoints: ids.endpoint!,
      'event-subscriptions': ids.subscription!,
      'api-keys': ids.apiKey!,
      devices: ids.device!,
      repos: ids.repo!,
      'coding-sessions': ids.session!,
      'git-connections': ids.gitConnection!,
    };
    let filled = path;
    if (first) {
      const id = byPrefix[first];
      expect(id, `no resource for ${path}`).toBeDefined();
      filled = filled.replace('{id}', id!);
    }
    if (path === '/api/v1/devices/pairings/{id}') filled = filled.replace('{id}', ids.pairing!);
    if (path === '/api/v1/messages/{id}/reactions') filled += '?emoji=%F0%9F%91%8D';
    return filled
      .replace('{agent}', 'claude')
      .replace('{loginId}', ids.login!)
      .replace('{memoryId}', ids.memory!)
      .replace('{botId}', ids.peer!)
      .replace('{part}', '0')
      .replace('{version}', '1')
      .replace('{did}', ids.delivery!)
      .replace('{requestId}', '00000000-0000-4000-8000-000000000000')
      .replace('{path}', 'notes.txt');
  }

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    orgA = await t.defaultOrganization();
    alice = (await t.signUp('alice@example.com')).cookie!; // the owner of A
    carolInA = (await t.signUp('carol@example.com')).cookie!; // a member of A
    bob = (await t.signUp('bob@example.com')).cookie!;
    orgB = await t.createOrganization('Org B');
    // Bob works only in B, as its owner; Carol is a member of both.
    const bobId = await t.userId('bob@example.com');
    await t.db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, bobId));
    await t.addMember(bobId, orgB, 'owner');
    await t.switchOrganization(bob, orgB);
    await t.addMember(await t.userId('carol@example.com'), orgB, 'member');
    carolInB = await signIn('carol@example.com');
    await t.switchOrganization(carolInB, orgB);

    owned.alice = await seed(alice, 'ALICE-SECRET');
    owned.carol = await seed(carolInA, 'CAROL-SECRET');
    // Bob and Carol have their own things in B, so their lists are not empty.
    await seed(bob, 'BOB-SECRET');
  }, 60_000);
  afterAll(() => t.close());

  it('covers every route that names a resource', () => {
    expect(withParams.length).toBeGreaterThan(50);
    expect(lists.length).toBeGreaterThan(15);
  });

  const cases = [
    ['Bob, an owner of organization B', () => bob, 'alice'],
    ['Carol, working in organization B, against her own data in A', () => carolInB, 'carol'],
  ] as const;

  for (const [who, cookieOf, target] of cases) {
    it(`refuses every resource route to ${who}, without echoing it`, async () => {
      const victim = owned[target];
      const allowed: string[] = [];
      for (const { method, path } of withParams) {
        const res = await call(
          cookieOf(),
          method,
          fill(path, victim),
          SAMPLE_BODIES[`${method} ${path}`],
        );
        const text = await res.text();
        if (path === '/api/v1/computer/files/{path}') {
          // Their own computer in B, which has no such file: nothing of A's.
          if (![403, 404, 409, 503].includes(res.status)) allowed.push(`${method} ${path}`);
        } else if (![403, 404].includes(res.status)) {
          allowed.push(`${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
        }
        expect(text, `${method} ${path}`).not.toContain(victim.marker);
      }
      expect(allowed).toEqual([]);
    });

    it(`keeps A's rows out of every list ${who} can read`, async () => {
      const victim = owned[target];
      const refusedLists: string[] = [];
      for (const { path } of lists) {
        const res = await call(cookieOf(), 'get', path);
        const text = await res.text();
        // Their own lists answer (an owner's settings too), so an empty one proves something.
        if (
          res.status !== 200 &&
          !NO_COMPUTER.has(path) &&
          !(target === 'carol' && ADMIN_LISTS.has(path))
        ) {
          refusedLists.push(`${path} -> ${res.status}`);
        }
        expect(text, path).not.toContain(victim.marker);
        for (const [kind, id] of Object.entries(victim.ids)) {
          expect(text, `${path} shows ${kind}`).not.toContain(id);
        }
      }
      expect(refusedLists).toEqual([]);
    });
  }

  it('lets each owner read their own resources on the same routes (a control)', async () => {
    for (const [cookie, victim] of [
      [alice, owned.alice],
      [carolInA, owned.carol],
    ] as const) {
      const unread: string[] = [];
      for (const { method, path } of withParams) {
        if (method !== 'get' || OWNER_GET_EXCEPTIONS.has(path)) continue;
        const res = await call(cookie, 'get', fill(path, victim));
        if (res.status !== 200) unread.push(`${path} -> ${res.status}`);
      }
      expect(unread).toEqual([]);
    }
  });

  it("leaves A's resources as they were for their owners", async () => {
    for (const [cookie, victim] of [
      [alice, owned.alice],
      [carolInA, owned.carol],
    ] as const) {
      const bot = await json<{ name: string }>(
        call(cookie, 'get', `/api/v1/bots/${victim.ids.bot}`),
      );
      expect(bot.name).toBe(`${victim.marker} Bot`);
      const skill = await json<{ name: string }>(
        call(cookie, 'get', `/api/v1/skills/${victim.ids.skill}`),
      );
      expect(skill.name).toBe(`${victim.marker} Skill`);
    }
  });

  it("refuses A's resources named inside a request Carol makes in B", async () => {
    const mine = await json<{ id: string; chatId: string }>(
      call(carolInB, 'post', '/api/v1/bots', { name: 'Carol B Bot', modelConfig: null }),
      201,
    );
    const { ids } = owned.carol;
    const refused = async (res: Response | Promise<Response>) =>
      expect([403, 404]).toContain((await res).status);
    await refused(
      call(carolInB, 'put', `/api/v1/bots/${mine.id}/skills`, { skillIds: [ids.skill] }),
    );
    await refused(
      call(carolInB, 'put', `/api/v1/bots/${mine.id}/connectors`, {
        items: [
          {
            connectorId: ids.connector,
            toolAllowlist: null,
            toolDenylist: [],
            approvalOverride: null,
          },
        ],
      }),
    );
    await refused(
      call(carolInB, 'post', '/api/v1/bots', {
        name: 'Borrower',
        modelConfig: { provider_id: ids.provider, model_id: 'm' },
      }),
    );
    await refused(
      call(carolInB, 'patch', `/api/v1/bots/${mine.id}`, {
        avatar: { kind: 'upload', file_id: ids.file },
      }),
    );
    await refused(call(carolInB, 'post', '/api/v1/chats', { botIds: [mine.id, ids.bot] }));
    const attached = await call(carolInB, 'post', `/api/v1/chats/${mine.chatId}/messages`, {
      text: 'see this',
      attachments: [ids.file],
    });
    expect([400, 403, 404]).toContain(attached.status);
    expect(await attached.text()).not.toContain('CAROL-SECRET');
  });

  it("keeps a worker's view of a Bot inside its organization", async () => {
    const { ids } = owned.carol;
    const carolId = await t.userId('carol@example.com');
    const [inB] = await t.db.select().from(schema.bots).where(eq(schema.bots.name, 'Carol B Bot'));
    // A cached tool on her connector in A: her Bot in A sees it, her Bot in B does not.
    await t.db.insert(schema.connectorTools).values({
      workspaceId: orgA,
      connectorId: ids.connector!,
      name: 'lookup',
      description: 'Looks things up',
      inputSchema: { type: 'object' },
    });
    await t.db
      .update(schema.connectors)
      .set({ status: 'ok' })
      .where(eq(schema.connectors.id, ids.connector!));
    expect((await listToolsForBot(t.ownerDeps, ids.bot!)).map((tool) => tool.tool)).toContain(
      'lookup',
    );
    expect(await listToolsForBot(t.ownerDeps, inB!.id)).toEqual([]);
    // Her provider in A is not one her Bot in B may run on.
    expect(await canUseProvider(t.db, { id: carolId, workspaceId: orgA }, ids.provider!)).toBe(
      true,
    );
    expect(await canUseProvider(t.db, { id: carolId, workspaceId: orgB }, ids.provider!)).toBe(
      false,
    );
  });

  it("sends an event of A only to subscriptions in A, not to its owner's in B", async () => {
    const { ids } = owned.carol;
    const inB = await json<{ subscription: { id: string } }>(
      call(carolInB, 'post', '/api/v1/event-subscriptions', {
        url: 'https://203.0.113.23/carol-b',
        events: ['artifact.created'],
      }),
      201,
    );
    const rows = await fanOut(
      t.ownerDeps,
      wsEvent('artifact.created', { artifactId: ids.artifact!, title: 'x' }, { bot_id: ids.bot }),
    );
    const subscriptions = rows.map((r) => r.subscriptionId);
    expect(subscriptions).toContain(ids.subscription);
    expect(subscriptions).not.toContain(inB.subscription.id);
    expect(rows.every((r) => r.workspaceId === orgA)).toBe(true);
  });

  describe('the realtime gateway', () => {
    let server: ServerType;
    let gateway: Gateway;
    let url: string;

    beforeAll(async () => {
      server = await new Promise<ServerType>((resolve) => {
        const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
      });
      gateway = await attachGateway(server, t.deps);
      url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    });
    afterAll(async () => {
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    });

    function connect(cookie: string): Promise<{ socket: WebSocket; next(): Promise<ServerFrame> }> {
      const socket = new WebSocket(url, { headers: { cookie, origin: ORIGIN } });
      const frames: ServerFrame[] = [];
      let waiting: ((frame: ServerFrame) => void) | undefined;
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame;
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve(frame);
        } else frames.push(frame);
      });
      return new Promise((resolve, reject) => {
        socket.once('open', () =>
          resolve({
            socket,
            next: () =>
              frames.length
                ? Promise.resolve(frames.shift()!)
                : new Promise((r) => {
                    waiting = r;
                  }),
          }),
        );
        socket.once('error', reject);
      });
    }

    it("denies A's chats and Bots to sockets working in B, and never sends them A's events", async () => {
      const { ids } = owned.carol;
      const inB = await connect(carolInB);
      const intruder = await connect(bob);
      const inA = await connect(carolInA);
      for (const client of [inB, intruder]) {
        client.socket.send(
          JSON.stringify({ type: 'subscribe', chats: [ids.chat, ids.group], bots: [ids.bot] }),
        );
        expect(await client.next()).toMatchObject({
          type: 'subscribed',
          chats: [],
          bots: [],
        });
      }
      inA.socket.send(JSON.stringify({ type: 'subscribe', bots: [ids.bot] }));
      expect(await inA.next()).toMatchObject({ type: 'subscribed', bots: [ids.bot] });
      const event = wsEvent(
        'bot.state',
        { botId: ids.bot!, state: 'thinking', currentAction: 'Reading', runId: null },
        { bot_id: ids.bot },
      );
      const { publishEvent } = await import('../infra/index.js');
      await publishEvent(t.deps.infra.bus, event);
      expect(await inA.next()).toEqual(event);
      // A ping answered next proves nothing else came first.
      for (const client of [inB, intruder]) {
        client.socket.send(JSON.stringify({ type: 'ping' }));
        expect(await client.next()).toMatchObject({ type: 'pong' });
      }
      for (const client of [inA, inB, intruder]) client.socket.close();
    });
  });
});
