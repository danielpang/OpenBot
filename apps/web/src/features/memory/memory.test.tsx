// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTab } from './memory-tab.js';

// The Memory tab against a fake REST server (M2): adding a memory of a chosen
// kind, moving one to another kind while editing it, and deleting one.

const BOT = '00000000-0000-4000-8000-0000000000b1';

interface Item {
  id: string;
  botId: string;
  kind: string;
  content: string;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    items: [] as Item[],
    requests: [] as { method: string; path: string; body?: unknown }[],
    handle: (async () => Response.error()) as (request: Request) => Promise<Response>,
  };
  // The api client keeps the fetch it was created with, so swap it before any import.
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    state.handle(input instanceof Request ? input : new Request(String(input), init));
  return state;
});

const memory = (n: number, kind: string, content: string): Item => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  botId: BOT,
  kind,
  content,
  sourceRunId: null,
  createdAt: `2026-10-18T10:0${n}:00.000Z`,
  updatedAt: `2026-10-18T10:0${n}:00.000Z`,
});

beforeEach(() => {
  server.items = [memory(1, 'fact', 'Fiscal year starts in April')];
  server.requests = [];
  server.handle = async (request) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    server.requests.push({ method: request.method, path: pathname, body });
    const list = `/api/v1/bots/${BOT}/memories`;
    if (pathname === list && request.method === 'GET')
      return Response.json({ items: server.items });
    if (pathname === list && request.method === 'POST') {
      const { kind, content } = body as { kind: string; content: string };
      const created = memory(server.items.length + 1, kind, content);
      server.items = [created, ...server.items];
      return Response.json(created, { status: 201 });
    }
    const one = server.items.find((m) => pathname === `${list}/${m.id}`);
    if (one && request.method === 'PATCH') {
      Object.assign(one, body);
      return Response.json(one);
    }
    if (one && request.method === 'DELETE') {
      server.items = server.items.filter((m) => m !== one);
      return new Response(null, { status: 204 });
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryTab botId={BOT} />
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

const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const section = (title: string) =>
  [...host.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === title);

function set(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function submit(form: HTMLFormElement) {
  act(() => {
    form.requestSubmit();
  });
}

describe('the Memory tab', () => {
  it('adds a memory of the chosen kind', async () => {
    render();
    await until(() => !!section('Facts'), 'the list');
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Add memory"]')!;
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="Kind of new memory"]')!;
    expect([...kind.options].map((o) => o.textContent)).toEqual([
      'Preference',
      'Fact',
      'Summary of past work',
    ]);
    expect(kind.value).toBe('fact');

    // Blank text is not sent.
    set(form.querySelector('textarea')!, '   ');
    submit(form);
    expect(server.requests.filter((r) => r.method === 'POST')).toEqual([]);

    set(form.querySelector('textarea')!, '  Bullets, not paragraphs  ');
    set(kind, 'preference');
    submit(form);
    await until(() => !!section('Preferences'), 'the new memory');
    expect(server.requests.find((r) => r.method === 'POST')).toEqual({
      method: 'POST',
      path: `/api/v1/bots/${BOT}/memories`,
      body: { kind: 'preference', content: 'Bullets, not paragraphs' },
    });
    expect(section('Preferences')!.textContent).toContain('Bullets, not paragraphs');
    expect(form.querySelector('textarea')!.value).toBe('');
  });

  it('moves a memory to another kind while editing it', async () => {
    render();
    await until(() => !!section('Facts'), 'the list');
    act(() => button('Edit', section('Facts'))!.click());
    const form = section('Facts')!.querySelector('form')!;
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="Kind"]')!;
    expect(kind.value).toBe('fact');
    set(kind, 'summary');
    submit(form);
    await until(() => !!section('Summaries of past work'), 'the moved memory');
    // Only the kind changed, so only the kind is sent.
    expect(server.requests.find((r) => r.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/api/v1/bots/${BOT}/memories/${server.items[0]!.id}`,
      body: { kind: 'summary' },
    });
    expect(section('Facts')).toBeUndefined();
    expect(host.querySelector('select[aria-label="Kind"]')).toBeNull();
  });

  it('edits text and deletes', async () => {
    render();
    await until(() => !!section('Facts'), 'the list');
    act(() => button('Edit', section('Facts'))!.click());
    const form = section('Facts')!.querySelector('form')!;
    set(form.querySelector('textarea')!, 'Fiscal year starts in May');
    submit(form);
    await until(() => host.textContent!.includes('starts in May'), 'the edit');
    expect(server.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      content: 'Fiscal year starts in May',
    });

    act(() => button('Delete', section('Facts'))!.click());
    await until(() => host.textContent!.includes('Nothing remembered yet.'), 'the delete');
  });
});
