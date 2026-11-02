import {
  applyMessageDelta,
  EVENTS_CHANNEL,
  type MessagePart,
  type WsEvent,
  type WsEventOf,
} from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createBot } from './bots.js';
import {
  appendPart,
  createStreaming,
  DELTA_FLUSH_MS,
  finalize,
  listMessages,
  postMessage,
  withWidgetStates,
} from './messages.js';

describe('streaming Bot messages', () => {
  let t: TestApp;
  let botId: string;
  let chatId: string;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('alice@example.com');
    const [user] = await t.db.select().from(schema.users);
    const [member] = await t.db.select().from(schema.workspaceMembers);
    const record = await createBot(
      t.ownerDeps,
      { id: user!.id, workspaceId: member!.workspaceId },
      { name: 'Ada' },
    );
    botId = record.bot.id;
    chatId = record.chatId;
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => t.close());
  beforeEach(() => {
    events.length = 0;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deltas = () =>
    events.filter((e): e is WsEventOf<'message.delta'> => e.type === 'message.delta');
  const row = async (id: string) =>
    (await t.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;

  const replay = (
    list: WsEventOf<'message.delta'>[],
    from = { parts: [] as MessagePart[], deltaSeq: 0 },
  ) =>
    list.reduce(
      (s, e) =>
        applyMessageDelta(s.parts, s.deltaSeq, {
          deltaSeq: e.payload.deltaSeq,
          deltas: e.payload.deltas as never,
        }),
      from,
    );

  it('creates a streaming message with the next seq', async () => {
    const message = await createStreaming(t.ownerDeps, { chatId, botId });
    expect(message).toMatchObject({
      chatId,
      authorType: 'bot',
      authorId: botId,
      status: 'streaming',
      parts: [],
      deltaSeq: 0,
    });
    await settle();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'message.created',
        chat_id: chatId,
        bot_id: botId,
        seq: message.seq,
      }),
    ]);
    await finalize(t.ownerDeps, message.id);
  });

  it('coalesces text deltas and flushes at part boundaries', async () => {
    const message = await createStreaming(t.ownerDeps, { chatId, botId });
    for (const word of ['Let ', 'me ', 'look']) {
      await appendPart(t.ownerDeps, message.id, { type: 'reasoning_delta', text: word });
    }
    for (const word of ['Run', 'ning']) {
      await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: word });
    }
    const call: MessagePart = {
      type: 'tool_call',
      tool_call_id: 'c1',
      tool_name: 'bash',
      args: { cmd: 'npm test' },
    };
    await appendPart(t.ownerDeps, message.id, call);
    // Reasoning flushed when text began; text and the tool call flushed together.
    expect(await row(message.id)).toMatchObject({
      deltaSeq: 2,
      parts: [{ type: 'reasoning', text: 'Let me look' }, { type: 'text', text: 'Running' }, call],
    });
    await settle();
    expect(deltas().map((e) => e.payload)).toEqual([
      {
        messageId: message.id,
        deltaSeq: 1,
        deltas: [{ partIndex: 0, type: 'reasoning', text: 'Let me look' }],
      },
      {
        messageId: message.id,
        deltaSeq: 2,
        deltas: [
          { partIndex: 1, type: 'text', text: 'Running' },
          { partIndex: 2, type: 'tool_call', text: '', part: call },
        ],
      },
    ]);
    expect(deltas().every((e) => e.chat_id === chatId && e.seq === message.seq)).toBe(true);
    await finalize(t.ownerDeps, message.id);
  });

  it(`flushes buffered text after ${DELTA_FLUSH_MS} ms`, async () => {
    const message = await createStreaming(t.ownerDeps, { chatId, botId });
    await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: 'Hel' });
    await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: 'lo' });
    expect((await row(message.id)).parts).toEqual([]);
    await sleep(DELTA_FLUSH_MS + 100);
    expect(await row(message.id)).toMatchObject({
      deltaSeq: 1,
      parts: [{ type: 'text', text: 'Hello' }],
    });
    expect(deltas()).toHaveLength(1);
    await finalize(t.ownerDeps, message.id);
  });

  it('finalizes with usage, and replays (even repeated) rebuild the stored parts', async () => {
    const message = await createStreaming(t.ownerDeps, { chatId, botId });
    await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: 'Checking.' });
    await appendPart(t.ownerDeps, message.id, {
      type: 'tool_call',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      args: { path: 'a.ts' },
    });
    await appendPart(t.ownerDeps, message.id, {
      type: 'tool_result',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      result: { ok: true },
    });
    // Mid-stream, a reconnecting client loads the row.
    const midway = await row(message.id);
    await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: 'All ' });
    await appendPart(t.ownerDeps, message.id, { type: 'text_delta', text: 'good.' });
    await appendPart(t.ownerDeps, message.id, {
      type: 'widget',
      kind: 'question',
      props: { q: '?' },
    });
    const done = await finalize(t.ownerDeps, message.id, {
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    await settle();

    expect(done.status).toBe('complete');
    expect(done.parts.map((p) => p.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'text',
      'widget',
    ]);
    const completed = events.find((e) => e.type === 'message.completed');
    expect(completed).toMatchObject({
      chat_id: chatId,
      seq: message.seq,
      payload: {
        messageId: message.id,
        status: 'complete',
        deltaSeq: done.deltaSeq,
        usage: { inputTokens: 12, outputTokens: 5 },
      },
    });

    const all = deltas();
    expect(replay(all)).toEqual({ parts: done.parts, deltaSeq: done.deltaSeq });
    expect(replay([...all, ...all.slice(1)])).toEqual(replay(all));
    const fromRow = { parts: midway.parts as MessagePart[], deltaSeq: midway.deltaSeq };
    expect(replay(all, fromRow)).toEqual(replay(all));
  });

  it('marks a failed message and refuses to finalize twice', async () => {
    const message = await createStreaming(t.ownerDeps, { chatId, botId });
    await appendPart(t.ownerDeps, message.id, { type: 'text', text: 'partial' });
    const done = await finalize(t.ownerDeps, message.id, { status: 'failed' });
    expect(done).toMatchObject({ status: 'failed', parts: [{ type: 'text', text: 'partial' }] });
    await expect(finalize(t.ownerDeps, message.id)).rejects.toThrow(/not streaming/);
  });
});

