// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import { DEFAULT_LIMITS, type WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery } from '../../app/api.js';
import { me } from '../../test-utils.js';
import { botsQuery, type Bot } from '../bots/queries.js';
import { chatsQuery } from '../chats/api.js';
import type { Message } from './api.js';
import { readPanel, writePanel } from './panel.js';
import { RealtimeContext, type Realtime } from './realtime.js';
import { ThreadPanel } from './thread-panel.js';

// The thread panel (C7): the root and its replies from `?thread=`, live
// replies in the thread and nothing from the rest of the chat, a composer that
// posts into the thread, and reactions (C8) from the owner and from Bots.

const CHAT = '00000000-0000-4000-8000-0000000000c1';
const ROOT = '00000000-0000-4000-8000-000000000001';
const OWNER = me('member').user.id;

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    calls: [] as { method: string; path: string; body?: unknown }[],
    pages: {} as Record<string, unknown>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => null);
    state.calls.push({ method: request.method, path, body });
    if (request.method === 'POST' && url.pathname.endsWith('/reactions')) {
      const messageId = url.pathname.split('/').at(-2);
      return Response.json(
        {
          messageId,
          emoji: (body as { emoji: string }).emoji,
          reactorType: 'user',
          reactorId: OWNER,
        },
        { status: 201 },
      );
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method === 'POST') {
      const { text, threadRootId } = body as { text: string; threadRootId: string };
      return Response.json(
        message(9, { authorType: 'user', authorId: OWNER, threadRootId, text }),
        {
          status: 201,
        },
      );
    }
    const page = state.pages[path];
    if (page === undefined) return Response.json({ title: 'Not found' }, { status: 404 });
    return Response.json(page);
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(
  seq: number,
  { text = `m${seq}`, ...over }: Partial<Message> & { text?: string } = {},
): Message {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chatId: CHAT,
    seq,
    threadRootId: null,
    authorType: 'bot',
    authorId: ADA.id,
    parts: [{ type: 'text', text }],
    mentions: [],
    mentionEveryone: false,
    runId: null,
    status: 'complete',
    deltaSeq: 0,
    updatedSeq: seq,
    createdAt: '2026-10-18T00:00:00.000Z',
    ...over,
  };
}

const bot = (n: number, name: string): Bot => {
  const id = `00000000-0000-4000-8000-0000000000b${n}`;
  return {
    id,
    handle: name.toLowerCase(),
    name,
    label: null,
    description: '',
    avatar: { kind: 'generated', seed: name },
    modelConfig: null,
    toolPolicy: {},
    pinned: false,
    hidden: false,
    chatId: `00000000-0000-4000-8000-0000000000d${n}`,
    state: { botId: id, state: 'idle', currentAction: null, runId: null, updatedAt: '' },
    createdAt: '',
    updatedAt: '',
  } as Bot;
};
const ADA = bot(1, 'Ada');
const GRACE = bot(2, 'Grace');

function fakeClient() {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const client = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    noteSeq: vi.fn(),
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as WsClient;
  const realtime: Realtime = { client, onResync: () => () => {} };
  const emit = (type: string, payload: unknown, seq: number) =>
    act(() => {
      for (const h of handlers.get(type) ?? [])
        h({ type, ts: 0, seq, chat_id: CHAT, payload } as WsEvent);
    });
  return { client, realtime, emit };
}

let root: Root;
let host: HTMLElement;
let fake: ReturnType<typeof fakeClient>;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const texts = () =>
  [...host.querySelectorAll('[role="log"] p')].map((p) => p.textContent).filter(Boolean);

