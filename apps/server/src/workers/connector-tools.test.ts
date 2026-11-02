import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localEmbedder } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import type { MessagePart } from '@openbots/shared';
import { SMTPServer } from 'smtp-server';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { schema } from '../db/client.js';
import { getState } from '../services/bot-state.js';
import { closeMcpManager } from '../services/connectors.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// Connector tools and built-ins in a real run (plan 18.3, the Phase 2 exit
// criterion): a Bot calls a GitHub tool from an MCP connector (the server is
// a local fake), the policy asks, the owner approves, and the tool runs once.
// Also: a connector whose login is refused blocks the Bot with an event row,
// and an email draft's Send goes through the approval to a real SMTP send.

interface FakeGithub {
  url: string;
  created: { title: string; body?: string }[];
  authorized: boolean;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** A Streamable HTTP MCP server with two GitHub-like tools, behind a bearer token it can start refusing. */
async function startFakeGithub(): Promise<FakeGithub> {
  const fake = { created: [] as FakeGithub['created'], authorized: true };
  const build = () => {
    const server = new McpServer({ name: 'fake-github', version: '1.0.0' });
    server.registerTool(
      'create_issue',
      {
        title: 'Create issue',
        description: 'Open an issue in a repository',
        inputSchema: { repo: z.string(), title: z.string(), body: z.string().optional() },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ title, body }) => {
        fake.created.push({ title, ...(body ? { body } : {}) });
        return { content: [{ type: 'text', text: `Created issue #42: ${title}` }] };
      },
    );
    server.registerTool(
      'list_issues',
      {
        title: 'List issues',
        description: 'List open issues',
        inputSchema: { repo: z.string() },
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: 'text', text: 'No open issues' }] }),
    );
    return server;
  };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http: Server = createServer((req, res) => {
    void (async () => {
      if (!fake.authorized || req.headers.authorization !== 'Bearer gh-token') {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const id = req.headers['mcp-session-id'];
      let transport = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, created);
          },
        });
        await build().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      for (const t of sessions.values()) await t.close().catch(() => {});
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  });
}

