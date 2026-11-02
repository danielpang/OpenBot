import { localEmbedder, SUMMARY_PROMPT } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import { EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import type { LanguageModel } from 'ai';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import type { Message } from '../schemas.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { createTestApp, isGreeting, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// Threads, Bot reactions and rolling chat summaries (C7, C8; plan 5.3, 18.6)
// end to end on a test database with recorded-provider doubles. The approval
// resume reading its thread is in approvals.test.ts.

interface Bot {
  id: string;
  chatId: string;
  handle: string;
}

describe('threads, reactions and chat summaries', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  const events: WsEvent[] = [];
  const models = new Map<string, RunModel>();
  const smallModels = new Map<string, LanguageModel>();

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks();
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    const worker = createRunWorker(t.deps, {
      resolveModel: async (_config, bot) => models.get(bot.id)!,
      smallModel: async (_config, bot) => smallModels.get(bot.id) ?? null,
      embedder: localEmbedder,
      // A short window so a few messages scroll out of it.
      historyWindow: 2,
      summaryBatch: 2,
    });
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(worker, { concurrency: 4 });
  });
  afterAll(async () => {
    unhook();
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
      description: `You are ${name}.`,
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
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

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });

  const runsOf = (botId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.botId, botId))
      .orderBy(asc(schema.runs.createdAt));

  const allDone = async (botId: string, count: number) => {
    const runs = await runsOf(botId);
    expect(runs).toHaveLength(count);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    return runs;
  };

  const messagesOf = (chatId: string) =>
    t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq));

  const chatOf = async (chatId: string) =>
    (await t.db.select().from(schema.chats).where(eq(schema.chats.id, chatId)))[0]!;

  it('answers a thread reply in the thread, reading the root, its replies and the summary', async () => {
    const { bot, model } = await newBot('Drafter', [
      [{ text: 'Here is draft A.' }],
      [{ text: 'Noon.' }],
      [{ text: 'Shorter draft A.' }],
    ]);
    await say(bot, 'Write draft A please');
    await until(() => allDone(bot.id, 1));
    await say(bot, 'Unrelated: what time is it?');
    await until(() => allDone(bot.id, 2));
    await t.db
      .update(schema.chats)
      .set({ summary: 'Dana is collecting drafts for the launch.', summaryThroughSeq: 0 })
      .where(eq(schema.chats.id, bot.chatId));

    const firstRun = (await runsOf(bot.id))[0]!;
    const root = (await messagesOf(bot.chatId)).find((m) => m.runId === firstRun.id)!;
    await say(bot, 'make it shorter', root.id);
    const runs = await until(() => allDone(bot.id, 3));
    expect(runs[2]!.trigger).toBe('message');

    // The thread run's prompt: the summary, the thread note, the root and the reply only.
    const prompt = promptText(model.calls[2]!);
    expect(prompt).toContain('Dana is collecting drafts for the launch.');
    expect(prompt).toContain('## This thread');
    expect(prompt).toContain('user: [system] The thread is on your message below.');
    expect(prompt).toContain('Here is draft A.');
    expect(prompt).toContain('[@dana (owner)] make it shorter');
    expect(prompt).not.toContain('what time is it');
    expect(prompt).not.toContain('Noon.');
    expect(prompt).not.toContain('Write draft A please');

    // The reply went into the thread, not the top level.
    const reply = (await messagesOf(bot.chatId)).find((m) => m.runId === runs[2]!.id)!;
    expect(reply).toMatchObject({ threadRootId: root.id, status: 'complete' });
    // The finished run points at its reply in the thread, for the notification (N1).
    expect(
      events.find(
        (e) =>
          e.type === 'run.status' &&
          e.payload.runId === runs[2]!.id &&
          e.payload.status === 'completed',
      ),
    ).toMatchObject({ seq: reply.seq, payload: { messageId: reply.id, threadRootId: root.id } });
    const top = await call('GET', `/chats/${bot.chatId}/messages`);
    const texts = ((await top.json()) as { messages: Message[] }).messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])),
    );
    expect(texts).not.toContain('Shorter draft A.');
    expect(texts).not.toContain('make it shorter');
  });

  it('keeps a thread reply away from a top-level run and a top-level message away from a thread run', async () => {
    const { bot, model } = await newBot('Splitter', [
      [{ text: 'Root answer.' }],
      [{ text: 'In the thread.' }],
      [{ text: 'At the top.' }],
    ]);
    await say(bot, 'start');
    await until(() => allDone(bot.id, 1));
    const root = (await messagesOf(bot.chatId)).find(
      (m) => m.authorType === 'bot' && !isGreeting(m),
    )!;
    await say(bot, 'thread question', root.id);
    await until(() => allDone(bot.id, 2));
    await say(bot, 'top question');
    await until(() => allDone(bot.id, 3));
    const top = promptText(model.calls[2]!);
    expect(top).toContain('top question');
    expect(top).not.toContain('thread question');
    expect(top).not.toContain('## This thread');
    const reply = (await messagesOf(bot.chatId)).at(-1)!;
    expect(reply.threadRootId).toBeNull();
  });

  it('reacts as the Bot and publishes reaction.added', async () => {
    const { bot } = await newBot('Reactor', [[{ tool: 'react', args: { emoji: '👍' } }], []]);
    const asked = await say(bot, 'Deployed the fix, no reply needed');
    await until(() => allDone(bot.id, 1));
    const rows = await t.db
      .select()
      .from(schema.reactions)
      .where(eq(schema.reactions.messageId, asked.id));
    expect(rows).toMatchObject([{ emoji: '👍', reactorType: 'bot', reactorId: bot.id }]);
    const event = events.find(
      (e) => e.type === 'reaction.added' && e.payload.messageId === asked.id,
    );
    expect(event).toMatchObject({
      chat_id: bot.chatId,
      seq: asked.seq,
      bot_id: bot.id,
      payload: { emoji: '👍', reactorType: 'bot', reactorId: bot.id },
    });
    const steps = await t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, (await runsOf(bot.id))[0]!.id));
    expect(steps.map((s) => s.label)).toContain('Reacted 👍');
  });

  it('rolls messages beyond the window into the chat summary and includes it in later runs', async () => {
    const { bot, model } = await newBot('Summer', [
      [{ text: 'One.' }],
      [{ text: 'Two.' }],
      [{ text: 'Three.' }],
    ]);
    const summaryCalls: string[] = [];
    const small: ScriptedTurn = (options) => {
      const text = promptText(options);
      if (!text.includes(SUMMARY_PROMPT.slice(0, 40))) return [{ text: '[]' }];
      summaryCalls.push(text);
      return [{ text: 'Dana counted to one with @summer.' }];
    };
    smallModels.set(bot.id, scriptedModel(Array.from({ length: 10 }, () => small)));
    // Without the Bot's greeting, so the window holds just this exchange.
    await t.db.delete(schema.messages).where(eq(schema.messages.chatId, bot.chatId));

    await say(bot, 'count one');
    await until(() => allDone(bot.id, 1));
    // Two messages fit the window: nothing to summarize yet.
    expect((await chatOf(bot.chatId)).summary).toBeNull();

    await say(bot, 'count two');
    await until(() => allDone(bot.id, 2));
    const [first, firstReply] = await messagesOf(bot.chatId);
    await until(async () =>
      expect(await chatOf(bot.chatId)).toMatchObject({
        summary: 'Dana counted to one with @summer.',
        summaryThroughSeq: firstReply!.seq,
      }),
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]).toContain('[@dana (owner)] count one');
    expect(summaryCalls[0]).toContain(
      '[@summer (bot)] <bot_message from="summer">\nOne.\n</bot_message>',
    );
    expect(summaryCalls[0]).not.toContain('count two');
    expect(first!.seq).toBeLessThan(firstReply!.seq);

    await say(bot, 'count three');
    await until(() => allDone(bot.id, 3));
    const prompt = promptText(model.calls[2]!);
    expect(prompt).toContain('## Earlier in this chat\nDana counted to one with @summer.');
    expect(prompt).not.toContain('count one');
  });
});
