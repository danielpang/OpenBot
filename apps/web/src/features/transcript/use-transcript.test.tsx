// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from './api.js';
import { RealtimeContext, type Realtime } from './realtime.js';
import { messagesOf } from './timeline.js';
import { useTranscript, type TranscriptData } from './use-transcript.js';

// The live transcript against a fake socket: the WS event sequence for one
// streamed message (design note, From 1.4) applied in order, replayed, out of
// order, and with a gap that has to be fetched again.

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    calls: [] as string[],
    pages: {} as Record<string, unknown>,
  };
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    state.calls.push(url.pathname + url.search);
    const body = state.pages[url.pathname + url.search] ?? state.pages[url.pathname];
    if (body === undefined) return Response.json({ title: 'Not found' }, { status: 404 });
    return Response.json(body);
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = '00000000-0000-4000-8000-0000000000c1';

function fakeClient() {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const resync = new Set<(since: number) => void>();
  const client = {
    status: 'open',
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    noteSeq: vi.fn(),
    close: vi.fn(),
    onEvent: () => () => {},
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as WsClient;
  const realtime: Realtime = {
    client,
    onResync: (_chat, listener) => {
      resync.add(listener);
      return () => resync.delete(listener);
    },
  };
  const emit = (type: string, payload: unknown, seq: number, chat_id = CHAT) =>
    act(() => {
      for (const h of handlers.get(type) ?? [])
        h({ type, ts: 0, seq, chat_id, payload } as WsEvent);
    });
  const reconnect = (since: number) =>
    act(async () => {
      for (const r of resync) r(since);
    });
  return { client, realtime, emit, reconnect };
}

const message = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  chatId: CHAT,
  seq,
  threadRootId: null,
  authorType: 'bot',
  authorId: null,
  parts: [{ type: 'text', text: `m${seq}` }],
  mentions: [],
  mentionEveryone: false,
  runId: null,
  status: 'complete',
  deltaSeq: 0,
  updatedSeq: seq,
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
});

