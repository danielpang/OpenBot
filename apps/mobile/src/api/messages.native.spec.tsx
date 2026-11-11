import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import { createMemoryCache } from '../cache';
import { useMessages } from './messages';
import type { Message } from './timeline';

const message = (id: string, seq: number): Message => ({
  id,
  seq,
  chatId: 'chat',
  threadRootId: null,
  authorType: 'bot',
  authorId: 'bot',
  parts: [{ type: 'text', text: `Message ${id}` }],
  mentions: [],
  mentionEveryone: false,
  runId: null,
  status: 'complete',
  deltaSeq: 0,
  updatedSeq: seq,
  createdAt: '2026-01-01T00:00:00Z',
});
// Every read returns equal content in new objects, as the server does.
const server = () => [message('a', 1), message('b', 2)];
const mockGet = jest.fn(async (path: string) =>
  path.endsWith('/resync')
    ? { messages: server(), deleted: [], hasMore: false }
    : { messages: server(), hasMore: true },
);
const mockMobile = {
  client: { GET: mockGet } as object,
  ws: null as object | null,
  host: { id: 'host' },
  cache: createMemoryCache(),
  onResync: () => () => {},
  setFocusedChat: () => {},
};
jest.mock('./provider', () => ({ useMobile: () => mockMobile }));
jest.mock('@openbots/api-client', () => ({ unwrap: (promise: Promise<unknown>) => promise }));

beforeEach(() => {
  mockGet.mockClear();
  mockMobile.client = { GET: mockGet };
  mockMobile.cache = createMemoryCache();
});

describe('a transcript across reconnects', () => {
  it('keeps the messages on screen, and their identity, when the connection is replaced', async () => {
    const view = renderHook(() => useMessages('chat'));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const shown = view.result.current.messages;
    expect(shown.map((item) => item.id)).toEqual(['a', 'b']);
    expect(view.result.current.hasMore).toBe(true);

    // A reconnect hands the hook a new client. The transcript must never pass through empty.
    const seen: number[] = [];
    mockMobile.client = { GET: mockGet };
    view.rerender({});
    seen.push(view.result.current.messages.length);
    await waitFor(() => expect(view.result.current.loading).toBe(true));
    seen.push(view.result.current.messages.length);
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    seen.push(view.result.current.messages.length);
    expect(seen).toEqual([2, 2, 2]);
    expect(view.result.current.hasMore).toBe(true);
    // The server re-sent the same rows: nothing on screen has a reason to re-render.
    expect(view.result.current.messages).toBe(shown);
    view.unmount();
  });

  it('starts empty for a different conversation', async () => {
    const view = renderHook(({ chat }: { chat: string }) => useMessages(chat), {
      initialProps: { chat: 'chat' },
    });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(2));
    mockGet.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender({ chat: 'other' });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(0));
    expect(view.result.current.loading).toBe(true);
    view.unmount();
  });
});