describe('connector tools and built-ins in a run', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  let github: FakeGithub;
  let connectorId: string;
  let smtp: SMTPServer;
  let smtpPort: number;
  const mails: string[] = [];
  const models = new Map<string, RunModel>();

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    // The fake MCP, GitHub and SMTP servers listen on 127.0.0.1 (S-8).
    t.deps.net = { allowPrivateNetwork: true };
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(
      createRunWorker(t.deps, {
        resolveModel: async (_config, bot) => models.get(bot.id)!,
        smallModel: async () => null,
        embedder: localEmbedder,
        builtins: { email: { insecure: true }, net: { allowPrivateNetwork: true } },
      }),
      { concurrency: 2 },
    );
    github = await startFakeGithub();
    let res = await call('POST', '/connectors', {
      name: 'GitHub',
      slug: 'github',
      url: github.url,
      auth: 'bearer',
      secrets: { BEARER_TOKEN: 'gh-token' },
    });
    expect(res.status).toBe(201);
    connectorId = ((await res.json()) as { id: string }).id;
    res = await call('POST', `/connectors/${connectorId}/test`);
    expect(res.status).toBe(200);
    const tested = (await res.json()) as { tools: { name: string }[] };
    expect(tested.tools.map((x) => x.name)).toEqual(['create_issue', 'list_issues']);
    // A custom connector's read-only hints count only once an admin trusts it (S-16).
    await t.db
      .update(schema.connectors)
      .set({ trusted: true })
      .where(eq(schema.connectors.id, connectorId));

    smtp = new SMTPServer({
      secure: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      onAuth: (_auth, _session, cb) => cb(null, { user: 'bot' }),
      onData(stream, _session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          mails.push(Buffer.concat(chunks).toString('utf8'));
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    smtpPort = (smtp.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    unhook();
    await closeMcpManager(t.ownerDeps);
    await github.close();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await t.close();
  });

  function call(method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function newBot(name: string, turns: ScriptedTurn[]) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as { id: string; chatId: string };
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  const say = async (chatId: string, text: string) =>
    expect((await call('POST', `/chats/${chatId}/messages`, { text })).status).toBe(201);
  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 8_000, interval: 10 });
  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));
  const messagesOf = (chatId: string) =>
    t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq));
  const botRow = async (id: string) => (await getState(t.ownerDeps, id))!;
  // The worker writes the Bot's closing state after the run's status, so a
  // test that reads it waits for both.
  const settled = (botId: string, status: string) =>
    until(async () => {
      expect((await runsOf(botId))[0]?.status).toBe(status);
      expect((await botRow(botId)).state).toMatch(/^(done|waiting|blocked|idle)$/);
    });
  const stepsOf = (runId: string) =>
    t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(asc(schema.runSteps.idx));

  it('runs a GitHub connector tool after the owner approves it, once', async () => {
    const { bot, model } = await newBot('Triage', [
      [
        { text: 'Filing it.' },
        {
          tool: 'github__create_issue',
          args: { repo: 'acme/app', title: 'Crash on save' },
          id: 'gh-1',
        },
      ],
      [{ text: 'Filed issue #42.' }],
    ]);
    // Connector tools are offered to the model under their connector names.
    await say(bot.chatId, 'file a bug: the app crashes on save');
    await settled(bot.id, 'waiting');
    expect(model.calls[0]!.tools?.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        'github__create_issue',
        'github__list_issues',
        'web_fetch',
        'http_request',
      ]),
    );
    const [run] = await runsOf(bot.id);
    const asked = (await messagesOf(bot.chatId)).filter((m) => m.authorType === 'bot').at(-1)!;
    const parts = asked.parts as MessagePart[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'widget']);
    expect(parts[1]).toMatchObject({
      tool_name: 'github__create_issue',
      label: 'GitHub: Create issue',
    });
    expect(parts[2]).toMatchObject({
      kind: 'approval',
      props: {
        tool_name: 'github__create_issue',
        args: { repo: 'acme/app', title: 'Crash on save' },
        reason: 'github__create_issue is not marked read-only',
      },
    });
    expect((await botRow(bot.id)).currentAction).toBe('Waiting for approval: github: create issue');
    expect(github.created).toEqual([]);

    const [approval] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, run!.id));
    const res = await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    await settled(bot.id, 'completed');
    expect(github.created).toEqual([{ title: 'Crash on save' }]);
    expect(promptText(model.calls[1]!)).toContain('Created issue #42: Crash on save');
    const labels = (await stepsOf(run!.id)).map((s) => [s.type, s.label]);
    expect(labels).toEqual(
      expect.arrayContaining([
        ['approval', 'Asked to approve: GitHub: Create issue'],
        ['approval', 'Approved: GitHub: Create issue'],
        ['tool_call', 'GitHub: Create issue'],
      ]),
    );
    expect((await botRow(bot.id)).state).toMatch(/done|idle/);
  });

  it('blocks the Bot with an event row when the connector refuses its login', async () => {
    const { bot } = await newBot('Reader', [
      [{ tool: 'github__list_issues', args: { repo: 'acme/app' }, id: 'gh-2' }],
      [{ text: 'GitHub needs you to sign in again.' }],
    ]);
    github.authorized = false;
    try {
      await say(bot.chatId, 'any open issues?');
      await settled(bot.id, 'completed');
    } finally {
      github.authorized = true;
    }
    const row = await botRow(bot.id);
    expect(row.state).toBe('blocked');
    expect(row.currentAction).toBe('GitHub needs login');
    const events = (await messagesOf(bot.chatId))
      .filter((m) => m.authorType === 'system')
      .flatMap((m) => m.parts as MessagePart[]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'event',
        kind: 'blocked',
        text: 'GitHub connector needs login. Sign in again on the Connectors page.',
        data: expect.objectContaining({
          connectorId,
          link: `/connectors?connector=${connectorId}`,
        }),
      }),
    ]);
    const [connector] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, connectorId));
    expect(connector!.status).toBe('needs_auth');
    const result = (await messagesOf(bot.chatId))
      .flatMap((m) => m.parts as MessagePart[])
      .find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ is_error: true });
  });

  it("sends an email draft's Send through the approval and the SMTP built-in", async () => {
    let res = await call('POST', '/connectors', {
      catalogId: 'email',
      params: { smtp_host: '127.0.0.1', smtp_port: String(smtpPort), username: 'bot@example.com' },
      secrets: { PASSWORD: 'pw' },
    });
    expect(res.status).toBe(201);
    const draft = { to: ['ada@example.com'], subject: 'Hello', body: 'Hi Ada' };
    const { bot } = await newBot('Mailer', [
      [{ tool: 'show_widget', args: { kind: 'email_draft', props: draft } }],
      [{ text: 'Here is a draft.' }],
      [{ text: 'Sent it.' }],
    ]);
    await say(bot.chatId, 'draft a hello to Ada');
    await settled(bot.id, 'completed');
    const drafted = (await messagesOf(bot.chatId)).filter((m) => m.authorType === 'bot').at(-1)!;
    const partIndex = (drafted.parts as MessagePart[]).findIndex((p) => p.type === 'widget');

    res = await call('POST', `/messages/${drafted.id}/widgets/${partIndex}/action`, {
      action: { type: 'send', subject: 'Hello there' },
    });
    const { startedRunId } = (await res.json()) as { startedRunId: string };
    await until(async () =>
      expect((await runsOf(bot.id)).find((r) => r.id === startedRunId)?.status).toBe('waiting'),
    );
    expect(mails).toEqual([]);
    const [approval] = await t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, startedRunId));
    await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    await until(async () =>
      expect((await runsOf(bot.id)).find((r) => r.id === startedRunId)?.status).toBe('completed'),
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]).toContain('Subject: Hello there');
    const [widget] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, drafted.id));
    expect(widget!.state).toMatchObject({ status: 'sent', draft: { subject: 'Hello there' } });
  });
});
