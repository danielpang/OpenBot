// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botsQuery } from '../bots/queries.js';
import type { Message } from '../transcript/api.js';
import { RealtimeContext, type Realtime } from '../transcript/realtime.js';
import { chatsQuery, type Chat } from './api.js';
import { BotChats } from './bot-chats.js';

// A notification or deep link for a message in a Bot to Bot chat (N1, C6)
// opens `/bots/{id}?chat={chat id}&seq=N`: the folded list and that chat open
// under the transcript, at the message, loading earlier pages until it is there.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const PEER = '00000000-0000-4000-8000-0000000000b2';
const PAIR = '00000000-0000-4000-8000-0000000000c1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    pages: {} as Record<string, unknown>,
    requested: [] as string[],
  };
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    state.requested.push(url.pathname + url.search);
    const body = state.pages[url.pathname + url.search];
    if (body === undefined) return Response.json({ title: 'Not found' }, { status: 404 });
    return Response.json(body);
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (seq: number): Message => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  chatId: PAIR,
  seq,
  updatedSeq: seq,
  threadRootId: null,
  authorType: 'bot',
  authorId: seq % 2 ? BOT : PEER,
  parts: [{ type: 'text', text: `m${seq}` }],
  mentions: [],
  mentionEveryone: false,
  runId: null,
  status: 'complete',
  deltaSeq: 0,
  createdAt: '2026-10-18T00:00:00.000Z',
});

const pair: Chat = {
  id: PAIR,
  type: 'bot_to_bot',
  title: null,
  botId: BOT,
  peerBotId: PEER,
  botIds: [BOT, PEER],
  lastSeq: 60,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
};

const bot = (id: string, name: string) => ({
  id,
  name,
  handle: name.toLowerCase(),
  avatar: { kind: 'generated', seed: id },
});

const realtime: Realtime = {
  client: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    noteSeq: vi.fn(),
    on: () => () => {},
  } as unknown as WsClient,
  onResync: () => () => {},
};

let root: Root;
let host: HTMLElement;
let queryClient: QueryClient;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function render(focus?: { chatId: string; seq?: number }) {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={realtime}>
          <BotChats botId={BOT} focus={focus} />
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  server.requested = [];
  // The newest page holds 11 to 60; seq 5 is on the page before it.
  server.pages = {
    [`/api/v1/chats/${PAIR}/messages?limit=50`]: {
      messages: Array.from({ length: 50 }, (_, i) => message(60 - i)),
      hasMore: true,
    },
    [`/api/v1/chats/${PAIR}/messages?limit=50&before=11`]: {
      messages: Array.from({ length: 10 }, (_, i) => message(10 - i)),
      hasMore: false,
    },
  };
  queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  queryClient.setQueryData(chatsQuery.queryKey, { items: [pair] });
  queryClient.setQueryData(botsQuery.queryKey, {
    items: [bot(BOT, 'Ada'), bot(PEER, 'Grace')],
  } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const lists = () => [...host.querySelectorAll('details')];

describe('<BotChats>', () => {
  it('stays folded, loading nothing, without a focus', async () => {
    render();
    await flush();
    expect(lists().map((d) => d.open)).toEqual([false, false]);
    expect(server.requested).toEqual([]);
  });

  it('opens the focused chat at its message, loading earlier pages until it is there', async () => {
    render({ chatId: PAIR, seq: 5 });
    await flush();
    await flush();
    expect(lists().map((d) => d.open)).toEqual([true, true]);
    expect(server.requested).toEqual([
      `/api/v1/chats/${PAIR}/messages?limit=50`,
      `/api/v1/chats/${PAIR}/messages?limit=50&before=11`,
    ]);
    const focused = host.querySelectorAll<HTMLElement>('[data-focused]');
    expect(focused).toHaveLength(1);
    expect(focused[0]!.textContent).toContain('m5');
    expect(focused[0]!.className).toContain('bg-accent');
  });

  it('ignores a focus on a chat that is not this Bot’s', async () => {
    render({ chatId: '00000000-0000-4000-8000-0000000000ff', seq: 5 });
    await flush();
    expect(lists().map((d) => d.open)).toEqual([false, false]);
  });
});
