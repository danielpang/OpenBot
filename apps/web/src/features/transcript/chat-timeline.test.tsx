// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from './api.js';
import { ChatTimeline } from './chat-timeline.js';
import { RealtimeContext, type Realtime } from './realtime.js';
import { useTranscript } from './use-transcript.js';

// The chat timeline after a reload (C7): the "N replies" link comes from the
// page's `replyCount`, and live replies add to it. And `focusSeq` (a route's
// `?seq=`) scrolls to and highlights one message, in a group as in a Bot's chat.

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: () => {} }) }));

const CHAT = '00000000-0000-4000-8000-0000000000c1';

const server = vi.hoisted(() => {
  const state = { realFetch: globalThis.fetch, pages: {} as Record<string, unknown> };
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = state.pages[url.pathname + url.search];
    if (body === undefined) return Response.json({ title: 'Not found' }, { status: 404 });
    return Response.json(body);
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

// happy-dom lays nothing out; give the scroller a size so the virtualizer renders rows.
vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(720);
vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  createdAt: '2026-10-18T00:00:00.000Z',
  ...over,
});

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
  return { realtime, emit };
}

function Timeline({
  focusSeq,
  focusThread,
  named,
}: {
  focusSeq?: number;
  focusThread?: string;
  named?: boolean;
}) {
  const transcript = useTranscript(CHAT);
  return (
    <ChatTimeline
      label="Launch"
      start="Start"
      transcript={transcript}
      ownerId={undefined}
      botFor={() => undefined}
      stateFor={() => undefined}
      onOpenActivity={() => {}}
      onOpenArtifact={() => {}}
      onOpenThread={() => {}}
      focusSeq={focusSeq}
      focusThread={focusThread}
      named={named}
    />
  );
}

let root: Root;
let queryClient: QueryClient;
let host: HTMLElement;
let fake: ReturnType<typeof fakeClient>;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const links = () =>
  [...host.querySelectorAll('button')]
    .map((b) => b.textContent)
    .filter((t) => /^\d+ repl/.test(t ?? ''));

beforeEach(async () => {
  server.pages = {
    [`/api/v1/chats/${CHAT}/messages?limit=50`]: {
      messages: [
        message(4, { replyCount: 0, lastReplySeq: null }),
        message(1, { replyCount: 2, lastReplySeq: 3 }),
      ],
      hasMore: false,
    },
  };
  fake = fakeClient();
  queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={fake.realtime}>
          <Timeline />
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

describe('<ChatTimeline> reply counts', () => {
  it('renders "N replies" from replyCount and adds live replies', () => {
    expect(links()).toEqual(['2 replies']);
    const root = message(1).id;
    fake.emit('message.created', { message: message(5, { threadRootId: root }) }, 5);
    expect(links()).toEqual(['3 replies']);
    // A copy of the root from an event does not lose the count.
    fake.emit('message.created', { message: message(1, { deltaSeq: 1 }) }, 1);
    expect(links()).toEqual(['3 replies']);
  });
});

describe('<ChatTimeline> focusSeq', () => {
  const rowOf = (text: string) =>
    [...host.querySelectorAll<HTMLElement>('[data-index]')].find((row) =>
      row.textContent?.includes(text),
    );

  it('scrolls to and highlights the message in a group', async () => {
    expect(rowOf('m1')?.className).not.toContain('bg-accent');
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RealtimeContext value={fake.realtime}>
            <Timeline focusSeq={1} named />
          </RealtimeContext>
        </QueryClientProvider>,
      ),
    );
    await flush();
    expect(rowOf('m1')?.className).toContain('bg-accent');
    expect(rowOf('m4')?.className).not.toContain('bg-accent');
  });

  it("marks a thread reply's root, since the reply shows in the thread", async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RealtimeContext value={fake.realtime}>
            <Timeline focusSeq={3} focusThread={message(1).id} />
          </RealtimeContext>
        </QueryClientProvider>,
      ),
    );
    await flush();
    expect(rowOf('m1')?.className).toContain('bg-accent');
    expect(rowOf('m4')?.className).not.toContain('bg-accent');
  });
});
