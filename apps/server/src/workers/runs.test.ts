import { INTERRUPTED_RESULT, localEmbedder } from '@openbots/agent';
import {
  promptText,
  scriptedModel,
  type ScriptedModel,
  type ScriptedTurn,
} from '@openbots/agent/testing';
import type { ProviderModel } from '@openbots/models';
import {
  DEFAULT_CAPABILITIES,
  EVENTS_CHANNEL,
  type MessagePart,
  type WsEvent,
} from '@openbots/shared';
import type { LanguageModel } from 'ai';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { createInfra } from '../infra/index.js';
import type { Message } from '../schemas.js';
import { postUserMessage } from '../services/messages.js';
import {
  enqueueRun,
  registerRunHooks,
  RUNS_QUEUE,
  type RunJob,
  type RunState,
} from '../services/runs.js';
import { createTestApp, isGreeting, type TestApp } from '../test-app.js';
import {
  createRunWorker,
  MAX_TAKEOVERS,
  recoverInterruptedRuns,
  RESTART_NOTE,
  type RunModel,
  type RunWorkerOptions,
} from './runs.js';
import { inEveryOrganization } from '../workers.js';

// The run worker end to end on a test database, with a recorded-provider
// double in place of the model (plan 18.2 "recorded-provider double").

interface Bot {
  id: string;
  chatId: string;
  handle: string;
}

