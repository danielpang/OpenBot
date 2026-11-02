import {
  conversationTools,
  defineTool,
  localEmbedder,
  type SerializedRunState,
  type ToolGroup,
} from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import { EVENTS_CHANNEL, type MessagePart, type WsEvent } from '@openbots/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { createInfra, type Infra } from '../infra/index.js';
import type { Message } from '../schemas.js';
import {
  APPROVALS_QUEUE,
  approvalTtlMs,
  expireApproval,
  expireDueApprovals,
  expiryHandler,
  type ExpireJob,
} from '../services/approvals.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, isGreeting, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel, type RunWorkerOptions } from './runs.js';
import { inEveryOrganization } from '../workers.js';

// Approvals end to end (plan 5.6, 18.3, P1, T5): the policy asks, the run
// pauses with an approval widget and an `approvals` row, the "process" that
// ran it goes away, and a fresh one resumes it on the owner's decision.

interface Bot {
  id: string;
  chatId: string;
  handle: string;
}

/** One server process: its own queues, bus and run worker; nothing shared in memory. */
interface Process {
  infra: Infra;
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  events: WsEvent[];
}

describe('approvals', () => {
  let t: TestApp;
  let cookie: string;
  let ownerId: string;
  let unhook: () => void;
  let proc: Process;
  const models = new Map<string, RunModel>();
  /** Every tool execution, in order; the restart test checks the approved one ran once. */
  const executed: { tool: string; args: unknown }[] = [];

  const testTools: ToolGroup[] = [
    conversationTools,
    {
      name: 'computer',
      tools: () => ({
        bash: defineTool({
          description: 'Run a shell command',
          inputSchema: z.object({ command: z.string() }),
          execute: async (args) => {
            executed.push({ tool: 'bash', args });
            return { exitCode: 0, stdout: 'removed' };
          },
        }),
      }),
    },
    {
      name: 'builtin',
      tools: () => ({
        send_email: defineTool({
          description: 'Send an email',
          inputSchema: z.object({
            to: z.array(z.string()),
            subject: z.string(),
            body: z.string(),
          }),
          execute: async (args) => {
            executed.push({ tool: 'send_email', args });
            return { sent: true };
          },
        }),
      }),
    },
  ];

  const options = (): RunWorkerOptions => ({
    resolveModel: async (_config, bot) => {
      const model = models.get(bot.id);
      if (!model) throw new Error(`no scripted model for ${bot.handle}`);
      return model;
    },
    smallModel: async () => null,
    embedder: localEmbedder,
    toolGroups: testTools,
  });

  async function startProcess(): Promise<Process> {
    const infra = createInfra(t.deps.config);
    const deps: AppDeps = { ...t.ownerDeps, infra };
    const events: WsEvent[] = [];
    await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps, options()), {
      concurrency: 4,
    });
    await infra.queue<ExpireJob>(APPROVALS_QUEUE).process(expiryHandler(deps));
    return { infra, deps, app: createApp(deps, { webDist: '' }), events };
  }

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    const [user] = await t.db.select().from(schema.users);
    ownerId = user!.id;
    unhook = registerRunHooks();
    proc = await startProcess();
  });
  afterAll(async () => {
    unhook();
    await proc.infra.close();
    await t.close();
  });

  function call(method: string, path: string, body?: unknown, app = proc.app) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function newBot(name: string, turns: ScriptedTurn[], toolPolicy?: unknown) {
    const res = await call('POST', '/bots', {
      name,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
      ...(toolPolicy ? { toolPolicy } : {}),
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  const say = async (bot: Bot, text: string, threadRootId?: string) => {
    const res = await call('POST', `/chats/${bot.chatId}/messages`, {
      text,
      ...(threadRootId ? { threadRootId } : {}),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  };

  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  const statesOf = (botId: string) =>
    proc.events
      .filter((e) => e.type === 'bot.state' && e.bot_id === botId)
      .map((e) => e.payload as { state: string; currentAction: string | null })
      .map((p) => (p.currentAction ? `${p.state}:${p.currentAction}` : p.state));

  // The worker publishes the Bot's closing state (and the events of the rows
  // it committed with the status) after the run's status, so a test that
  // reads the events waits for both.
  const settled = (botId: string, status: string) =>
    until(async () => {
      expect((await runsOf(botId))[0]?.status).toBe(status);
      expect(statesOf(botId).at(-1)).toMatch(/^(done|waiting|blocked|idle)\b/);
    });

  const botMessages = async (chatId: string) =>
    (
      await t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chatId))
        .orderBy(asc(schema.messages.seq))
    ).filter((m) => m.authorType === 'bot' && !isGreeting(m));

  const approvalsOf = (runId: string) =>
    t.db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));

  const auditOf = (targetId: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, targetId))
      .orderBy(asc(schema.auditLog.createdAt));

  const stepsOf = (runId: string) =>
    t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(asc(schema.runSteps.idx));

  const ranFor = (tool: string, marker: string) =>
    executed.filter((e) => e.tool === tool && JSON.stringify(e.args).includes(marker));

  /** A Bot that calls `bash` (ask by default) and pauses for approval. */
  async function askAndPause(name: string, after: ScriptedTurn[]) {
    const command = `rm -rf build-${name}`;
    const { bot, model } = await newBot(name, [
      [{ text: 'Cleaning up.' }, { tool: 'bash', args: { command }, id: `bash-${name}` }],
      ...after,
    ]);
    await say(bot, 'clean the build');
    await settled(bot.id, 'waiting');
    const [run] = await runsOf(bot.id);
    const [asked] = await botMessages(bot.chatId);
    const [approval] = await approvalsOf(run!.id);
    return { bot, model, run: run!, asked: asked!, approval: approval!, command };
  }

  it('pauses on an ask tool, survives a worker restart, and runs the approved tool once', async () => {
    const { bot, model, run, asked, approval, command } = await askAndPause('Restart', [
      [{ text: 'Build directory removed.' }],
    ]);

    // The approval widget, the row, the serialized run, the event and the audit entry.
    const parts = asked.parts as MessagePart[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'widget']);
    expect(parts[2]).toMatchObject({
      type: 'widget',
      kind: 'approval',
      props: {
        tool_name: 'bash',
        args: { command },
        summary: `$ ${command}`,
        reason: 'bash runs commands on the computer',
        trace: [{ rule: 'default', decision: 'ask' }],
      },
      state: { status: 'pending' },
    });
    expect(approval).toMatchObject({
      messageId: asked.id,
      toolName: 'bash',
      args: { command },
      reason: 'bash runs commands on the computer',
      status: 'pending',
    });
    const ttl = approval.expiresAt!.getTime() - approval.createdAt.getTime();
    expect(Math.abs(ttl - 24 * 60 * 60_000)).toBeLessThan(60_000);
    const state = run.state as SerializedRunState;
    expect(state).toMatchObject({
      version: 1,
      pending: {
        reason: 'approval',
        toolCallId: 'bash-Restart',
        toolName: 'bash',
        args: { command },
        widget: { kind: 'approval' },
        label: `Waiting for approval: running ${command.toLowerCase()}`,
        messageId: asked.id,
        partIndex: 2,
      },
      seenSeq: expect.any(Number),
    });
    // The opening line and the Bot's greeting, the owner's message, the call and its result.
    expect(state.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);
    expect(JSON.stringify(state.messages.at(-1))).toContain('waiting_for_owner');
    const requested = proc.events.find(
      (e) => e.type === 'approval.requested' && e.payload.approval.id === approval.id,
    );
    expect(requested).toMatchObject({
      chat_id: bot.chatId,
      bot_id: bot.id,
      seq: asked.seq,
      payload: { approval: { toolName: 'bash', summary: `$ ${command}`, status: 'pending' } },
    });
    expect((await stepsOf(run.id)).map((s) => [s.type, s.label])).toContainEqual([
      'approval',
      `Asked to approve: Running ${command}`,
    ]);
    expect((await auditOf(approval.id)).map((a) => a.action)).toEqual(['approval.requested']);
    expect(ranFor('bash', command)).toEqual([]);

    // The process goes away; a new one, with nothing in memory, takes the decision.
    await proc.infra.close();
    proc = await startProcess();

    const res = await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approval: { id: approval.id, status: 'approved', decidedBy: ownerId, note: null },
      resumedRunId: run.id,
    });
    await settled(bot.id, 'completed');

    // The tool ran exactly once, and its real result reached the model.
    expect(ranFor('bash', command)).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
    expect(promptText(model.calls[1]!)).toContain('"stdout":"removed"');
    expect(promptText(model.calls[1]!)).not.toContain('waiting_for_owner');
    const replies = await botMessages(bot.chatId);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.parts).toMatchObject([
      { type: 'tool_result', tool_call_id: 'bash-Restart', result: { exitCode: 0 } },
      { type: 'text', text: 'Build directory removed.' },
    ]);
    expect((await stepsOf(run.id)).map((s) => [s.type, s.label])).toEqual(
      expect.arrayContaining([
        ['approval', `Approved: Running ${command}`],
        ['tool_call', `Ran ${command}`],
      ]),
    );
    expect(proc.events.some((e) => e.type === 'approval.resolved')).toBe(true);
    expect((await auditOf(approval.id)).map((a) => [a.action, a.actorId])).toEqual([
      ['approval.requested', bot.id],
      ['approval.approved', ownerId],
    ]);
    const [widget] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, asked.id));
    expect(widget).toMatchObject({ state: { status: 'approved' }, pendingRunId: null });

    // A second decision is refused, and nothing runs twice.
    const again = await call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' });
    expect(again.status).toBe(409);
    expect(
      (
        await call('POST', `/messages/${asked.id}/widgets/2/action`, {
          action: { type: 'approve' },
        })
      ).status,
    ).toBe(409);
    await new Promise((r) => setTimeout(r, 50));
    expect(ranFor('bash', command)).toHaveLength(1);
    expect(await runsOf(bot.id)).toHaveLength(1);
  });

  it('retries a resumed run that overflows without its oldest transcript messages (plan 5.7)', async () => {
    const command = 'rm -rf build-Overflow';
    const { bot, model } = await newBot('Overflow', [
      [{ text: 'Hello there.' }],
      [{ text: 'Cleaning up.' }, { tool: 'bash', args: { command }, id: 'bash-Overflow' }],
      { error: new Error('prompt is too long: 250000 tokens > 200000 maximum') },
      [{ text: 'Build directory removed.' }],
    ]);
    // Without the Bot's greeting, so the old message is the oldest one.
    await t.db.delete(schema.messages).where(eq(schema.messages.chatId, bot.chatId));
    await say(bot, 'an old message the retry can drop');
    await settled(bot.id, 'completed');
    await say(bot, 'clean the build');
    const second = async () => (await runsOf(bot.id))[1]!;
    await until(async () => expect((await second()).status).toBe('waiting'));
    const run = await second();
    // The transcript part: the first message, the reply, the second message.
    expect((run.state as SerializedRunState).contextLength).toBe(3);
    const [approval] = await approvalsOf(run.id);
    const res = await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    await until(async () => expect((await second()).status).toBe('completed'));

    expect(ranFor('bash', command)).toHaveLength(1);
    expect(model.calls).toHaveLength(4);
    const retried = promptText(model.calls[3]!);
    expect(retried).not.toContain('an old message the retry can drop');
    expect(retried).toContain('clean the build');
    expect(retried).toContain('"stdout":"removed"');
    expect((await stepsOf(run.id)).map((s) => s.label)).toContain(
      'Context too long; retrying without the oldest 2 messages',
    );
  });

  it('denies through the widget action with a note, without running the tool', async () => {
    const { bot, model, run, asked, approval, command } = await askAndPause('Denied', [
      [{ text: 'Okay, leaving it.' }],
    ]);
    const res = await call('POST', `/messages/${asked.id}/widgets/2/action`, {
      action: { type: 'deny', note: 'we still need those files' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resumedRunId: run.id,
      widget: { state: { status: 'denied', note: 'we still need those files' } },
    });
    await settled(bot.id, 'completed');
    expect(ranFor('bash', command)).toEqual([]);
    const prompt = promptText(model.calls[1]!);
    expect(prompt).toContain('Denied by owner');
    expect(prompt).toContain('we still need those files');
    expect((await approvalsOf(run.id))[0]).toMatchObject({
      status: 'denied',
      decidedBy: ownerId,
    });
    // The stored widget keeps who decided and when, so a reload still says "Denied by you".
    const [stored] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, asked.id));
    expect(stored!.state).toMatchObject({
      status: 'denied',
      decidedBy: ownerId,
      decidedAt: expect.any(String),
    });
    expect((await auditOf(approval.id)).map((a) => a.action)).toEqual([
      'approval.requested',
      'approval.denied',
    ]);
    expect((await stepsOf(run.id)).map((s) => s.label)).toContain(`Denied: Running ${command}`);
    const resolved = proc.events.find(
      (e) => e.type === 'approval.resolved' && e.payload.approval.id === approval.id,
    );
    expect(resolved?.payload.approval).toMatchObject({
      status: 'denied',
      note: 'we still need those files',
    });
  });

  it('expires a request after OPENBOTS_APPROVAL_TTL_MINUTES when the operator sets it', async () => {
    const { processLimits } = t.deps.config;
    const enqueue = vi.spyOn(proc.infra.queue<ExpireJob>(APPROVALS_QUEUE), 'enqueue');
    t.deps.config.processLimits = { ...processLimits, approvalTtlMinutes: 5 };
    try {
      expect(approvalTtlMs(t.deps.config)).toBe(5 * 60_000);
      const { approval } = await askAndPause('ShortTtl', []);
      const ttl = approval.expiresAt!.getTime() - approval.createdAt.getTime();
      expect(Math.abs(ttl - 5 * 60_000)).toBeLessThan(60_000);
      // The expiry job is due when the row expires.
      const [, job, options] = enqueue.mock.calls.find(
        ([, job]) => job.approvalId === approval.id,
      )!;
      expect(job).toEqual({ approvalId: approval.id, workspaceId: approval.workspaceId });
      expect(options!.delayMs).toBeGreaterThan(4 * 60_000);
      expect(options!.delayMs).toBeLessThanOrEqual(5 * 60_000);
    } finally {
      t.deps.config.processLimits = processLimits;
      enqueue.mockRestore();
    }
  });

  it('expires an unanswered request after 24 hours and resumes with a denial', async () => {
    const { bot, model, run, asked, approval, command } = await askAndPause('Expired', [
      [{ text: 'No answer, so I left it.' }],
    ]);
    // Not due yet: nothing happens.
    expect(await expireApproval(proc.deps, approval.id)).toBe(false);
    await t.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.approvals.id, approval.id));
    expect(await inEveryOrganization(proc.deps, () => expireDueApprovals(proc.deps))).toBe(1);

    await settled(bot.id, 'completed');
    expect(ranFor('bash', command)).toEqual([]);
    expect(promptText(model.calls[1]!)).toContain('expired unanswered');
    expect((await approvalsOf(run.id))[0]).toMatchObject({ status: 'expired', decidedBy: null });
    const [widget] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, asked.id));
    expect(widget).toMatchObject({
      state: { status: 'expired', decidedBy: null, decidedAt: expect.any(String) },
      pendingRunId: null,
    });
    expect((await auditOf(approval.id)).map((a) => [a.action, a.actorType])).toEqual([
      ['approval.requested', 'bot'],
      ['approval.expired', 'system'],
    ]);
    expect((await stepsOf(run.id)).map((s) => s.label)).toContain(
      `Approval expired: Running ${command}`,
    );
    // Too late to decide.
    const late = await call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(late.status).toBe(409);
    expect(await expireApproval(proc.deps, approval.id)).toBe(false);
  });

  it('reads replies in the approval thread when the run resumes (C7)', async () => {
    const { bot, model, run, approval, asked } = await askAndPause('Threaded', [
      [{ text: 'Done, and I kept the cache.' }],
    ]);
    await say(bot, 'keep the .cache folder though', asked.id);
    // A thread reply on a pending request starts nothing; the run is still waiting.
    await new Promise((r) => setTimeout(r, 50));
    expect((await runsOf(bot.id)).map((r) => r.status)).toEqual(['waiting']);

    const res = await call('POST', `/approvals/${approval.id}/decide`, {
      decision: 'approve',
      note: 'go ahead',
    });
    expect(res.status).toBe(200);
    await settled(bot.id, 'completed');
    const prompt = promptText(model.calls[1]!);
    expect(prompt).toContain('Replies in the thread on your approval request');
    expect(prompt).toContain('keep the .cache folder though');
    expect(prompt).toContain('[note with the approval] go ahead');
    // The thread reply does not start a follow-up run after the resumed one.
    await new Promise((r) => setTimeout(r, 50));
    expect(await runsOf(bot.id)).toHaveLength(1);
    expect(run.id).toBe((await runsOf(bot.id))[0]!.id);
  });

  it('names the thread of a request made in a thread, for the notification (N1)', async () => {
    const command = 'rm -rf build-in-thread';
    const { bot } = await newBot('InThread', [
      [{ text: 'Root answer.' }],
      [{ text: 'Cleaning up.' }, { tool: 'bash', args: { command }, id: 'bash-thread' }],
    ]);
    await say(bot, 'start');
    await settled(bot.id, 'completed');
    const [root] = await botMessages(bot.chatId);
    await say(bot, 'clean the build', root!.id);
    await until(async () => expect((await runsOf(bot.id))[1]?.status).toBe('waiting'));
    const [approval] = await approvalsOf((await runsOf(bot.id))[1]!.id);
    const asked = (await botMessages(bot.chatId)).at(-1)!;
    expect(asked.threadRootId).toBe(root!.id);
    const requested = await until(() => {
      const event = proc.events.find(
        (e) => e.type === 'approval.requested' && e.payload.approval.id === approval!.id,
      );
      expect(event).toBeDefined();
      return event!;
    });
    expect(requested).toMatchObject({ seq: asked.seq, payload: { threadRootId: root!.id } });
  });

  it('follows the Bot tool policy: auto runs without asking, deny refuses and is audited', async () => {
    const auto = await newBot(
      'Trusted',
      [[{ tool: 'bash', args: { command: 'ls trusted' } }], [{ text: 'Listed.' }]],
      { tools: { bash: 'auto' } },
    );
    await say(auto.bot, 'list');
    await settled(auto.bot.id, 'completed');
    expect(ranFor('bash', 'ls trusted')).toHaveLength(1);

    const denied = await newBot(
      'Forbidden',
      [[{ tool: 'bash', args: { command: 'ls forbidden' } }], [{ text: 'Not allowed.' }]],
      { tools: { bash: 'deny' } },
    );
    await say(denied.bot, 'list');
    await settled(denied.bot.id, 'completed');
    expect(ranFor('bash', 'ls forbidden')).toEqual([]);
    expect(promptText(denied.model.calls[1]!)).toContain('Denied by Bot policy');
    const [run] = await runsOf(denied.bot.id);
    expect(await auditOf(run!.id)).toMatchObject([
      { action: 'tool.denied', metadata: { toolName: 'bash', reason: 'Bot setting for bash' } },
    ]);
  });

  it('sends an email draft through the policy: Send asks, approval sends once', async () => {
    const draft = { to: ['ada@example.com'], subject: 'Hello', body: 'Hi Ada' };
    const { bot, model } = await newBot('Mailer', [
      [{ tool: 'show_widget', args: { kind: 'email_draft', props: draft } }],
      [{ text: 'Here is a draft.' }],
      [{ text: 'Sent it.' }],
    ]);
    await say(bot, 'draft a hello to Ada');
    await settled(bot.id, 'completed');
    const [drafted] = await botMessages(bot.chatId);
    const partIndex = (drafted!.parts as MessagePart[]).findIndex((p) => p.type === 'widget');
    expect((drafted!.parts as MessagePart[])[partIndex]).toMatchObject({ kind: 'email_draft' });

    const res = await call('POST', `/messages/${drafted!.id}/widgets/${partIndex}/action`, {
      action: { type: 'send', subject: 'Hello there' },
    });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { startedRunId: string };
    expect(sent).toMatchObject({ widget: { state: { status: 'sending' } }, resumedRunId: null });

    // `send_email` asks by default: the widget_action run pauses before the model runs.
    await until(async () =>
      expect((await runsOf(bot.id)).find((r) => r.id === sent.startedRunId)?.status).toBe(
        'waiting',
      ),
    );
    expect(model.calls).toHaveLength(2);
    const [approval] = await approvalsOf(sent.startedRunId);
    expect(approval).toMatchObject({
      toolName: 'send_email',
      args: { to: ['ada@example.com'], subject: 'Hello there', body: 'Hi Ada' },
      status: 'pending',
    });
    const asked = (await botMessages(bot.chatId)).at(-1)!;
    expect((asked.parts as MessagePart[]).map((p) => p.type)).toEqual(['tool_call', 'widget']);
    expect(ranFor('send_email', 'Hello there')).toEqual([]);

    await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
    await until(async () =>
      expect((await runsOf(bot.id)).find((r) => r.id === sent.startedRunId)?.status).toBe(
        'completed',
      ),
    );
    expect(ranFor('send_email', 'Hello there')).toHaveLength(1);
    expect(promptText(model.calls[2]!)).toContain('"sent":true');
    const steps = await t.db
      .select()
      .from(schema.runSteps)
      .where(
        and(eq(schema.runSteps.runId, sent.startedRunId), eq(schema.runSteps.type, 'approval')),
      )
      .orderBy(asc(schema.runSteps.idx));
    expect(steps.map((s) => s.label)).toEqual([
      'Asked to approve: Send email',
      'Approved: Send email',
    ]);
  });
});