describe('widget state on read', () => {
  let t: TestApp;
  let owner: { id: string; workspaceId: string };
  let chatId: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    await t.signUp('alice@example.com');
    const [user] = await t.db.select().from(schema.users);
    const [member] = await t.db.select().from(schema.workspaceMembers);
    owner = { id: user!.id, workspaceId: member!.workspaceId };
    chatId = (await createBot(t.ownerDeps, owner, { name: 'Ada' })).chatId;
  });
  afterAll(() => t.close());

  it('overlays widget_states onto the widget part without rewriting the stored parts', async () => {
    const question = {
      type: 'widget',
      kind: 'question',
      props: { question: 'Which?', options: [{ id: 'a', label: 'A' }] },
      state: { status: 'pending' },
    } as const;
    const message = await postMessage(t.ownerDeps, chatId, {
      authorType: 'system',
      parts: [{ type: 'text', text: 'Before' }, question],
    });
    const answered = { status: 'answered', answer: { option_id: 'a', label: 'A' } };
    await t.db.insert(schema.widgetStates).values({
      workspaceId: owner.workspaceId,
      messageId: message.id,
      partIndex: 1,
      state: answered,
    });

    const { messages } = await listMessages(t.db, owner, chatId);
    const read = messages.find((m) => m.id === message.id)!;
    expect(read.parts).toEqual([
      { type: 'text', text: 'Before' },
      { ...question, state: answered },
    ]);
    expect((await row(message.id)).parts).toEqual([{ type: 'text', text: 'Before' }, question]);

    const res = await withWidgetStates(t.db, [message]);
    expect(res[0]!.parts[1]).toMatchObject({ state: answered });
  });

  const row = async (id: string) =>
    (await t.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
});
