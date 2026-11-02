// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attachments, type Attachment } from './attachments.js';

// The Computer page's Attachments section against a fake REST server (plan
// 12.1): each file with its size, date, chat and download link, paging with
// Load more, and the empty state.

const BOT = '00000000-0000-4000-8000-0000000000b1';
const DM = '00000000-0000-4000-8000-0000000000c1';
const GROUP = '00000000-0000-4000-8000-0000000000c2';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    pages: {} as Record<string, { items: unknown[]; nextCursor: string | null }>,
    requests: [] as string[],
  };
  // The api client keeps the fetch it was created with, so swap it before any import.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    state.requests.push(pathname + '?' + searchParams.toString());
    if (pathname !== '/api/v1/files') return Response.json({ title: 'Not found' }, { status: 404 });
    return Response.json(state.pages[searchParams.get('cursor') ?? ''] ?? { items: [] });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

const file = (n: number, name: string, size: number, chat: Attachment['chat']): Attachment => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  name,
  mime: 'application/pdf',
  size,
  sha256: 'x',
  createdAt: `2026-10-1${n}T10:00:00.000Z`,
  chat,
});

const report = file(1, 'report.pdf', 2048, { id: DM, type: 'bot_dm', botId: BOT, name: 'Ada' });
const plan = file(2, 'plan.pdf', 10, { id: GROUP, type: 'group', botId: null, name: 'Launch' });
const draft = file(3, 'draft.txt', 5, null);

beforeEach(() => {
  server.requests = [];
  server.pages = {
    '': { items: [report, plan], nextCursor: plan.id },
    [plan.id]: { items: [draft], nextCursor: null },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The chat links need a router; one route rendering the section is enough.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Attachments /> }),
    history: createMemoryHistory(),
  });
  await router.load();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}

const rows = () =>
  [...host.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );
const link = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent === text)!;

describe('Attachments on the Computer page', () => {
  it('lists each file with its size, date and chat, and downloads it', async () => {
    await render();
    await until(() => rows().length === 2, 'the list');
    const added = (iso: string) => new Date(iso).toLocaleDateString();
    expect(rows()).toEqual([
      ['report.pdf', '2.0 KB', added(report.createdAt), 'Ada'],
      ['plan.pdf', '10 B', added(plan.createdAt), 'Launch'],
    ]);
    expect(link('report.pdf').getAttribute('href')).toBe(`/api/v1/files/${report.id}`);
    expect(link('report.pdf').hasAttribute('download')).toBe(true);
    expect(link('Ada').getAttribute('href')).toBe(`/bots/${BOT}`);
    expect(link('Launch').getAttribute('href')).toBe(`/groups/${GROUP}`);
  });

  it('loads the next page on request and marks a file never sent', async () => {
    await render();
    await until(() => rows().length === 2, 'the first page');
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Load more')!;
    act(() => more.click());
    await until(() => rows().length === 3, 'the second page');
    expect(rows()[2]).toEqual(['draft.txt', '5 B', expect.any(String), 'Not sent']);
    expect(server.requests).toContain(`/api/v1/files?cursor=${plan.id}&limit=50`);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Load more')).toBe(
      false,
    );
  });

  it('says so when there are none', async () => {
    server.pages = { '': { items: [], nextCursor: null } };
    await render();
    await until(() => host.textContent!.includes('Nothing yet'), 'the empty state');
    expect(host.querySelector('table')).toBeNull();
  });
});
