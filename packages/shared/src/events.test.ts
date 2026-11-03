import { describe, expect, it } from 'vitest';
import {
  ClientFrameSchema,
  WS_EVENT_TYPES,
  WsEventSchema,
  parseServerFrame,
  wsEvent,
  type WsEvent,
} from './events.js';

const chat = '7a1c1d6e-6a36-4c39-9f5e-0d0f0b7d5d01';
const bot = '0b3e9a52-2a8d-4e0c-bc1e-5f1c4a2b9e02';
const run = 'c2d5e8f1-4b7a-4c3d-8e9f-1a2b3c4d5e03';
const message = {
  id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f04',
  chatId: chat,
  seq: 7,
  authorType: 'bot',
  authorId: bot,
  parts: [{ type: 'text', text: 'hello' }] as unknown[],
  status: 'streaming',
  createdAt: '2026-10-14T09:00:00.000Z',
} as const;
const approval = {
  id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a05',
  runId: run,
  toolName: 'github.merge_pull_request',
  args: { pr: 12 },
  reason: 'merges to main',
  status: 'pending',
} as const;

/** One valid event of every type in plan 14.2. */
const samples: WsEvent[] = [
  wsEvent('message.created', { message }, { chat_id: chat, bot_id: bot, seq: 7 }),
  wsEvent(
    'message.delta',
    {
      messageId: message.id,
      deltaSeq: 1,
      deltas: [{ partIndex: 0, type: 'text', text: ' world' }],
    },
    { chat_id: chat, seq: 7 },
  ),
  wsEvent(
    'message.completed',
    { messageId: message.id, status: 'complete', usage: { inputTokens: 10, outputTokens: 2 } },
    { chat_id: chat, seq: 7 },
  ),
  wsEvent(
    'message.deleted',
    { messageId: message.id, chatId: chat, threadRootId: null },
    { chat_id: chat, bot_id: bot, seq: 7 },
  ),
  wsEvent(
    'bot.state',
    { botId: bot, state: 'working', currentAction: 'Reading the inbox', runId: run },
    { bot_id: bot },
  ),
  wsEvent('run.status', { runId: run, status: 'running' }, { bot_id: bot }),
  wsEvent(
    'run.step',
    { step: { id: approval.id, runId: run, idx: 0, type: 'llm', label: 'Thinking' } },
    { bot_id: bot },
  ),
  wsEvent('approval.requested', { approval }, { chat_id: chat, bot_id: bot }),
  wsEvent('approval.resolved', { approval: { ...approval, status: 'approved' } }, { bot_id: bot }),
  wsEvent(
    'widget.updated',
    { widget: { messageId: message.id, partIndex: 1, state: { choice: 'a' }, pendingRunId: null } },
    { chat_id: chat },
  ),
  wsEvent(
    'routine.ran',
    { routineId: run, run: { id: approval.id, status: 'ok' } },
    { bot_id: bot },
  ),
  wsEvent('artifact.created', { artifactId: run, title: 'Plan' }, { bot_id: bot }),
  wsEvent('artifact.updated', { artifactId: run, title: 'Plan', version: 2 }, { bot_id: bot }),
  wsEvent('computer.status', { computerId: run, status: 'running' }, { bot_id: bot }),
  wsEvent('connector.updated', { connectorId: run, oauth: 'connected' }, { user_id: chat }),
  wsEvent('screen.control', { screenId: run, controller: 'user', userId: chat }, { bot_id: bot }),
  wsEvent(
    'device.paired',
    { device: { id: run, name: 'Phone', platform: 'ios', createdAt: '2026-01-01T00:00:00.000Z' } },
    { user_id: chat, workspace_id: bot },
  ),
  wsEvent(
    'device.revoked',
    {
      device: {
        id: run,
        name: 'Phone',
        platform: 'ios',
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: '2026-01-02T00:00:00.000Z',
      },
    },
    { user_id: chat, workspace_id: bot },
  ),
  wsEvent(
    'reaction.added',
    { messageId: message.id, emoji: '👍', reactorType: 'user', reactorId: chat },
    { chat_id: chat, seq: 7 },
  ),
  wsEvent(
    'reaction.removed',
    { messageId: message.id, emoji: '👍', reactorType: 'user', reactorId: chat },
    { chat_id: chat, seq: 7 },
  ),
];

describe('WS events', () => {
  it('has a sample for every event type', () => {
    expect(new Set(samples.map((e) => e.type))).toEqual(new Set(WS_EVENT_TYPES));
    expect(WS_EVENT_TYPES).toHaveLength(20);
  });

  it.each(samples.map((e) => [e.type, e] as const))('%s round-trips through JSON', (_, event) => {
    const wire = JSON.parse(JSON.stringify(event));
    expect(WsEventSchema.parse(wire)).toEqual(event);
    expect(parseServerFrame(wire)).toEqual(event);
  });

  it('keeps payload fields it does not know (append-only)', () => {
    const event = wsEvent('artifact.created', { artifactId: run, title: 'Plan' });
    const later = { ...event, payload: { ...event.payload, kind: 'markdown' } };
    expect(WsEventSchema.parse(later).payload).toMatchObject({ kind: 'markdown' });
  });

  it('rejects an unknown type and a payload of the wrong shape', () => {
    expect(WsEventSchema.safeParse({ type: 'bot.exploded', ts: 1, payload: {} }).success).toBe(
      false,
    );
    expect(
      WsEventSchema.safeParse({
        type: 'bot.state',
        ts: 1,
        payload: { botId: bot, state: 'asleep' },
      }).success,
    ).toBe(false);
  });

  it('carries a device event to its owner in its organization, and refuses an unknown platform', () => {
    const event = samples.find((e) => e.type === 'device.revoked')!;
    expect(event).toMatchObject({ user_id: chat, workspace_id: bot });
    const wrong = {
      ...event,
      payload: { device: { id: run, name: 'Phone', platform: 'fridge', createdAt: 'x' } },
    };
    expect(WsEventSchema.safeParse(wrong).success).toBe(false);
  });

  it('parses client frames, defaulting missing lists', () => {
    expect(ClientFrameSchema.parse({ type: 'subscribe', chats: [chat] })).toEqual({
      type: 'subscribe',
      chats: [chat],
      bots: [],
    });
    expect(ClientFrameSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(ClientFrameSchema.safeParse({ type: 'subscribe', chats: 'all' }).success).toBe(false);
  });

  it('parses control frames', () => {
    expect(parseServerFrame({ type: 'pong', ts: 5 })).toEqual({ type: 'pong', ts: 5 });
    expect(parseServerFrame({ type: 'nonsense' })).toBeUndefined();
  });
});
