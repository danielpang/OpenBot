import { asEvaluation, localEmbedder } from '@openbots/agent';
import { promptText, scriptedModel, type ScriptedTurn } from '@openbots/agent/testing';
import type { MessagePart } from '@openbots/shared';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import type { Message } from '../schemas.js';
import { loadRunPolicy, runSource } from '../services/policy.js';
import { registerRunHooks, RUNS_QUEUE, type RunJob } from '../services/runs.js';
import { postMessage } from '../services/messages.js';
import { routeMessage, type RouterOptions } from '../services/router.js';
import { createTestApp, isGreeting, type TestApp } from '../test-app.js';
import { createRunWorker, type RunModel } from './runs.js';

// Group chats and Bot to Bot end to end (plan 7, 18.6): the hook routes owner
// messages, the worker routes Bot replies and `message_bot`, the loop guards
// stop ping-pongs. Bots reply through the recorded-provider double and
// `shouldReply` runs on a mocked small model.

interface Bot {
  id: string;
  chatId: string;
  handle: string;
}

interface Chat {
  id: string;
  type: string;
  botIds: string[];
  botId: string | null;
  peerBotId: string | null;
}

describe('router', () => {
  let t: TestApp;
  let cookie: string;
  let unhook: () => void;
  /** Run jobs in progress; a job routes its reply after the run's status is written. */
  let busy = 0;
  const models = new Map<string, RunModel>();
  /** Bots whose `shouldReply` says yes. */
  const willing = new Set<string>();
  /** Bots whose small model fails. */
  const broken = new Set<string>();
  const asked: string[] = [];
  /** Called with every embedding request; lets a test act while a tool runs. */
  const embedHooks = new Map<string, (texts: string[]) => Promise<void>>();

  const replyModel = (botId: string): LanguageModel =>
    new MockLanguageModelV4({
      doGenerate: async () => {
        asked.push(botId);
        if (broken.has(botId)) throw new Error('model not found');
        const reply = willing.has(botId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ reply, reason: 'test' }) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  const router: RouterOptions = { replyModel: async (bot) => replyModel(bot.id) };

  beforeAll(async () => {
    // One account makes every Bot in this file, more than the default 50.
    t = await createTestApp({
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_LIMITS_BOTS_PER_ACCOUNT: '200',
    });
    cookie = (await t.signUp('dana@example.com')).cookie!;
    unhook = registerRunHooks(router);
    const worker = createRunWorker(t.deps, {
      resolveModel: async (_config, bot) => {
        const model = models.get(bot.id);
        if (!model) throw new Error(`no scripted model for ${bot.handle}`);
        return model;
      },
      smallModel: async () => null,
      embedder: {
        id: 'test',
        embed: async (texts) => {
          for (const hook of embedHooks.values()) await hook(texts);
          return localEmbedder.embed(texts);
        },
      },
      router,
    });
    await t.deps.infra.queue<RunJob>(RUNS_QUEUE).process(
      async (job) => {
        busy++;
        try {
          await worker(job);
        } finally {
          busy--;
        }
      },
      { concurrency: 4 },
    );
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

  async function newBot(
    name: string,
    turns: ScriptedTurn[] = [],
    label?: string,
    toolPolicy?: unknown,
  ) {
    const res = await call('POST', '/bots', {
      name,
      description: `You are ${name}.`,
      ...(label ? { label } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    const bot = (await res.json()) as Bot;
    const model = scriptedModel(turns);
    models.set(bot.id, { model, info: null, providerOptions: {} });
    return { bot, model };
  }

  async function group(bots: Bot[], settings?: object) {
    const res = await call('POST', '/chats', { botIds: bots.map((b) => b.id) });
    expect(res.status).toBe(201);
    const chat = (await res.json()) as Chat;
    if (settings) {
      await t.db.update(schema.chats).set({ settings }).where(eq(schema.chats.id, chat.id));
    }
    return chat;
  }

  const say = async (chatId: string, text: string, threadRootId?: string) => {
    const res = await call('POST', `/chats/${chatId}/messages`, {
      text,
      ...(threadRootId ? { threadRootId } : {}),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  };

  const runsIn = (chatId: string) =>
    t.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.chatId, chatId))
      .orderBy(asc(schema.runs.createdAt));

  const messagesIn = (chatId: string) =>
    t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq));

  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 10_000, interval: 10 });

  const stepsOf = (runId: string) =>
    t.db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId))
      .orderBy(asc(schema.runSteps.idx));

  /** Waits until the chat's first run waits for the owner and no run job is still going. */
  async function waiting(chatId: string) {
    await until(async () => {
      expect((await runsIn(chatId)).map((r) => r.status)).toEqual(['waiting']);
      expect(busy).toBe(0);
    });
  }

  /** Waits until every run in the chats has finished and no run job is still going. */
  async function settled(...chatIds: string[]) {
    await until(async () => {
      const runs = await t.db
        .select()
        .from(schema.runs)
        .where(inArray(schema.runs.chatId, chatIds));
      expect(runs.every((r) => ['completed', 'failed', 'cancelled'].includes(r.status))).toBe(true);
      expect(busy).toBe(0);
    });
  }

  const text = (row: { parts: unknown }) =>
    (row.parts as MessagePart[])
      .map((p) => (p.type === 'text' || p.type === 'event' ? p.text : ''))
      .join('');

  const pingPong = (other: string, n = 30): ScriptedTurn[] =>
    Array.from({ length: n }, (_, i) => [{ text: `@${other} ping ${i}` }]);

  const loopEvents = async (chatId: string) =>
    (await messagesIn(chatId))
      .filter((m) => m.authorType === 'system')
      .flatMap((m) => m.parts as MessagePart[])
      .filter((p) => p.type === 'event' && p.kind === 'loop_stopped');

  describe('chats API', () => {
    it('creates a group of two to six Bots and lists it', async () => {
      const bots = await Promise.all(
        ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'].map(async (n) => (await newBot(n)).bot),
      );
      const one = await call('POST', '/chats', { botIds: [bots[0]!.id] });
      expect(((await one.json()) as { code: string }).code).toBe('GROUP_SIZE');
      const seven = await call('POST', '/chats', { botIds: bots.map((b) => b.id) });
      expect(seven.status).toBe(400);
      const missing = await call('POST', '/chats', { botIds: [bots[0]!.id, randomUUID()] });
      expect(missing.status).toBe(404);

      const res = await call('POST', '/chats', {
        botIds: bots.slice(0, 6).map((b) => b.id),
        title: 'Launch',
      });
      expect(res.status).toBe(201);
      const chat = (await res.json()) as Chat;
      expect(chat).toMatchObject({ type: 'group', title: 'Launch', botId: null });
      expect(chat.botIds).toEqual(bots.slice(0, 6).map((b) => b.id));

      const full = await call('POST', `/chats/${chat.id}/members`, { botIds: [bots[6]!.id] });
      expect(full.status).toBe(409);
      expect(((await full.json()) as { code: string }).code).toBe('GROUP_FULL');

      const { items } = (await (await call('GET', '/chats')).json()) as { items: Chat[] };
      expect(items.find((c) => c.id === chat.id)?.botIds).toHaveLength(6);
    });

    it('adds and removes members, with event rows, and keeps two', async () => {
      const [a, b, c] = await Promise.all(
        ['M1', 'M2', 'M3'].map(async (n) => (await newBot(n)).bot),
      );
      const chat = await group([a!, b!]);
      const added = await call('POST', `/chats/${chat.id}/members`, { botIds: [c!.id, a!.id] });
      expect(((await added.json()) as Chat).botIds).toEqual([a!.id, b!.id, c!.id]);
      const removed = await call('DELETE', `/chats/${chat.id}/members/${a!.id}`);
      expect(((await removed.json()) as Chat).botIds).toEqual([b!.id, c!.id]);
      const tooSmall = await call('DELETE', `/chats/${chat.id}/members/${b!.id}`);
      expect(((await tooSmall.json()) as { code: string }).code).toBe('GROUP_TOO_SMALL');
      const dm = await call('POST', `/chats/${a!.chatId}/members`, { botIds: [b!.id] });
      expect(((await dm.json()) as { code: string }).code).toBe('NOT_A_GROUP');
      expect((await messagesIn(chat.id)).map(text)).toEqual([
        '@m3 joined the chat',
        '@m1 left the chat',
      ]);
    });
  });

  describe('owner messages in a group', () => {
    it('lets shouldReply pick who answers when nobody is named (C5)', async () => {
      const { bot: writer, model } = await newBot('Writer', [[{ text: 'I can draft that.' }]]);
      const { bot: coder } = await newBot('Coder');
      const chat = await group([writer, coder]);
      willing.add(writer.id);
      asked.length = 0;
      await say(chat.id, 'Who can draft a launch post?');
      await settled(chat.id);
      expect(asked.sort()).toEqual([writer.id, coder.id].sort());
      const runs = await runsIn(chat.id);
      expect(runs.map((r) => [r.botId, r.trigger, r.priority, r.depth])).toEqual([
        [writer.id, 'bot_message', 2, 1],
      ]);
      // The roster lists every Bot of the group, one line each.
      const prompt = promptText(model.calls[0]!);
      expect(prompt).toContain('- @writer (Writer; bot; you)');
      expect(prompt).toContain('- @coder (Coder; bot)');
      expect(prompt).toContain('[@dana (owner)] Who can draft a launch post?');
    });

    it('says so once when no Bot could decide who answers, pointing to Settings', async () => {
      const { bot: a } = await newBot('Mute1');
      const { bot: b } = await newBot('Mute2');
      const chat = await group([a, b]);
      broken.add(a.id).add(b.id);
      await say(chat.id, 'Anyone there?');
      await say(chat.id, 'Hello?');
      await settled(chat.id);
      const notices = (await messagesIn(chat.id))
        .flatMap((m) => m.parts as MessagePart[])
        .filter((p) => p.type === 'event' && p.kind === 'reply_undecided');
      // Rate-limited: one row for the two messages.
      expect(notices).toEqual([
        expect.objectContaining({
          text: "The Bots couldn't decide who should reply. Check the small model in Settings > Models.",
          data: expect.objectContaining({ link: '/settings/models' }),
        }),
      ]);
      // The owner still gets an answer: the group's first Bot takes the messages.
      const runs = await runsIn(chat.id);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.botId === a.id)).toBe(true);
    });

    it("has the group's first Bot answer when every Bot declines an owner message", async () => {
      const { bot: a } = await newBot('Shy1', [[{ text: 'Hi! I can help.' }]]);
      const { bot: b } = await newBot('Shy2');
      const chat = await group([a, b]);
      asked.length = 0;
      await say(chat.id, 'hi all');
      await settled(chat.id);
      // Both were asked and both said no; the first member answers anyway.
      expect([...asked].sort()).toEqual([a.id, b.id].sort());
      expect((await runsIn(chat.id)).map((r) => r.botId)).toEqual([a.id]);
      const kinds = (await messagesIn(chat.id))
        .flatMap((m) => m.parts as MessagePart[])
        .map((p) => (p.type === 'event' ? p.kind : p.type));
      expect(kinds).not.toContain('reply_undecided');
    });

    it('stays quiet when at least one Bot could decide', async () => {
      const { bot: a } = await newBot('Half1');
      const { bot: b } = await newBot('Half2');
      const chat = await group([a, b]);
      broken.add(a.id);
      await say(chat.id, 'Small talk');
      await settled(chat.id);
      const kinds = (await messagesIn(chat.id))
        .flatMap((m) => m.parts as MessagePart[])
        .map((p) => (p.type === 'event' ? p.kind : p.type));
      expect(kinds).toEqual(['text']);
    });

    it('sends @mentions and @everyone only to the named Bots, skipping shouldReply (C5)', async () => {
      const { bot: a } = await newBot('Alpha', [[{ text: 'a1' }], [{ text: 'a2' }]]);
      const { bot: b } = await newBot('Beta', [[{ text: 'b1' }]]);
      const { bot: c } = await newBot('Gamma', [[{ text: 'c1' }]]);
      const chat = await group([a, b, c]);
      // Beta would answer if asked, but a mention directs the message to Alpha only.
      willing.add(b.id);
      asked.length = 0;
      await say(chat.id, '@alpha what do you think?');
      await settled(chat.id);
      expect(asked).toEqual([]);
      asked.length = 0;
      await say(chat.id, '@everyone status please');
      await settled(chat.id);
      expect(asked).toEqual([]);
      const runs = (await runsIn(chat.id)).map((r) => [r.botId, r.trigger, r.priority]);
      expect(runs).toEqual([
        [a.id, 'mention', 1],
        [a.id, 'mention', 1],
        [b.id, 'mention', 1],
        [c.id, 'mention', 1],
      ]);
    });

    it('answers an @mention in a thread inside that thread, reading the thread (C7)', async () => {
      const { bot: a, model } = await newBot('Threader', [[{ text: 'Root.' }], [{ text: 'T.' }]]);
      const { bot: b } = await newBot('Bystander');
      const chat = await group([a, b]);
      const root = await say(chat.id, '@threader draft the plan');
      await settled(chat.id);
      const res = await call('POST', `/chats/${chat.id}/messages`, {
        text: '@threader shorter please',
        threadRootId: root.id,
      });
      expect(res.status).toBe(201);
      await settled(chat.id);
      const reply = (await messagesIn(chat.id)).at(-1)!;
      expect(reply).toMatchObject({ authorId: a.id, threadRootId: root.id });
      const prompt = promptText(model.calls[1]!);
      expect(prompt).toContain('## This thread');
      expect(prompt).toContain('[@dana (owner)] @threader draft the plan');
      expect(prompt).toContain('[@dana (owner)] @threader shorter please');
      expect(prompt).not.toContain('Root.');
    });

    it('adds a Bot mentioned mid-conversation (C4)', async () => {
      const { bot: a } = await newBot('Uno');
      const { bot: b } = await newBot('Dos');
      const { bot: late } = await newBot('Tres', [[{ text: 'Happy to help.' }]]);
      const chat = await group([a, b]);
      await say(chat.id, '@tres can you join us?');
      await settled(chat.id);
      const got = (await (await call('GET', '/chats')).json()) as { items: Chat[] };
      expect(got.items.find((c) => c.id === chat.id)!.botIds).toEqual([a.id, b.id, late.id]);
      const rows = await messagesIn(chat.id);
      expect(rows.map(text)).toEqual([
        '@tres can you join us?',
        '@tres joined the chat',
        'Happy to help.',
      ]);
      expect((await runsIn(chat.id)).map((r) => [r.botId, r.trigger])).toEqual([
        [late.id, 'mention'],
      ]);
    });
  });

  describe('steering and threads in a group', () => {
    it('steers a Bot at work only with owner messages for it (C5, plan 5.2)', async () => {
      const { bot: a, model } = await newBot('Painter', [
        [{ tool: 'remember', args: { kind: 'fact', content: 'Paints the fence red' } }],
        [{ text: 'Painted it blue.' }],
      ]);
      const { bot: b } = await newBot('Critic', [[{ text: 'Looks fine.' }]]);
      const chat = await group([a, b]);
      let posted = false;
      embedHooks.set(a.id, async (texts) => {
        // While the Painter's tool runs, the owner talks to the Critic, then,
        // once the Critic has answered, to nobody. A Bot still at work would
        // take that message without being asked (plan 5.2), and on Postgres
        // the Critic's run is often still going by then.
        if (posted || texts[0] !== 'Paints the fence red') return;
        posted = true;
        await say(chat.id, '@critic what do you think so far?');
        await until(async () => {
          const critic = (await runsIn(chat.id)).find((r) => r.botId === b.id);
          expect(critic?.status).toBe('completed');
        });
        await say(chat.id, 'use blue instead');
      });
      asked.length = 0;
      try {
        await say(chat.id, '@painter paint the fence');
        await settled(chat.id);
      } finally {
        embedHooks.delete(a.id);
      }
      const runs = await runsIn(chat.id);
      expect(runs.map((r) => [r.botId, r.trigger])).toEqual([
        [a.id, 'mention'],
        [b.id, 'mention'],
      ]);
      // The message for nobody is the Painter's without asking it; the Critic is asked.
      expect(asked).toEqual([b.id]);
      const steered = (await stepsOf(runs[0]!.id)).filter((s) => s.type === 'steer');
      expect(steered.map((s) => s.label)).toEqual(['Steered: use blue instead']);
      const prompt = promptText(model.calls[1]!);
      expect(prompt).toContain('use blue instead');
      expect(prompt).not.toContain('what do you think so far');
    });

    it('gives a thread reply that names nobody to the Bot whose message it is (C7)', async () => {
      const { bot: a, model } = await newBot('Drafter', [
        [{ text: 'Draft one.' }],
        [{ text: 'Shorter draft.' }],
      ]);
      const { bot: b } = await newBot('Editor', [[{ text: 'Cut the second line.' }]]);
      const chat = await group([a, b]);
      // The Editor would answer if asked.
      willing.add(b.id);
      await say(chat.id, '@drafter write the intro');
      await settled(chat.id);
      const draft = (await messagesIn(chat.id)).at(-1)!;
      expect(draft.authorId).toBe(a.id);
      asked.length = 0;
      await say(chat.id, 'make it shorter', draft.id);
      await settled(chat.id);
      expect(asked).toEqual([]);
      expect(promptText(model.calls[1]!)).toContain('make it shorter');
      // A mention in the thread still directs the reply (C5).
      await say(chat.id, '@editor your take?', draft.id);
      await settled(chat.id);
      expect(asked).toEqual([]);
      expect((await runsIn(chat.id)).map((r) => [r.botId, r.trigger])).toEqual([
        [a.id, 'mention'],
        [a.id, 'mention'],
        [b.id, 'mention'],
      ]);
      const replies = (await messagesIn(chat.id)).filter((m) => m.authorType === 'bot');
      expect(replies.map((m) => [m.authorId, m.threadRootId, text(m)])).toEqual([
        [a.id, null, 'Draft one.'],
        [a.id, draft.id, 'Shorter draft.'],
        [b.id, draft.id, 'Cut the second line.'],
      ]);
    });

    it('attaches a thread reply on a pending approval to the waiting run (C7, P1)', async () => {
      const { bot: a, model } = await newBot(
        'Keeper',
        [
          [
            { text: 'Saving that.' },
            { tool: 'remember', args: { kind: 'fact', content: 'Likes tea' }, id: 'rem-keeper' },
          ],
          [{ text: 'Saved.' }],
        ],
        undefined,
        { tools: { remember: 'ask' } },
      );
      const { bot: b } = await newBot('Onlooker');
      willing.add(b.id);
      const chat = await group([a, b]);
      await say(chat.id, '@keeper remember that I like tea');
      await waiting(chat.id);
      const request = (await messagesIn(chat.id)).at(-1)!;
      expect((request.parts as MessagePart[]).at(-1)).toMatchObject({
        type: 'widget',
        kind: 'approval',
      });
      asked.length = 0;
      await say(chat.id, 'green tea, to be exact', request.id);
      // Nobody is asked and nothing starts; the run is still waiting.
      await new Promise((r) => setTimeout(r, 50));
      expect(asked).toEqual([]);
      const [run] = await runsIn(chat.id);
      expect((await runsIn(chat.id)).map((r) => r.status)).toEqual(['waiting']);
      const [approval] = await t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.runId, run!.id));
      const res = await call('POST', `/approvals/${approval!.id}/decide`, { decision: 'approve' });
      expect(res.status).toBe(200);
      await settled(chat.id);
      const prompt = promptText(model.calls[1]!);
      expect(prompt).toContain('Replies in the thread on your approval request');
      expect(prompt).toContain('green tea, to be exact');
      expect(await runsIn(chat.id)).toHaveLength(1);
    });

    it('takes a typed message as the answer to a pending question (C7)', async () => {
      const question = {
        question: 'Which repo?',
        options: [
          { id: 'a', label: 'openbots' },
          { id: 'b', label: 'website' },
        ],
      };
      const { bot: a, model } = await newBot('Quizzer', [
        [{ text: 'Let me check.' }, { tool: 'ask_user', args: question, id: 'ask-quizzer' }],
        [{ text: 'On it, in website.' }],
      ]);
      const { bot: b } = await newBot('Silent');
      const chat = await group([a, b]);
      await say(chat.id, '@quizzer fix the bug');
      await waiting(chat.id);
      const asking = (await messagesIn(chat.id)).at(-1)!;
      asked.length = 0;
      await say(chat.id, 'website please');
      await settled(chat.id);
      // The Bot waiting on its question takes it without being asked.
      expect(asked).toEqual([b.id]);
      expect(await runsIn(chat.id)).toHaveLength(1);
      expect(promptText(model.calls[1]!)).toContain('"text":"website please"');
      const [widget] = await t.db
        .select()
        .from(schema.widgetStates)
        .where(eq(schema.widgetStates.messageId, asking.id));
      expect(widget!.state).toMatchObject({ status: 'answered' });
    });
  });

  describe('Bot replies', () => {
    it('wakes a Bot its reply mentions, at priority 2 and one level deeper', async () => {
      const { bot: lead } = await newBot('Lead', [[{ text: 'Over to @helper for the numbers.' }]]);
      const { bot: helper, model } = await newBot('Helper', [[{ text: 'Numbers: 42.' }]]);
      const chat = await group([lead, helper]);
      await say(chat.id, '@lead get me the numbers');
      await settled(chat.id);
      const [first, second] = await runsIn(chat.id);
      expect(second).toMatchObject({
        botId: helper.id,
        trigger: 'mention',
        priority: 2,
        parentRunId: first!.id,
        depth: 2,
      });
      const reply = (await messagesIn(chat.id)).find((m) => m.authorId === lead.id)!;
      expect(reply.mentions).toEqual([helper.id]);
      // Other Bots appear by handle in the transcript.
      expect(promptText(model.calls[0]!)).toContain(
        '[@lead (bot)] <bot_message from="lead">\nOver to @helper for the numbers.\n</bot_message>',
      );
    });

    it('never asks shouldReply about a Bot reply that mentions nobody', async () => {
      const { bot: talker } = await newBot('Talker', [[{ text: 'Just thinking aloud.' }]]);
      const { bot: other } = await newBot('Other');
      const chat = await group([talker, other]);
      asked.length = 0;
      await say(chat.id, '@talker hi');
      await settled(chat.id);
      // The owner named Talker, and Talker's reply reaches nobody.
      expect(asked).toEqual([]);
      expect((await runsIn(chat.id)).map((r) => r.botId)).toEqual([talker.id]);
    });
  });

  describe('policy floor for data (P2, T5)', () => {
    it("asks in runs a Bot's @mention starts, never in runs the owner's group message starts", async () => {
      const { bot: lead } = await newBot('Releaser', [[{ text: '@deployer please deploy it.' }]]);
      const { bot: runner } = await newBot('Deployer', [[{ text: 'On it.' }]]);
      await t.db
        .update(schema.bots)
        .set({ toolPolicy: { tools: { bash: 'auto' } } })
        .where(inArray(schema.bots.id, [lead.id, runner.id]));
      const chat = await group([lead, runner]);
      willing.add(lead.id);
      await say(chat.id, 'Can someone ship the release?');
      await settled(chat.id);
      willing.delete(lead.id);
      const [ownerRun, botRun] = await runsIn(chat.id);
      expect(ownerRun).toMatchObject({ botId: lead.id, trigger: 'bot_message' });
      expect(botRun).toMatchObject({ botId: runner.id, trigger: 'mention' });
      expect(runSource(ownerRun!)).toBe('owner');
      expect(runSource(botRun!)).toBe('bot');

      const bots = await t.db
        .select()
        .from(schema.bots)
        .where(inArray(schema.bots.id, [lead.id, runner.id]));
      const decide = async (run: typeof ownerRun) => {
        const bot = bots.find((b) => b.id === run!.botId)!;
        const policy = await loadRunPolicy(t.ownerDeps, run!, bot, new Map());
        const policyRun = { id: run!.id, botId: bot.id, chatId: chat.id, trigger: run!.trigger };
        return asEvaluation(await policy.evaluate(policyRun, 'bash', { command: 'make deploy' }));
      };
      // The owner's own unaddressed message keeps the Bot's settings.
      expect((await decide(ownerRun)).decision).toBe('auto');
      // Another Bot's @mention is data: the run asks before anything that changes something.
      expect(await decide(botRun)).toMatchObject({
        decision: 'ask',
        reason: "Stricter rule for runs another Bot's message started",
      });
    });
  });

  describe('Bot to Bot (C6)', () => {
    it('message_bot writes into the pair chat, wakes the receiver and its reply wakes the sender', async () => {
      const { bot: planner, model: plannerModel } = await newBot('Planner', [
        [{ tool: 'message_bot', args: { handle: '@analyst', text: 'Can you size the market?' } }],
        [{ text: 'Asked @analyst.' }],
        // Woken by the answer; an empty reply ends the exchange.
        [{ text: '' }],
      ]);
      const { bot: analyst, model: analystModel } = await newBot('Analyst', [
        [{ text: 'About 2 billion.' }],
      ]);
      await say(planner.chatId, 'Find out how big the market is');
      const { items } = await until(async () => {
        const got = (await (await call('GET', '/chats')).json()) as { items: Chat[] };
        expect(
          got.items.some((c) => c.type === 'bot_to_bot' && c.botIds.includes(planner.id)),
        ).toBe(true);
        return got;
      });
      const pair = items.find((c) => c.type === 'bot_to_bot' && c.botIds.includes(planner.id))!;
      expect(pair.botIds.sort()).toEqual([planner.id, analyst.id].sort());
      await settled(pair.id, planner.chatId);

      const runs = await runsIn(pair.id);
      const [first] = await runsIn(planner.chatId);
      expect(runs.map((r) => [r.botId, r.trigger, r.priority, r.depth])).toEqual([
        [analyst.id, 'bot_dm', 2, first!.depth + 1],
        [planner.id, 'bot_dm', 2, first!.depth + 2],
      ]);
      expect(runs[0]!.parentRunId).toBe(first!.id);
      expect((await messagesIn(pair.id)).map((m) => [m.authorId, text(m)])).toEqual([
        [planner.id, 'Can you size the market?'],
        [analyst.id, 'About 2 billion.'],
        [planner.id, ''],
      ]);
      expect(promptText(analystModel.calls[0]!)).toContain(
        '[@planner (bot)] <bot_message from="planner">\nCan you size the market?\n</bot_message>',
      );
      expect(promptText(plannerModel.calls[2]!)).toContain(
        '[@analyst (bot)] <bot_message from="analyst">\nAbout 2 billion.\n</bot_message>',
      );
      // The owner can read the exchange.
      const page = await call('GET', `/chats/${pair.id}/messages`);
      expect(page.status).toBe(200);
    });

    it('refuses an unknown handle as a tool error', async () => {
      const { bot } = await newBot('Lonely', [
        [{ tool: 'message_bot', args: { handle: 'nobody', text: 'hello?' } }],
        [{ text: 'Nobody there.' }],
      ]);
      await say(bot.chatId, 'say hi to nobody');
      await settled(bot.chatId);
      const reply = (await messagesIn(bot.chatId)).find(
        (m) => m.authorType === 'bot' && !isGreeting(m),
      )!;
      const result = (reply.parts as MessagePart[]).find((p) => p.type === 'tool_result');
      expect(result).toMatchObject({ is_error: true });
      expect(JSON.stringify(result)).toContain('no other Bot called @nobody');
    });
  });

  describe("an owner's newer message", () => {
    /** A handoff a Bot's message queued but no worker picked up yet: no job is scheduled. */
    async function queuedHandoff(
      botId: string,
      chatId: string,
      parentRunId: string,
      thread?: string,
    ) {
      const [bot] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, botId));
      const [run] = await t.db
        .insert(schema.runs)
        .values({
          workspaceId: bot!.workspaceId,
          botId,
          chatId,
          trigger: 'mention',
          parentRunId,
          depth: 2,
          ...(thread ? { state: { input: { threadRootId: thread } } } : {}),
        })
        .returning();
      return run!;
    }

    it('drops handoffs still queued in its thread, says so, and leaves other threads alone', async () => {
      const { bot: lead } = await newBot('Lead', [[{ text: 'Starting.' }]]);
      const { bot: helper } = await newBot('Helper');
      const chat = await group([lead, helper]);
      const root = await say(chat.id, '@lead start');
      await settled(chat.id);
      const [leadRun] = await runsIn(chat.id);
      const here = await queuedHandoff(helper.id, chat.id, leadRun!.id);
      const elsewhere = await queuedHandoff(helper.id, chat.id, leadRun!.id, root.id);

      asked.length = 0;
      // Routing finishes before the POST answers; the stuck handoff elsewhere never settles.
      const owner = await say(chat.id, 'Change of plan, hold off');

      const byId = new Map((await runsIn(chat.id)).map((r) => [r.id, r]));
      expect(byId.get(here.id)).toMatchObject({ status: 'cancelled' });
      expect(byId.get(elsewhere.id)).toMatchObject({ status: 'queued' });
      // Its Bot was no longer at work, so it was asked like the others.
      expect(asked).toContain(helper.id);
      const rows = await messagesIn(chat.id);
      const notice = rows.find((m) =>
        (m.parts as MessagePart[]).some((p) => p.type === 'event' && p.kind === 'handoffs_dropped'),
      );
      expect(notice).toMatchObject({ authorType: 'system', threadRootId: null });
      expect((notice!.parts as MessagePart[])[0]).toMatchObject({
        text: 'Dropped 1 queued Bot handoff after a newer owner message.',
        data: { runIds: [here.id], botIds: [helper.id] },
      });
      // Posted after routing: shouldReply saw the owner's message last.
      expect(notice!.seq).toBeGreaterThan(owner.seq);
    });

    it('leaves handoffs alone when the owner names a Bot, and never drops one that started', async () => {
      const { bot: lead } = await newBot('Lead2', [[{ text: 'Starting.' }]]);
      const { bot: helper } = await newBot('Helper2');
      const { bot: designer } = await newBot('Designer2', [[{ text: 'Sure.' }]]);
      const chat = await group([lead, helper, designer]);
      await say(chat.id, '@lead2 start');
      await settled(chat.id);
      const [leadRun] = await runsIn(chat.id);
      const pending = await queuedHandoff(helper.id, chat.id, leadRun!.id);
      // Queued again after an approval or answer: it started before, so it is kept.
      const resumed = await queuedHandoff(helper.id, chat.id, leadRun!.id);
      await t.db
        .update(schema.runs)
        .set({ startedAt: new Date() })
        .where(eq(schema.runs.id, resumed.id));

      await say(chat.id, '@designer2 quick question');
      let byId = new Map((await runsIn(chat.id)).map((r) => [r.id, r]));
      expect(byId.get(pending.id)?.status).toBe('queued');

      await say(chat.id, 'Change of plan');
      byId = new Map((await runsIn(chat.id)).map((r) => [r.id, r]));
      expect(byId.get(pending.id)?.status).toBe('cancelled');
      expect(byId.get(resumed.id)?.status).toBe('queued');
    });

    it("never drops a handoff for a Bot's message", async () => {
      const { bot: one } = await newBot('Relay1', [[{ text: 'Passing on.' }]]);
      const { bot: two } = await newBot('Relay2');
      const chat = await group([one, two]);
      await say(chat.id, '@relay1 go');
      await settled(chat.id);
      const [run] = await runsIn(chat.id);
      const handoff = await queuedHandoff(two.id, chat.id, run!.id);
      // Another Bot's message in the same place is routed, but ends nothing.
      const fromBot = await postMessage(t.ownerDeps, chat.id, {
        authorType: 'bot',
        authorId: one.id,
        parts: [{ type: 'text', text: 'Still on it.' }],
      });
      await routeMessage(t.ownerDeps, fromBot, router);
      expect((await runsIn(chat.id)).find((r) => r.id === handoff.id)?.status).toBe('queued');
      const kinds = (await messagesIn(chat.id))
        .flatMap((m) => m.parts as MessagePart[])
        .map((p) => (p.type === 'event' ? p.kind : p.type));
      expect(kinds).not.toContain('handoffs_dropped');
    });
  });

  describe('loop guards', () => {
    it('stops a chain at max_chain_depth (default 4) with an event row', async () => {
      const { bot: ping } = await newBot('Ping', pingPong('pong'));
      const { bot: pong } = await newBot('Pong', pingPong('ping'));
      const chat = await group([ping, pong]);
      await say(chat.id, '@ping start');
      await settled(chat.id);
      const runs = await runsIn(chat.id);
      expect(runs.map((r) => r.depth)).toEqual([1, 2, 3, 4]);
      expect(await loopEvents(chat.id)).toEqual([
        expect.objectContaining({
          text: 'Stopped a Bot loop: the chain of Bot replies reached 4 steps.',
          data: { reason: 'depth', depth: 5, botIds: [ping.id] },
        }),
      ]);
    });

    it('stops Bot-triggered runs past the rolling budget with an event row', async () => {
      const { bot: tick } = await newBot('Tick', pingPong('tock'));
      const { bot: tock } = await newBot('Tock', pingPong('tick'));
      const chat = await group([tick, tock], { max_chain_depth: 50, bot_run_budget: 4 });
      await say(chat.id, '@tick start');
      await settled(chat.id);
      const runs = await runsIn(chat.id);
      // The owner's run plus four Bot-triggered ones.
      expect(runs.filter((r) => r.parentRunId).length).toBe(4);
      expect(runs).toHaveLength(5);
      expect(await loopEvents(chat.id)).toEqual([
        expect.objectContaining({
          text: 'Stopped a Bot loop: Bots started 4 runs in this chat in 10 minutes.',
          data: expect.objectContaining({ reason: 'budget' }),
        }),
      ]);
      // The owner is never stopped by the budget.
      await say(chat.id, '@tock one more');
      await until(async () => expect((await runsIn(chat.id)).length).toBe(6));
    });

    it('stops a Bot-to-Bot ping-pong the same way', async () => {
      const { bot: left } = await newBot('Left', [
        [{ tool: 'message_bot', args: { handle: 'right', text: 'hi' } }],
        [{ text: 'sent' }],
        ...Array.from({ length: 10 }, () => [{ text: 'and again' }]),
      ]);
      const { bot: right } = await newBot(
        'Right',
        Array.from({ length: 10 }, () => [{ text: 'back to you' }]),
      );
      await say(left.chatId, 'talk to right');
      const pair = await until(async () => {
        const [row] = await t.db
          .select()
          .from(schema.chats)
          .where(
            and(
              eq(schema.chats.type, 'bot_to_bot'),
              inArray(schema.chats.botId, [left.id, right.id]),
            ),
          );
        expect(row).toBeDefined();
        return row!;
      });
      await settled(pair.id, left.chatId);
      const runs = await runsIn(pair.id);
      expect(Math.max(...runs.map((r) => r.depth))).toBe(4);
      expect(await loopEvents(pair.id)).toHaveLength(1);
    });
  });

  it('exit scenario: a Chief of Staff routes work to three specialists, and a ping-pong is stopped', async () => {
    const { bot: chief, model: chiefModel } = await newBot(
      'Chief',
      [
        [
          {
            text: 'On it. @research find sources, @design draft the visuals, @copy write the post.',
          },
        ],
        [
          {
            tool: 'show_widget',
            args: {
              kind: 'status_summary',
              props: {
                title: 'Launch',
                items: [
                  { label: 'Sources', status: 'done', owner: 'research' },
                  { label: 'Visuals', status: 'done', owner: 'design' },
                  { label: 'Post', status: 'in_progress', owner: 'copy' },
                ],
              },
            },
          },
        ],
        [{ text: 'Status above.' }],
      ],
      'Chief of Staff: routes work to the specialists',
    );
    const { bot: research } = await newBot('Research', [[{ text: 'Three sources found.' }]]);
    const { bot: design } = await newBot('Design', [
      [{ text: 'Visuals drafted.' }],
      ...pingPong('copy', 10),
    ]);
    // Copy and Design then start arguing with each other.
    const { bot: copy } = await newBot('Copy', [
      [{ text: 'Draft ready. @design the colours are wrong.' }],
      ...pingPong('design', 10),
    ]);
    const chat = await group([chief, research, design, copy]);
    await say(chat.id, 'Plan the launch, @chief');
    await settled(chat.id);

    const runs = await runsIn(chat.id);
    const [chiefRun] = runs;
    expect(chiefRun).toMatchObject({ botId: chief.id, trigger: 'mention', depth: 1 });
    // Visible handoffs: the Chief's reply names the three specialists, each woken by it.
    const handoffs = runs.filter((r) => r.parentRunId === chiefRun!.id);
    expect(handoffs.map((r) => r.botId).sort()).toEqual([research.id, design.id, copy.id].sort());
    expect(handoffs.every((r) => r.trigger === 'mention' && r.depth === 2)).toBe(true);
    // The ping-pong between Copy and Design is stopped by the depth guard.
    expect(Math.max(...runs.map((r) => r.depth))).toBe(4);
    expect(await loopEvents(chat.id)).toHaveLength(1);
    expect(chiefModel.calls).toHaveLength(1);

    // Asked for status, the Chief answers with a status_summary widget.
    await say(chat.id, '@chief status?');
    await settled(chat.id);
    const widget = (await messagesIn(chat.id))
      .filter((m) => m.authorId === chief.id)
      .flatMap((m) => m.parts as MessagePart[])
      .find((p) => p.type === 'widget');
    expect(widget).toMatchObject({ kind: 'status_summary' });
  });
});
