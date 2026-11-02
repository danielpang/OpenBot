// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSettings } from './bot-settings.js';
import { botsQuery, type Bot } from './queries.js';

// A Bot's shape (Moon, Box, Egg) can change later in its Settings tab: the
// avatar editor offers the same three, and Save sends the pinned shape with
// the Bot update.

const BOT = '00000000-0000-4000-8000-0000000000b1';

// The other sections load their own data; this test is about the profile form.
vi.mock('../tools/bot-tools.js', () => ({ BotTools: () => null }));
vi.mock('../skills/bot-skills.js', () => ({ BotSkills: () => null }));
vi.mock('../webhooks/endpoints.js', () => ({ BotInbox: () => null }));
vi.mock('./bot-usage.js', () => ({ BotUsageSection: () => null }));
vi.mock('./bot-model.js', () => ({ BotModelFields: () => null }));

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    bots: [] as Record<string, unknown>[],
    patches: [] as Record<string, unknown>[],
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (request.method === 'PATCH' && path.startsWith('/api/v1/bots/')) {
      const body = (await request.json()) as Record<string, unknown>;
      state.patches.push(body);
      state.bots = state.bots.map((b) => ({ ...b, ...body }));
      return Response.json(state.bots[0]);
    }
    if (path === '/api/v1/bots') return Response.json({ items: state.bots });
    return Response.json({ items: [] });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = {
  id: BOT,
  handle: 'scout',
  name: 'Scout',
  label: null,
  description: '',
  avatar: { kind: 'generated', seed: 'scout', shape: 'bean' },
  modelConfig: null,
  toolPolicy: {},
  pinned: false,
  hidden: false,
  isMain: true,
  chatId: '00000000-0000-4000-8000-0000000000c1',
  state: {
    botId: BOT,
    state: 'idle',
    currentAction: null,
    runId: null,
    updatedAt: '2026-10-31T00:00:00.000Z',
  },
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
} as Bot;

let root: Root;
let host: HTMLElement;
beforeEach(async () => {
  server.bots = [bot];
  server.patches = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(botsQuery.queryKey, { items: [bot] });
  const rootRoute = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <BotSettings botId={BOT} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await until(() => shapes().length > 0, 'the settings form');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.title === name,
  )!;
const shapes = () => [...host.querySelectorAll('[role="group"][aria-label="Shape"] button')];

describe('Settings avatar', () => {
  it('changes the shape with the same three choices and saves it', async () => {
    expect(shapes().map((b) => b.textContent?.trim())).toEqual(['Moon', 'Box', 'Egg']);
    expect(button('Moon').getAttribute('aria-pressed')).toBe('true');

    act(() => button('Box').click());
    expect(button('Box').getAttribute('aria-pressed')).toBe('true');
    act(() => button('Save').click());
    await until(() => server.patches.length === 1, 'the update');
    expect(server.patches[0]).toMatchObject({
      avatar: { kind: 'generated', seed: 'scout', shape: 'rounded' },
    });
  });

  it('keeps the shape when the rest is shuffled', () => {
    act(() => button('Egg').click());
    act(() => button('Shuffle').click());
    expect(button('Egg').getAttribute('aria-pressed')).toBe('true');
  });
});