beforeEach(async () => {
  server.calls.length = 0;
  server.pages = {
    [`/api/v1/chats/${CHAT}/messages?limit=50&thread=${ROOT}`]: {
      messages: [
        message(3, { threadRootId: ROOT, authorType: 'user', authorId: OWNER, text: 'Shorter' }),
        message(1, { text: 'Here is the draft' }),
      ],
      hasMore: false,
    },
  };
  fake = fakeClient();
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  queryClient.setQueryData(meQuery.queryKey, { ...me('member'), limits: DEFAULT_LIMITS });
  queryClient.setQueryData(botsQuery.queryKey, { items: [ADA, GRACE] });
  queryClient.setQueryData(chatsQuery.queryKey, {
    items: [
      {
        id: CHAT,
        type: 'group',
        title: 'Launch',
        botId: null,
        peerBotId: null,
        botIds: [ADA.id, GRACE.id],
        lastSeq: 3,
        createdAt: '',
        updatedAt: '',
      },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={fake.realtime}>
          <ThreadPanel chatId={CHAT} rootId={ROOT} />
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('<ThreadPanel> focusSeq', () => {
  it('marks the reply a notification opened', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queryClient.setQueryData(meQuery.queryKey, { ...me('member'), limits: DEFAULT_LIMITS });
    queryClient.setQueryData(botsQuery.queryKey, { items: [ADA, GRACE] });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RealtimeContext value={fake.realtime}>
            <ThreadPanel chatId={CHAT} rootId={ROOT} focusSeq={3} />
          </RealtimeContext>
        </QueryClientProvider>,
      ),
    );
    await flush();
    const marked = host.querySelector<HTMLElement>('[data-focused]');
    expect(marked?.textContent).toContain('Shorter');
    expect(marked?.className).toContain('bg-accent');
    expect(host.querySelector('[data-thread-root]')!.className).not.toContain('bg-accent');
  });
});

describe('<ThreadPanel>', () => {
  it('shows the root first, then its replies, with group prefixes and no nested threads', () => {
    expect(texts()).toEqual(['Here is the draft', 'Shorter']);
    expect(host.querySelector('[data-thread-root]')!.textContent).toContain('Ada');
    expect(host.textContent).not.toContain('Reply in thread');
    // The chat's own transcript holds the subscription.
    expect(fake.client.subscribe).not.toHaveBeenCalled();
  });

  it('follows live replies in this thread and ignores the rest of the chat', async () => {
    fake.emit('message.created', { message: message(4, { text: 'Elsewhere' }) }, 4);
    fake.emit(
      'message.created',
      { message: message(5, { threadRootId: ROOT, authorId: GRACE.id, text: 'Cut to 80 words' }) },
      5,
    );
    // A delta for a message outside the thread is not a gap to resync.
    fake.emit('message.delta', { messageId: message(4).id, deltaSeq: 1, deltas: [] }, 4);
    await flush();
    expect(texts()).toEqual(['Here is the draft', 'Shorter', 'Cut to 80 words']);
    expect(server.calls.some((c) => c.path.includes('/resync'))).toBe(false);
  });

  it('posts into the thread and offers the group and @everyone to mention', async () => {
    const textarea = host.querySelector('textarea')!;
    expect(textarea.placeholder).toBe('Reply in thread');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '@',
      );
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const options = [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['Ada@ada', 'Grace@grace', '@everyoneEvery Bot in the group']);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Make it shorter',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(server.calls.at(-1)).toEqual({
      method: 'POST',
      path: `/api/v1/chats/${CHAT}/messages`,
      body: { text: 'Make it shorter', threadRootId: ROOT },
    });
    expect(texts().at(-1)).toBe('Make it shorter');
  });

  it("shows a Bot's reaction and adds and takes back the owner's", async () => {
    const reply = message(3).id;
    fake.emit(
      'reaction.added',
      { messageId: reply, emoji: '👀', reactorType: 'bot', reactorId: GRACE.id },
      3,
    );
    const chip = () => host.querySelector<HTMLButtonElement>('[aria-label="Reactions"] button')!;
    expect(chip().textContent).toBe('👀1');
    expect(chip().title).toBe('@grace');
    expect(chip().getAttribute('aria-pressed')).toBe('false');

    // The root is a Bot's message: React opens the picker.
    const rootView = host.querySelector('[data-thread-root]')!;
    const react = [...rootView.querySelectorAll('button')].find((b) => b.textContent === 'React')!;
    act(() => react.click());
    act(() => rootView.querySelector<HTMLButtonElement>('[aria-label="React with 👍"]')!.click());
    await flush();
    expect(server.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/v1/messages/${ROOT}/reactions`,
      body: { emoji: '👍' },
    });
    const mine = rootView.querySelector<HTMLButtonElement>('[aria-label="Reactions"] button')!;
    expect(mine.textContent).toBe('👍1');
    expect(mine.getAttribute('aria-pressed')).toBe('true');

    act(() => mine.click());
    await flush();
    expect(server.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/messages/${ROOT}/reactions?emoji=${encodeURIComponent('👍')}`,
    });
    expect(rootView.querySelector('[aria-label="Reactions"]')).toBeNull();
  });
});

describe('reactions read with the thread', () => {
  it('shows chips from the page and drops one removed in another tab', async () => {
    server.pages[`/api/v1/chats/${CHAT}/messages?limit=50&thread=${ROOT}`] = {
      messages: [
        message(3, {
          threadRootId: ROOT,
          authorType: 'user',
          authorId: OWNER,
          text: 'Shorter',
          reactions: [{ emoji: '🎉', reactorType: 'bot', reactorId: GRACE.id }],
        }),
        message(1, {
          text: 'Here is the draft',
          reactions: [{ emoji: '👍', reactorType: 'user', reactorId: OWNER }],
        }),
      ],
      hasMore: false,
    };
    act(() => root.unmount());
    root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queryClient.setQueryData(meQuery.queryKey, { ...me('member'), limits: DEFAULT_LIMITS });
    queryClient.setQueryData(botsQuery.queryKey, { items: [ADA, GRACE] });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RealtimeContext value={fake.realtime}>
            <ThreadPanel chatId={CHAT} rootId={ROOT} />
          </RealtimeContext>
        </QueryClientProvider>,
      ),
    );
    await flush();
    const chips = () =>
      [...host.querySelectorAll('[aria-label="Reactions"] button')].map((b) => b.textContent);
    expect(chips()).toEqual(['👍1', '🎉1']);

    fake.emit(
      'reaction.removed',
      { messageId: ROOT, emoji: '👍', reactorType: 'user', reactorId: OWNER },
      1,
    );
    expect(chips()).toEqual(['🎉1']);
  });
});

describe('the thread panel kind', () => {
  it('is remembered with its chat and root', () => {
    writePanel('b1', { kind: 'thread', chatId: CHAT, rootId: ROOT });
    expect(readPanel('b1')).toEqual({ kind: 'thread', chatId: CHAT, rootId: ROOT });
    localStorage.setItem('openbots.panel.b1', JSON.stringify({ kind: 'thread', chatId: CHAT }));
    expect(readPanel('b1')).toBeNull();
  });
});
