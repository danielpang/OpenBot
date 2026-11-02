// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainBotToggle } from '../features/bots/bot-settings.js';
import { botsQuery, type Bot } from '../features/bots/queries.js';
import { providersQuery, type Provider } from '../features/models/api.js';
import { ProviderCard } from '../features/models/provider-card.js';

// Switches saved as soon as they change (useSavedCheckbox): the Main Bot
// toggle (K8) and a custom provider's "runs on my network" (S-12). Each shows
// the click at once while the server saves, the saved value once the list is
// read back, and the saved value again, with the reason, when saving fails.
// The tools tests cover the connector switches (S-8, S-16).

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    bots: [] as Record<string, unknown>[],
    providers: [] as Record<string, unknown>[],
    /** While set, changes wait for it before the server answers. */
    hold: null as Promise<void> | null,
    /** While set, changes fail with this problem title. */
    fail: null as string | null,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') {
      if (path === '/api/v1/bots') return Response.json({ items: state.bots });
      if (path === '/api/v1/providers') return Response.json({ items: state.providers });
      return Response.json({ items: [] });
    }
    const body = (await request.json()) as Record<string, unknown>;
    await state.hold;
    if (state.fail) return Response.json({ title: state.fail }, { status: 400 });
    const id = path.split('/').at(-1);
    const list = path.startsWith('/api/v1/bots/') ? 'bots' : 'providers';
    state[list] = state[list].map((item) => (item.id === id ? { ...item, ...body } : item));
    return Response.json(state[list].find((item) => item.id === id));
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  server.bots = [];
  server.providers = [];
  server.hold = null;
  server.fail = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

// Polls until `check` holds. A deadline, not a fixed number of 10 ms polls,
// so a busy machine (other suites running) gets time without slowing the
// common case.
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}

const box = (text: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(text))
    ?.querySelector('input');

/** Holds the server's next answers until the returned function is called. */
function holdAnswers() {
  let answer!: () => void;
  server.hold = new Promise((resolve) => (answer = resolve));
  return () => act(() => answer());
}

const BOT_ID = '00000000-0000-4000-8000-0000000000b1';
const bot: Bot = {
  id: BOT_ID,
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
  chatId: BOT_ID,
  state: {
    botId: BOT_ID,
    state: 'idle',
    currentAction: null,
    runId: null,
    updatedAt: '2026-10-16T00:00:00.000Z',
  },
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

const PROVIDER_ID = '00000000-0000-4000-8000-0000000000a2';
const provider: Provider = {
  id: PROVIDER_ID,
  name: 'Ollama',
  slug: 'ollama',
  kind: 'custom',
  protocol: 'openai_compatible',
  baseUrl: 'http://localhost:11434/v1',
  local: false,
  headers: [],
  hasKey: false,
  keyHint: null,
  discovery: 'list_models',
  presetId: 'ollama',
  status: 'untested',
  lastTestedAt: null,
  testResult: null,
  scope: 'organization',
  smallModelId: null,
  botCount: 0,
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

// Each switch as its page shows it: from the list a save reads back.
function ListedBot() {
  const { data } = useQuery(botsQuery);
  const listed = data?.items[0];
  return listed ? <MainBotToggle bot={listed} others={data.items} /> : null;
}

function ListedProvider() {
  const { data } = useQuery(providersQuery);
  const listed = data?.items[0];
  return listed ? <ProviderCard provider={listed} canEdit /> : null;
}

const cases = [
  { name: 'the Main Bot toggle (K8)', label: 'Main Bot', ui: <ListedBot /> },
  {
    name: "a provider's runs on my network (S-12)",
    label: 'Runs on my network',
    ui: <ListedProvider />,
  },
];

describe.each(cases)('$name', ({ label, ui }) => {
  beforeEach(() => {
    server.bots = [{ ...bot }];
    server.providers = [{ ...provider }];
  });

  it('shows the tick at once, while the server saves it', async () => {
    render(ui);
    await until(() => !!box(label), 'the switch');
    const answer = holdAnswers();
    act(() => box(label)!.click());
    expect(box(label)!.checked).toBe(true);
    await until(() => box(label)!.disabled, 'the save to start');
    expect(box(label)!.checked).toBe(true);
    answer();
    await until(() => !box(label)!.disabled, 'the save to finish');
    expect(box(label)!.checked).toBe(true);
  });

  it('shows the saved state again, and why, when saving fails', async () => {
    server.fail = 'Only an admin can change this';
    render(ui);
    await until(() => !!box(label), 'the switch');
    act(() => box(label)!.click());
    expect(box(label)!.checked).toBe(true);
    await until(() => !!host.textContent?.includes(server.fail!), 'the error');
    expect(box(label)!.checked).toBe(false);
    expect(box(label)!.disabled).toBe(false);
  });
});