describe('run worker', () => {
  let t: TestApp;
  let cookie: string;
  let owner: { id: string; workspaceId: string };
  let unhook: () => void;
  const events: WsEvent[] = [];
  const models = new Map<string, RunModel>();
  const smallModels = new Map<string, LanguageModel>();
  const embedHooks = new Map<string, (texts: string[]) => Promise<void>>();
  const blockers = new Map<string, Promise<void>>();
  const started: string[] = [];

  // One worker options object per "process"; scripted models and test hooks are per Bot.
  const optionsFor = (): RunWorkerOptions => ({
    resolveModel: async (_config, bot) => {
      started.push(bot.id);
      await blockers.get(bot.id);
      const model = models.get(bot.id);
      if (!model) throw new Error(`no scripted model for ${bot.handle}`);
      return model;
    },
    smallModel: async (_config, bot) => smallModels.get(bot.id) ?? null,
    embedder: {
      id: 'test',
      embed: async (texts) => {
        for (const hook of embedHooks.values()) await hook(texts);
        return localEmbedder.embed(texts);
      },
    },
  });

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    const [user] = await t.db.select().from(schema.users);
    const [member] = await t.db.select().from(schema.workspaceMembers);
    owner = { id: user!.id, workspaceId: member!.workspaceId };
    unhook = registerRunHooks();
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(t.deps, optionsFor()), {
      concurrency: 4,
    });
  });
  afterAll(async () => {
    unhook();
    await t.close();
  });

  function call(method: string, path: string, body?: unknown, app = t.app) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function newBot(name: string, turns: ScriptedTurn[], info: ProviderModel | null = null) {
    const res = await call('POST', '/bots', {
      name,
      description: `You are ${name}.`,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info, providerOptions: {} });
    return { bot, model };
  }

  const say = async (bot: Bot, text: string) => {
    const res = await call('POST', `/chats/${bot.chatId}/messages`, { text });
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

  const botMessages = async (chatId: string) =>
    (
      await t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chatId))
        .orderBy(asc(schema.messages.seq))
    ).filter((m) => m.authorType !== 'user' && !isGreeting(m));

  const statesOf = (botId: string, from: WsEvent[] = events) =>
    from
      .filter((e) => e.type === 'bot.state' && e.bot_id === botId)
      .map((e) => e.payload as { state: string; currentAction: string | null })
      .map((p) => (p.currentAction ? `${p.state}:${p.currentAction}` : p.state));

  // The worker publishes the Bot's closing state (and the events of the rows
  // it committed with the status) after the run's status, so a test that
  // reads the events waits for both.
  const settled = (botId: string, status: string, from: WsEvent[] = events) =>
    until(async () => {
      expect((await runsOf(botId))[0]?.status).toBe(status);
      expect(statesOf(botId, from).at(-1)).toMatch(/^(done|waiting|blocked|idle)\b/);
    });

  const stepsOf = (runId: string) =>
    t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(asc(schema.runSteps.idx));

  /** A scripted model whose first call waits, before it streams anything, until `release`. */
  function stalledFirstCall(turns: ScriptedTurn[]) {
    const model = scriptedModel(turns);
    const play = model.doStream.bind(model);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    model.doStream = async (options) => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return play(options);
    };
    return { model, release, entered: () => entered };
  }

  const deletedIn = (chatId: string, from: WsEvent[] = events) =>
    from.filter(
      (e): e is Extract<WsEvent, { type: 'message.deleted' }> =>
        e.type === 'message.deleted' && e.chat_id === chatId,
    );

  it('streams a prose reply, finalizes it and records usage', async () => {
    const { bot, model } = await newBot(
      'Prose',
      [[{ text: 'Hello Dana, how can I help today?' }]],
      {
        providerId: 'p',
        modelId: 'scripted',
        displayName: 'Scripted',
        capabilities: DEFAULT_CAPABILITIES,
        pricing: { input: 3, output: 15 },
        enabled: true,
      },
    );
    await say(bot, 'hi there');
    await settled(bot.id, 'completed');

    const [run] = await runsOf(bot.id);
    expect(run).toMatchObject({ trigger: 'message', priority: 1, model: 'scripted' });
    expect(run!.usage).toEqual({
      inputTokens: 101,
      outputTokens: 10,
      cachedInputTokens: 0,
      steps: 1,
      costUsd: (101 * 3 + 10 * 15) / 1_000_000,
    });
    const [reply] = await botMessages(bot.chatId);
    expect(reply).toMatchObject({ status: 'complete', runId: run!.id, authorId: bot.id });
    expect(reply!.parts).toEqual([{ type: 'text', text: 'Hello Dana, how can I help today?' }]);

    const forMessage = events.filter(
      (e) =>
        (e.type === 'message.created' && e.payload.message.id === reply!.id) ||
        ((e.type === 'message.delta' || e.type === 'message.completed') &&
          e.payload.messageId === reply!.id),
    );
    expect(forMessage[0]!.type).toBe('message.created');
    expect(forMessage.at(-1)).toMatchObject({
      type: 'message.completed',
      payload: { status: 'complete', usage: { inputTokens: 101, outputTokens: 10 } },
    });
    expect(statesOf(bot.id)).toEqual(['thinking', 'done']);

    // The run's statuses carry its timing, and the ended one its last message (N1).
    const statuses = events.filter((e) => e.type === 'run.status' && e.payload.runId === run!.id);
    expect(statuses.map((e) => e.payload.status)).toEqual(['queued', 'running', 'completed']);
    expect(statuses[0]!.payload).toMatchObject({ trigger: 'message', startedAt: null });
    expect(statuses[0]!.seq).toBeUndefined();
    expect(statuses.at(-1)).toMatchObject({
      seq: reply!.seq,
      chat_id: bot.chatId,
      payload: {
        trigger: 'message',
        startedAt: run!.startedAt!.toISOString(),
        finishedAt: run!.finishedAt!.toISOString(),
        messageId: reply!.id,
        threadRootId: null,
      },
    });

    // The prompt: standing rules and the owner's message with its author prefix.
    const prompt = model.calls[0]!.prompt;
    expect(prompt[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(prompt[0])).toContain('You are Prose.');
    expect(promptText(model.calls[0]!)).toContain('user: [@dana (owner)] hi there');

    const steps = await call('GET', `/runs/${run!.id}/steps`);
    expect(((await steps.json()) as { items: { label: string }[] }).items).toEqual([
      expect.objectContaining({
        type: 'llm',
        label: 'Thought briefly',
        tokensIn: 101,
        tokensOut: 10,
      }),
    ]);
    const got = await call('GET', `/runs/${run!.id}`);
    expect(await got.json()).toMatchObject({ id: run!.id, status: 'completed', waiting: null });
  });

  it('reads its greeting as its own first message when the owner answers it', async () => {
    const { bot, model } = await newBot('Greeter', [[{ text: 'Noted, competitors it is.' }]]);
    await say(bot, 'Watch our competitors.');
    await settled(bot.id, 'completed');
    expect(promptText(model.calls[0]!)).toContain(
      [
        'user: [system] The conversation below opens with your message.',
        "assistant: Hi, I'm Greeter. What would you like me to work on?",
        'user: [@dana (owner)] Watch our competitors.',
      ].join('\n'),
    );
  });

  it('sets working while a tool runs and records a labeled step', async () => {
    const { bot } = await newBot('Tooly', [
      [{ tool: 'remember', args: { kind: 'preference', content: 'Prefers tabs' } }],
      [{ text: 'Got it.' }],
    ]);
    await say(bot, 'I prefer tabs');
    await settled(bot.id, 'completed');
    const [run] = await runsOf(bot.id);
    expect(statesOf(bot.id)).toEqual([
      'thinking',
      "working:Remembering 'Prefers tabs'",
      'thinking',
      'done',
    ]);
    expect((await stepsOf(run!.id)).map((s) => [s.type, s.label])).toEqual([
      ['llm', 'Thought briefly'],
      ['tool_call', "Remembered 'Prefers tabs'"],
      ['llm', 'Thought briefly'],
    ]);
    const memories = await t.db
      .select()
      .from(schema.botMemories)
      .where(eq(schema.botMemories.botId, bot.id));
    expect(memories).toMatchObject([
      { kind: 'preference', content: 'Prefers tabs', sourceRunId: run!.id },
    ]);
    expect(memories[0]!.embedding).toHaveLength(1536);
    const [reply] = await botMessages(bot.chatId);
    expect((reply!.parts as MessagePart[]).map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
      'text',
    ]);
  });

  async function askAndPause(name: string, after: ScriptedTurn[]) {
    const question = {
      question: 'Which repo?',
      options: [
        { id: 'a', label: 'openbots' },
        { id: 'b', label: 'website' },
      ],
    };
    const { bot, model } = await newBot(name, [
      [{ text: 'Let me check.' }, { tool: 'ask_user', args: question, id: `ask-${name}` }],
      ...after,
    ]);
    await say(bot, 'fix the bug');
    await settled(bot.id, 'waiting');
    const [run] = await runsOf(bot.id);
    const [asked] = await botMessages(bot.chatId);
    return { bot, model, run: run!, asked: asked! };
  }

  it('pauses on ask_user and resumes with the answer', async () => {
    const { bot, model, run, asked } = await askAndPause('Asker', [
      [{ text: 'On it, in openbots.' }],
    ]);
    expect(asked.status).toBe('complete');
    const parts = asked.parts as MessagePart[];
    expect(parts[2]).toMatchObject({ type: 'widget', kind: 'question' });
    expect(statesOf(bot.id).at(-1)).toBe('waiting:Waiting for your answer');
    const [widget] = await t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, asked.id));
    expect(widget).toMatchObject({
      partIndex: 2,
      pendingRunId: run.id,
      state: { status: 'pending' },
    });
    expect(run.state).toMatchObject({
      version: 1,
      pending: { reason: 'question', toolCallId: 'ask-Asker' },
    });
    expect(await (await call('GET', `/runs/${run.id}`)).json()).toMatchObject({
      status: 'waiting',
      waiting: { reason: 'question', messageId: asked.id, partIndex: 2 },
    });

    // An invalid action is refused against the kind's schema.
    const bad = await call('POST', `/messages/${asked.id}/widgets/2/action`, {
      action: { type: 'nod' },
    });
    expect(bad.status).toBe(400);
    expect(
      (await call('POST', `/messages/${asked.id}/widgets/0/action`, { action: {} })).status,
    ).toBe(404);

    const res = await call('POST', `/messages/${asked.id}/widgets/2/action`, {
      action: { type: 'answer', option_id: 'a' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resumedRunId: run.id,
      widget: { state: { status: 'answered', answer: { option_id: 'a', label: 'openbots' } } },
    });
    await settled(bot.id, 'completed');
    expect(await runsOf(bot.id)).toHaveLength(1);
    expect(promptText(model.calls[1]!)).toContain('"label":"openbots"');
    const replies = await botMessages(bot.chatId);
    expect(replies.at(-1)!.parts).toEqual([{ type: 'text', text: 'On it, in openbots.' }]);
    expect(statesOf(bot.id).slice(-2)).toEqual(['thinking', 'done']);
    // A second answer is refused.
    const again = await call('POST', `/messages/${asked.id}/widgets/2/action`, {
      action: { type: 'answer', option_id: 'b' },
    });
    expect(again.status).toBe(409);
  });

  it('resumes after the worker is recreated between pause and resume', async () => {
    const { bot, run, asked } = await askAndPause('Restart', [
      [{ text: 'Resumed after restart.' }],
    ]);

    // A "new process": fresh queues and bus, a fresh worker, nothing in memory.
    const infra = createInfra(t.deps.config);
    const deps2: AppDeps = { ...t.ownerDeps, infra };
    const app2 = createApp(deps2, { webDist: '' });
    const seen: WsEvent[] = [];
    await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => seen.push(e));
    await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps2, optionsFor()));
    try {
      const res = await call(
        'POST',
        `/messages/${asked.id}/widgets/2/action`,
        { action: { type: 'answer', text: 'the website one' } },
        app2,
      );
      expect(res.status).toBe(200);
      await settled(bot.id, 'completed', seen);
      const model = models.get(bot.id)!.model as ScriptedModel;
      expect(promptText(model.calls[1]!)).toContain('"text":"the website one"');
      expect((await botMessages(bot.chatId)).at(-1)!.parts).toEqual([
        { type: 'text', text: 'Resumed after restart.' },
      ]);
      expect(seen.some((e) => e.type === 'run.status' && e.payload.runId === run.id)).toBe(true);
    } finally {
      await infra.close();
    }
  });

  it('takes a typed reply as the answer to a pending question', async () => {
    const { bot, model } = await askAndPause('Typed', [[{ text: 'Thanks.' }]]);
    await say(bot, 'website please');
    await settled(bot.id, 'completed');
    expect(await runsOf(bot.id)).toHaveLength(1);
    expect(promptText(model.calls[1]!)).toContain('"text":"website please"');
  });

  it('injects an owner message between steps (steering)', async () => {
    let botRef: Bot | null = null;
    const { bot, model } = await newBot('Steer', [
      [{ tool: 'remember', args: { kind: 'fact', content: 'Uses red' } }],
      [{ text: 'Switching to blue.' }],
    ]);
    botRef = bot;
    let posted = false;
    embedHooks.set(bot.id, async (texts) => {
      // While the remember tool runs, the owner sends another message.
      if (posted || !botRef || texts[0] !== 'Uses red') return;
      posted = true;
      await postUserMessage(t.ownerDeps, owner, botRef.chatId, { text: 'actually, use blue' });
    });
    try {
      await say(bot, 'paint it red');
      await settled(bot.id, 'completed');
    } finally {
      embedHooks.delete(bot.id);
    }
    const runs = await runsOf(bot.id);
    expect(runs).toHaveLength(1);
    const steps = await stepsOf(runs[0]!.id);
    expect(steps.map((s) => s.type)).toEqual(['llm', 'tool_call', 'steer', 'llm']);
    expect(steps[2]!.label).toBe('Steered: actually, use blue');
    expect(promptText(model.calls[1]!)).toMatch(/\[@dana \(owner\)\] actually, use blue$/);
  });

  it('cancels a running run', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const { bot } = await newBot('Cancel', []);
    models.set(bot.id, {
      model: scriptedModel([[{ text: long }]], { chunkDelayMs: 5 }),
      info: null,
      providerOptions: {},
    });
    await say(bot, 'write a lot');
    await until(async () => {
      const [run] = await runsOf(bot.id);
      expect(run?.status).toBe('running');
      expect(events.some((e) => e.type === 'message.delta' && e.bot_id === bot.id)).toBe(true);
    });
    const [run] = await runsOf(bot.id);
    const res = await call('POST', `/runs/${run!.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled' });
    await until(async () => {
      const [reply] = await botMessages(bot.chatId);
      expect(reply?.status).toBe('complete');
      expect(statesOf(bot.id).at(-1)).toBe('idle');
    });
    const [reply] = await botMessages(bot.chatId);
    const text = (reply!.parts as MessagePart[]).find((p) => p.type === 'text');
    expect(text && 'text' in text ? text.text.length : 0).toBeLessThan(long.length);
    expect((await runsOf(bot.id))[0]!.status).toBe('cancelled');
    // Cancelling again returns the finished run unchanged.
    expect(await (await call('POST', `/runs/${run!.id}/cancel`)).json()).toMatchObject({
      status: 'cancelled',
    });
  });

  it('cancels a run before it streams anything, leaving no empty reply', async () => {
    const stalled = stalledFirstCall([[{ text: 'Too late.' }]]);
    const { bot } = await newBot('Hesitant', []);
    models.set(bot.id, { model: stalled.model, info: null, providerOptions: {} });
    try {
      await say(bot, 'hi');
      await until(async () => {
        expect(stalled.entered()).toBe(true);
        expect((await botMessages(bot.chatId)).map((m) => m.status)).toEqual(['streaming']);
      });
      const [pending] = await botMessages(bot.chatId);
      const [run] = await runsOf(bot.id);
      expect((await call('POST', `/runs/${run!.id}/cancel`)).status).toBe(200);
      stalled.release();
      await until(async () => {
        expect(await botMessages(bot.chatId)).toEqual([]);
        expect(statesOf(bot.id).at(-1)).toBe('idle');
      });
      expect(deletedIn(bot.chatId).map((e) => e.payload.messageId)).toEqual([pending!.id]);
      expect((await runsOf(bot.id))[0]!.status).toBe('cancelled');
    } finally {
      stalled.release();
    }
  });

  it('runs a Bot’s queued runs by priority, then age', async () => {
    const { bot } = await newBot('Busy', [
      [{ text: 'first' }],
      [{ text: 'second' }],
      [{ text: 'third' }],
    ]);
    let release: () => void = () => {};
    blockers.set(bot.id, new Promise<void>((resolve) => (release = resolve)));
    const at = started.length;
    const first = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    await until(() => expect(started.slice(at)).toEqual([bot.id]));
    const routine = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'routine',
    });
    const webhook = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'webhook',
    });
    const message = await enqueueRun(t.ownerDeps, {
      botId: bot.id,
      chatId: bot.chatId,
      trigger: 'message',
    });
    expect([routine.priority, webhook.priority, message.priority]).toEqual([3, 2, 1]);
    blockers.delete(bot.id);
    release();
    await until(async () =>
      expect((await runsOf(bot.id)).every((r) => r.status === 'completed')).toBe(true),
    );
    const order = (await runsOf(bot.id))
      .sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime())
      .map((r) => r.id);
    expect(order).toEqual([first.id, message.id, webhook.id, routine.id]);
  });

  it('extracts memories after a run and includes them in the next context', async () => {
    const { bot, model } = await newBot('Memo', [[{ text: 'Sure.' }], [{ text: 'Short it is.' }]]);
    smallModels.set(
      bot.id,
      scriptedModel([
        [{ text: '[{"kind":"preference","content":"Dana wants answers under three lines"}]' }],
        [{ text: '[]' }],
      ]),
    );
    await say(bot, 'keep answers under three lines');
    await until(async () => {
      const rows = await t.db
        .select()
        .from(schema.botMemories)
        .where(eq(schema.botMemories.botId, bot.id));
      expect(rows.map((r) => r.content)).toEqual(['Dana wants answers under three lines']);
    });
    await say(bot, 'what is 2+2?');
    await until(async () => expect(model.calls).toHaveLength(2));
    expect(JSON.stringify(model.calls[1]!.prompt[1])).toContain(
      '[preference] Dana wants answers under three lines',
    );
    const res = await call('GET', `/bots/${bot.id}/memories`);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('posts a blocked event instead of running a model without tool calling', async () => {
    const { bot, model } = await newBot('NoTools', [[{ text: 'never' }]], {
      providerId: 'p',
      modelId: 'scripted',
      displayName: 'Scripted',
      capabilities: { ...DEFAULT_CAPABILITIES, tools: false },
      pricing: null,
      enabled: true,
    });
    await say(bot, 'hello?');
    await settled(bot.id, 'failed');
    expect(model.calls).toHaveLength(0);
    const [event] = await botMessages(bot.chatId);
    expect(event).toMatchObject({ authorType: 'system', status: 'complete' });
    expect(event!.parts).toEqual([
      expect.objectContaining({
        type: 'event',
        kind: 'blocked',
        text: expect.stringContaining('does not support tool calling'),
      }),
    ]);
    expect(statesOf(bot.id).at(-1)).toMatch(/^blocked:/);
  });

  it('fails a run whose model errors: message failed, event row, Bot blocked', async () => {
    const { bot } = await newBot('Broken', [{ error: new Error('boom') }]);
    await say(bot, 'hi');
    await settled(bot.id, 'failed');
    const [failed, event] = await botMessages(bot.chatId);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(event!.parts).toEqual([
      expect.objectContaining({ type: 'event', kind: 'blocked', text: "Couldn't finish: boom" }),
    ]);
    expect((await runsOf(bot.id))[0]!.error).toBe('boom');
    expect(statesOf(bot.id).at(-1)).toBe('blocked:Run failed');
  });

  // Mid-run recovery (K4): a "crash" is a worker stuck inside a tool while a
  // fresh process takes the run over.
  it('continues a run whose worker died mid-tool, and never runs the cut-off call twice', async () => {
    const content = 'The launch moved to Friday';
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    let saves = 0;
    embedHooks.set('crash', async (texts) => {
      if (!texts.includes(content)) return;
      saves += 1;
      await stuck;
    });
    const { bot, model } = await newBot('Crashy', [
      [{ text: 'Noting that. ' }, { tool: 'remember', args: { kind: 'fact', content }, id: 'r1' }],
      [{ text: 'Picking up where I left off.' }],
    ]);
    await say(bot, 'the launch moved');
    await until(async () => {
      const state = (await runsOf(bot.id))[0]!.state as RunState;
      expect(state.checkpoint?.calls).toMatchObject([{ toolCallId: 'r1' }]);
      expect(state.checkpoint?.calls[0]!.output).toBeUndefined();
      // A takeover that overflows may cut only this many leading messages (plan 5.7):
      // the opening line, the Bot's greeting and the owner's message.
      expect(state.checkpoint?.contextLength).toBe(3);
    });
    const [run] = await runsOf(bot.id);

    const warn = vi.spyOn(t.deps.logger, 'warn');
    const infra = createInfra(t.deps.config);
    const deps2: AppDeps = { ...t.ownerDeps, infra };
    const events2: WsEvent[] = [];
    await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events2.push(e));
    try {
      await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps2, optionsFor()));
      expect(await inEveryOrganization(deps2, () => recoverInterruptedRuns(deps2))).toBe(1);
      await until(async () => expect((await runsOf(bot.id))[0]!.status).toBe('completed'));

      // The model is told the call's outcome is unknown; the call did not run again.
      expect(promptText(model.calls[1]!)).toContain(INTERRUPTED_RESULT.message);
      expect(saves).toBe(1);
      const [first, second] = await botMessages(bot.chatId);
      expect(first).toMatchObject({ status: 'complete' });
      expect((first!.parts as MessagePart[]).map((p) => p.type)).toEqual(['text', 'tool_call']);
      expect(second!.parts).toEqual([{ type: 'text', text: 'Picking up where I left off.' }]);
      const done = (await runsOf(bot.id))[0]!;
      expect(done.state).toBeNull();
      // The cut-off step never reported its usage, so only the step after the takeover counts.
      expect(done.usage).toMatchObject({ steps: 1 });
      expect((await stepsOf(run!.id)).map((s) => s.label)).toContain(RESTART_NOTE);

      // The old worker comes back, finds the run is no longer its own, and stops.
      release();
      await until(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ runId: run!.id }),
          expect.stringContaining('taken over'),
        ),
      );
      expect((await runsOf(bot.id))[0]).toMatchObject({ status: 'completed', state: null });
      expect(await botMessages(bot.chatId)).toHaveLength(2);
      // What the old worker streamed stays, closed; nothing was deleted.
      expect(deletedIn(bot.chatId, [...events, ...events2])).toEqual([]);
    } finally {
      release();
      embedHooks.delete('crash');
      warn.mockRestore();
      await infra.close();
    }
  });

  it('starts a run left queued by a restart, as the only process (K4)', async () => {
    const { bot } = await newBot('Queued', [[{ text: 'Back after the restart.' }]]);
    // Queued, but its in-memory job went away with the process that queued it.
    const chatId = bot.chatId;
    const [run] = await t.db
      .insert(schema.runs)
      .values({
        workspaceId: (await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id)))[0]!
          .workspaceId,
        botId: bot.id,
        chatId,
        trigger: 'message',
        priority: 1,
      })
      .returning();
    expect(run!.status).toBe('queued');

    const infra = createInfra(t.deps.config);
    const deps2: AppDeps = { ...t.ownerDeps, infra };
    try {
      await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps2, optionsFor()));
      expect(
        await inEveryOrganization(deps2, () => recoverInterruptedRuns(deps2)),
      ).toBeGreaterThanOrEqual(1);
      await until(async () => expect((await runsOf(bot.id))[0]!.status).toBe('completed'));
      expect((await botMessages(chatId)).at(-1)!.parts).toEqual([
        { type: 'text', text: 'Back after the restart.' },
      ]);
    } finally {
      await infra.close();
    }
  });

  it('starts a run again that crashed before its first step, and fails one that keeps crashing', async () => {
    const { bot } = await newBot('Again', [[{ text: 'Hello again.' }]]);
    let release!: () => void;
    blockers.set(bot.id, new Promise<void>((resolve) => (release = resolve)));
    await say(bot, 'hi');
    await until(() => expect(started).toContain(bot.id));
    const [run] = await runsOf(bot.id);
    expect(run!.status).toBe('running');
    blockers.delete(bot.id);

    const warn = vi.spyOn(t.deps.logger, 'warn');
    const infra = createInfra(t.deps.config);
    const deps2: AppDeps = { ...t.ownerDeps, infra };
    try {
      await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps2, optionsFor()));
      await inEveryOrganization(deps2, () => recoverInterruptedRuns(deps2));
      await until(async () => expect((await runsOf(bot.id))[0]!.status).toBe('completed'));
      expect((await botMessages(bot.chatId)).at(-1)!.parts).toEqual([
        { type: 'text', text: 'Hello again.' },
      ]);

      // A run already taken over MAX_TAKEOVERS times fails instead.
      await t.db
        .update(schema.runs)
        .set({ status: 'running', state: { takeovers: MAX_TAKEOVERS } })
        .where(eq(schema.runs.id, run!.id));
      await inEveryOrganization(deps2, () => recoverInterruptedRuns(deps2));
      await until(async () => expect((await runsOf(bot.id))[0]!.status).toBe('failed'));
      expect((await runsOf(bot.id))[0]!.error).toBe('The run was interrupted by a server restart');

      // The first worker wakes up, finds the run is not its own, and stops,
      // closing the message it opened. It logs before closing it, so wait for
      // both: on Postgres the check can overtake the close (PGlite runs one
      // query at a time, in order).
      // It streamed only an empty text part, so its message is deleted, not left empty.
      release();
      await until(async () => {
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ runId: run!.id }),
          expect.stringContaining('taken over'),
        );
        expect((await botMessages(bot.chatId)).every((m) => m.status !== 'streaming')).toBe(true);
        expect(deletedIn(bot.chatId)).toHaveLength(1);
      });
      expect((await runsOf(bot.id))[0]!.status).toBe('failed');
      const left = await botMessages(bot.chatId);
      expect(left.map((m) => m.authorType)).toEqual(['bot', 'system']);
      expect(left[0]!.parts).toEqual([{ type: 'text', text: 'Hello again.' }]);
    } finally {
      release();
      warn.mockRestore();
      await infra.close();
    }
  });

  it('deletes the message of a worker that lost its run before streaming anything (K4)', async () => {
    // The first call stalls; the new worker's call plays the first turn, and
    // the old worker's, once released, the empty second.
    const stalled = stalledFirstCall([[{ text: 'Fresh reply.' }], []]);
    const { bot } = await newBot('Stalled', []);
    models.set(bot.id, { model: stalled.model, info: null, providerOptions: {} });
    await say(bot, 'hi');
    await until(async () => {
      expect(stalled.entered()).toBe(true);
      expect((await botMessages(bot.chatId)).map((m) => m.status)).toEqual(['streaming']);
    });
    const [abandoned] = await botMessages(bot.chatId);
    const [run] = await runsOf(bot.id);

    const warn = vi.spyOn(t.deps.logger, 'warn');
    const error = vi.spyOn(t.deps.logger, 'error');
    const infra = createInfra(t.deps.config);
    const deps2: AppDeps = { ...t.ownerDeps, infra };
    const events2: WsEvent[] = [];
    await infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events2.push(e));
    try {
      await infra.queue<RunJob>(RUNS_QUEUE).process(createRunWorker(deps2, optionsFor()));
      await inEveryOrganization(deps2, () => recoverInterruptedRuns(deps2));
      await until(async () => expect((await runsOf(bot.id))[0]!.status).toBe('completed'));

      // The takeover deleted the empty message and said so; the new reply stays.
      const [reply, ...rest] = await botMessages(bot.chatId);
      expect(rest).toEqual([]);
      expect(reply).toMatchObject({ status: 'complete', runId: run!.id });
      expect(reply!.id).not.toBe(abandoned!.id);
      expect(reply!.parts).toEqual([{ type: 'text', text: 'Fresh reply.' }]);
      expect(deletedIn(bot.chatId, events2)).toEqual([
        expect.objectContaining({
          chat_id: bot.chatId,
          bot_id: bot.id,
          seq: abandoned!.seq,
          payload: { messageId: abandoned!.id, chatId: bot.chatId, threadRootId: null },
        }),
      ]);
      const [record] = await t.db
        .select()
        .from(schema.messageDeletions)
        .where(eq(schema.messageDeletions.messageId, abandoned!.id));
      expect(record).toMatchObject({ chatId: bot.chatId, messageSeq: abandoned!.seq });

      // The old worker's model call returns at last. Its message is gone, so it
      // gives up (a log line about the run) and leaves the run and transcript be.
      stalled.release();
      await until(() => {
        expect(stalled.model.calls).toHaveLength(2);
        const logged = [...warn.mock.calls, ...error.mock.calls].map(([fields]) => fields);
        expect(logged).toContainEqual(expect.objectContaining({ runId: run!.id }));
      });
      expect(await botMessages(bot.chatId)).toEqual([reply]);
      expect(deletedIn(bot.chatId, [...events, ...events2])).toHaveLength(1);
      expect((await runsOf(bot.id))[0]!.status).toBe('completed');
    } finally {
      stalled.release();
      warn.mockRestore();
      error.mockRestore();
      await infra.close();
    }
  });
});
