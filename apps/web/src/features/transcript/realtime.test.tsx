// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botsQuery, type Bot } from '../bots/queries.js';
import { chatsQuery, type Chat } from '../chats/api.js';
import type { BotState } from './api.js';
import { RealtimeProvider, useBotState } from './realtime.js';

// The shell's one socket: it subscribes to every Bot in the roster, writes
// `bot.state` into the `['bots']` cache and the live state store, and
// refreshes the chat list when a Bot writes in a chat it does not know.

const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const client = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    close: vi.fn(),
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  };
  return { handlers, client, created: 0 };
});

vi.mock('../../app/api.js', () => ({
  createRealtime: () => {
    socket.created++;
    return socket.client as unknown as WsClient;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '00000000-0000-4000-8000-0000000000b1';
const ada: Bot = {
  id: ID,
  handle: 'ada',
  name: 'Ada',
  label: null,
  description: '',
  avatar: { kind: 'generated', seed: 'Ada' },
  modelConfig: null,
  toolPolicy: {},
  pinned: false,
  hidden: false,
  isMain: false,
  chatId: ID,
  state: {
    botId: ID,
    state: 'idle',
    currentAction: null,
    runId: null,
    updatedAt: '2026-10-16T00:00:00.000Z',
  },
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

let root: Root;
let queryClient: QueryClient;
let live: BotState | undefined;
function Probe() {
  live = useBotState(ID, undefined);
  return null;
}

beforeEach(() => {
  socket.created = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(botsQuery.queryKey, { items: [ada] });
  root = createRoot(document.createElement('div'));
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider>
          <Probe />
        </RealtimeProvider>
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => act(() => root.unmount()));

describe('RealtimeProvider', () => {
  it('opens one socket and subscribes to every Bot in the roster', () => {
    expect(socket.created).toBe(1);
    expect(socket.client.subscribe).toHaveBeenCalledWith({ bots: [ID] });
  });

  it('writes bot.state into the roster cache and the live state', () => {
    const event = {
      type: 'bot.state',
      ts: Date.parse('2026-10-16T01:00:00.000Z'),
      bot_id: ID,
      payload: {
        botId: ID,
        state: 'working',
        currentAction: 'Reading notes.txt',
        runId: null,
        currentTool: 'read_file',
      },
    } as WsEvent;
    act(() => {
      for (const handler of socket.handlers.get('bot.state') ?? []) handler(event);
    });
    const expected = {
      botId: ID,
      state: 'working',
      currentAction: 'Reading notes.txt',
      runId: null,
      currentTool: 'read_file',
      updatedAt: '2026-10-16T01:00:00.000Z',
    };
    const cached = queryClient.getQueryData(botsQuery.queryKey);
    expect(cached?.items[0]!.state).toEqual(expected);
    expect(live).toEqual(expected);
  });

  it('refreshes the chat list when a Bot writes in a chat it does not know (C6)', () => {
    const group: Chat = {
      id: '00000000-0000-4000-8000-0000000000c1',
      type: 'group',
      title: null,
      botId: null,
      peerBotId: null,
      botIds: [ID],
      lastSeq: 0,
      createdAt: '',
      updatedAt: '',
    };
    queryClient.setQueryData(chatsQuery.queryKey, { items: [group] });
    const invalidated = vi.spyOn(queryClient, 'invalidateQueries');
    const created = (chatId: string) =>
      act(() => {
        const event = { type: 'message.created', ts: 0, chat_id: chatId, bot_id: ID, payload: {} };
        for (const handler of socket.handlers.get('message.created') ?? []) {
          handler(event as unknown as WsEvent);
        }
      });
    // The Bot's own transcript and a known group are not new.
    created(ID);
    created(group.id);
    expect(invalidated).not.toHaveBeenCalled();
    // A first message_bot opens a Bot to Bot chat nobody has listed yet.
    created('00000000-0000-4000-8000-0000000000c2');
    expect(invalidated).toHaveBeenCalledWith({ queryKey: chatsQuery.queryKey });
  });
});