let root: Root;
let data: TranscriptData;
function Probe() {
  data = useTranscript(CHAT);
  return null;
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const texts = () =>
  messagesOf(data.timeline).map((m) =>
    m.parts.map((p) => ('text' in p ? p.text : p.type)).join('+'),
  );

let fake: ReturnType<typeof fakeClient>;
beforeEach(async () => {
  server.calls.length = 0;
  server.pages = {
    [`/api/v1/chats/${CHAT}/messages?limit=50`]: {
      messages: [message(3), message(2)],
      hasMore: true,
    },
    [`/api/v1/chats/${CHAT}/messages?limit=50&before=2`]: {
      messages: [message(1)],
      hasMore: false,
    },
  };
  fake = fakeClient();
  root = createRoot(document.createElement('div'));
  act(() =>
    root.render(
      <RealtimeContext value={fake.realtime}>
        <Probe />
      </RealtimeContext>,
    ),
  );
  await flush();
});
afterEach(() => act(() => root.unmount()));

describe('useTranscript', () => {
  it('loads the newest page oldest first, pages upward and subscribes to the chat', async () => {
    expect(texts()).toEqual(['m2', 'm3']);
    expect(data.hasMore).toBe(true);
    expect(fake.client.subscribe).toHaveBeenCalledWith({ chats: [CHAT] });
    expect(fake.client.noteSeq).toHaveBeenLastCalledWith(CHAT, 3);

    await act(() => data.loadOlder());
    expect(texts()).toEqual(['m1', 'm2', 'm3']);
    expect(data.hasMore).toBe(false);
  });

  it('applies a streamed message once, however often its events arrive', async () => {
    const streaming = message(4, { status: 'streaming', parts: [] });
    const delta = (deltaSeq: number, text: string) => ({
      messageId: streaming.id,
      deltaSeq,
      deltas: [{ partIndex: 0, type: 'text', text }],
    });
    fake.emit('message.created', { message: streaming }, 4);
    fake.emit('message.delta', delta(1, 'Hel'), 4);
    fake.emit('message.delta', delta(1, 'Hel'), 4);
    fake.emit('message.created', { message: streaming }, 4);
    fake.emit('message.delta', delta(2, 'lo'), 4);
    fake.emit('message.delta', delta(1, 'Hel'), 4);
    fake.emit('message.completed', { messageId: streaming.id, status: 'complete', deltaSeq: 2 }, 4);
    fake.emit('message.completed', { messageId: streaming.id, status: 'complete', deltaSeq: 2 }, 4);
    fake.emit('message.created', { message: message(9) }, 9, 'another-chat');

    expect(texts()).toEqual(['m2', 'm3', 'Hello']);
    expect(data.timeline.byId[streaming.id]).toMatchObject({ status: 'complete', deltaSeq: 2 });
    expect(server.calls.some((c) => c.includes('/resync'))).toBe(false);
  });

  it('places a message by seq even when a later one arrived first', () => {
    fake.emit('message.created', { message: message(6) }, 6);
    fake.emit('message.created', { message: message(5) }, 5);
    expect(texts()).toEqual(['m2', 'm3', 'm5', 'm6']);
  });

  it('refetches a message when a delta skips a number, instead of applying it', async () => {
    const streaming = message(4, { status: 'streaming', parts: [] });
    const caughtUp = message(4, {
      status: 'streaming',
      deltaSeq: 3,
      parts: [{ type: 'text', text: 'ABC' }],
    });
    server.pages[`/api/v1/chats/${CHAT}/resync?since=3`] = { messages: [caughtUp], hasMore: false };
    fake.emit('message.created', { message: streaming }, 4);
    fake.emit(
      'message.delta',
      { messageId: streaming.id, deltaSeq: 3, deltas: [{ partIndex: 0, type: 'text', text: 'C' }] },
      4,
    );
    await flush();
    expect(server.calls).toContain(`/api/v1/chats/${CHAT}/resync?since=3`);
    expect(texts()).toEqual(['m2', 'm3', 'ABC']);
    fake.emit(
      'message.delta',
      { messageId: streaming.id, deltaSeq: 4, deltas: [{ partIndex: 0, type: 'text', text: 'D' }] },
      4,
    );
    expect(texts()).toEqual(['m2', 'm3', 'ABCD']);
  });

  it('resyncs after a reconnect and merges what it missed', async () => {
    server.pages[`/api/v1/chats/${CHAT}/resync?since=3`] = {
      messages: [message(4), message(5)],
      hasMore: false,
    };
    await fake.reconnect(3);
    await flush();
    expect(texts()).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('catches up messages it has that changed while the socket was down (plan 14.2)', async () => {
    const thumbs = { emoji: '👍', reactorType: 'user' as const, reactorId: CHAT };
    const streaming = message(4, { status: 'streaming', parts: [{ type: 'text', text: 'Hal' }] });
    fake.emit('message.created', { message: streaming }, 4);
    // Over the gap, m4 finished, then m2 got an answer and a reaction: each
    // took a later chat seq, so resync pages through them in that order.
    server.pages[`/api/v1/chats/${CHAT}/resync?since=4`] = {
      messages: [
        message(4, { updatedSeq: 5, deltaSeq: 2, parts: [{ type: 'text', text: 'Halt.' }] }),
      ],
      hasMore: true,
    };
    server.pages[`/api/v1/chats/${CHAT}/resync?since=5`] = {
      messages: [
        message(2, { updatedSeq: 7, parts: [{ type: 'text', text: 'm2!' }], reactions: [thumbs] }),
      ],
      hasMore: false,
    };
    await fake.reconnect(4);
    await flush();
    expect(texts()).toEqual(['m2!', 'm3', 'Halt.']);
    expect(messagesOf(data.timeline).at(-1)!.status).toBe('complete');
    expect(data.reactions[message(2).id]).toEqual([{ ...thumbs, messageId: message(2).id }]);
  });

  it('seeds reactions from pages and resync, and applies reaction.removed', async () => {
    const thumbs = { emoji: '👍', reactorType: 'bot' as const, reactorId: CHAT };
    const eyes = { emoji: '👀', reactorType: 'user' as const, reactorId: CHAT };
    server.pages[`/api/v1/chats/${CHAT}/messages?limit=50&before=2`] = {
      messages: [message(1, { reactions: [thumbs, eyes] })],
      hasMore: false,
    };
    await act(() => data.loadOlder());
    const m1 = message(1).id;
    expect(data.reactions[m1]).toEqual([
      { ...thumbs, messageId: m1 },
      { ...eyes, messageId: m1 },
    ]);

    fake.emit('reaction.removed', { ...eyes, messageId: m1 }, 1);
    expect(data.reactions[m1]).toEqual([{ ...thumbs, messageId: m1 }]);
    fake.emit('reaction.removed', { ...eyes, messageId: m1 }, 1, 'another-chat');
    expect(data.reactions[m1]).toHaveLength(1);

    server.pages[`/api/v1/chats/${CHAT}/resync?since=0`] = {
      messages: [message(1, { reactions: [] })],
      hasMore: false,
    };
    await fake.reconnect(0);
    await flush();
    expect(data.reactions[m1]).toEqual([]);
  });

  it('applies widget.updated to the widget part', () => {
    const asked = message(4, {
      parts: [
        {
          type: 'widget',
          kind: 'question',
          props: { question: 'Q?' },
          state: { status: 'pending' },
        },
      ],
    });
    fake.emit('message.created', { message: asked }, 4);
    const state = { status: 'answered', answer: { text: 'yes' } };
    fake.emit(
      'widget.updated',
      { widget: { messageId: asked.id, partIndex: 0, state, pendingRunId: null } },
      4,
    );
    expect(data.timeline.byId[asked.id]!.parts[0]).toMatchObject({ state });
  });
});
