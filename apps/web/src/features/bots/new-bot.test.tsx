// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import { Dialog } from '@openbots/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewFlow } from '../../app/new-dialog.js';
import { RightPanelProvider } from '../../app/right-panel.js';
import { me } from '../../test-utils.js';
import { Transcript } from '../transcript/Transcript.js';
import { RealtimeContext, type Realtime } from '../transcript/realtime.js';
import { botsQuery } from './queries.js';

// New asks only for a name and an icon (B2). The icon picker offers Moon, Box
// and Egg and Shuffle, which keeps the picked shape. Creating opens the Bot's
// chat, where the Bot has already asked what to work on.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const CHAT = '00000000-0000-4000-8000-0000000000c1';
const GREETING = "Hi, I'm Scout. What would you like me to work on?";

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    created: [] as Record<string, unknown>[],
    bots: [] as Record<string, unknown>[],
    /** GET answers by path. */
    pages: (): Record<string, unknown> => ({}),
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/v1/bots') {
      const body = (await request.json()) as Record<string, unknown>;
      state.created.push(body);
      const bot = {
        id: '00000000-0000-4000-8000-0000000000b1',
        handle: 'scout',
        label: null,
        description: '',
        modelConfig: null,
        toolPolicy: {},
        pinned: false,
        hidden: false,
        isMain: true,
        chatId: '00000000-0000-4000-8000-0000000000c1',
        state: { botId: '00000000-0000-4000-8000-0000000000b1', state: 'idle', runId: null },
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
        ...body,
      };
      state.bots.push(bot);
      return Response.json(bot, { status: 201 });
    }
    return Response.json(state.pages()[url.pathname] ?? { items: [] });
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
let done: ReturnType<typeof vi.fn<() => void>>;
let router: ReturnType<typeof testRouter>;

/** New on `/`, and the Bot's chat on `/bots/{id}` as the app routes it. */
function testRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <Dialog open>
        <NewFlow onDone={done} />
      </Dialog>
    ),
  });
  const chat = createRoute({
    getParentRoute: () => rootRoute,
    path: '/bots/$botId',
    component: function Chat() {
      const { botId } = chat.useParams() as { botId: string };
      return <Transcript botId={botId} />;
    },
  });
  return createRouter({
    routeTree: rootRoute.addChildren([index, chat]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

beforeEach(async () => {
  server.created.length = 0;
  server.bots.length = 0;
  server.pages = () => ({
    '/api/v1/bots': { items: server.bots },
    '/api/v1/me': me('member'),
    [`/api/v1/bots/${BOT}/chat`]: { id: CHAT, type: 'bot_dm', botId: BOT, lastSeq: 1 },
    [`/api/v1/chats/${CHAT}/messages`]: {
      messages: [
        {
          id: '00000000-0000-4000-8000-0000000000e1',
          chatId: CHAT,
          seq: 1,
          updatedSeq: 1,
          threadRootId: null,
          authorType: 'bot',
          authorId: BOT,
          parts: [{ type: 'text', text: GREETING }],
          mentions: [],
          mentionEveryone: false,
          runId: null,
          status: 'complete',
          deltaSeq: 0,
          createdAt: '2026-10-31T00:00:00.000Z',
        },
      ],
      hasMore: false,
    },
  });
  done = vi.fn<() => void>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router = testRouter();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(botsQuery.queryKey, { items: [] });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={realtime}>
          <RightPanelProvider>
            <RouterProvider router={router} />
          </RightPanelProvider>
        </RealtimeContext>
      </QueryClientProvider>,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const dialog = () => document.body;
const button = (name: string) =>
  [...dialog().querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.title === name,
  )!;
const pressed = () =>
  [...dialog().querySelectorAll('[role="group"][aria-label="Shape"] button')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent?.trim());
const preview = () => dialog().querySelector('[aria-label="Icon preview"]')!.innerHTML;

describe('New Bot', () => {
  it('asks only for a name and an icon', async () => {
    await until(() => !!dialog().querySelector('[aria-label="Bot name"]'), 'the form');
    const form = dialog().querySelector('form[aria-label="New Bot"]')!;
    expect(form.querySelectorAll('input')).toHaveLength(1);
    expect(form.querySelectorAll('textarea, select')).toHaveLength(0);
    expect(dialog().textContent).not.toMatch(/template|model|description/i);
    // The icon starts as one of the three Bot shapes.
    expect(pressed()).toHaveLength(1);
    expect(['Moon', 'Box', 'Egg']).toContain(pressed()[0]);
  });

  it('picks a shape, keeps it on Shuffle, then opens the chat on the Bot’s first message', async () => {
    await until(() => !!dialog().querySelector('[aria-label="Bot name"]'), 'the form');
    act(() => button('Egg').click());
    expect(pressed()).toEqual(['Egg']);
    const before = preview();
    act(() => button('Shuffle').click());
    expect(pressed()).toEqual(['Egg']);
    expect(preview()).not.toBe(before);

    const name = dialog().querySelector<HTMLInputElement>('[aria-label="Bot name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Scout',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Create').click());
    await until(() => server.created.length === 1, 'the create request');
    expect(server.created[0]).toEqual({
      name: 'Scout',
      avatar: { kind: 'generated', seed: expect.any(String), shape: 'blob' },
    });

    await until(() => router.state.location.pathname === `/bots/${BOT}`, 'the Bot’s chat');
    expect(done).toHaveBeenCalled();
    await until(() => host.textContent?.includes(GREETING) ?? false, 'the greeting');
  });
});
