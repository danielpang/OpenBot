// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import { COMPUTER_OFF_CLOSE_CODE, type WsEvent, type WsEventOf } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { RightPanelProvider, useRightPanel } from '../../app/right-panel.js';
import { BotTitleBar } from '../bots/bot-view.js';
import { applyBotState, botsQuery, type Bot } from '../bots/queries.js';
import {
  RealtimeContext,
  RealtimeStatusContext,
  type Realtime,
  type RealtimeStatus,
} from '../transcript/realtime.js';
import {
  applyComputerStatus,
  applyScreenControl,
  computerFileUrl,
  computerQuery,
  ptyUrl,
  type Computer,
  type ComputerState,
} from './api.js';
import { ComputerPage } from './computer-page.js';
import { FileBrowser } from './files.js';
import { computerActive } from './status-icon.js';
import { SignInTakeover } from './takeover.js';

// The computer UI against a fake REST server, socket, noVNC and xterm: the
// dot on Preview (I5), the Preview panel and Takeover with its two controls
// (K3), and the Computer page's status, Start or Restart, idle setting,
// terminal and files (K1, K7).

const BOT = '00000000-0000-4000-8000-0000000000b1';
const COMPUTER = '00000000-0000-4000-8000-0000000000c1';
const SCREEN = '00000000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-000000000001';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: string }[],
    handle: (async () => Response.error()) as (request: Request) => Promise<Response>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname, search } = new URL(request.url, 'http://localhost');
    state.requests.push({
      method: request.method,
      path: pathname + search,
      body: request.method === 'GET' ? '' : await request.clone().text(),
    });
    return state.handle(request);
  };
  return state;
});

// noVNC: a fake RFB recording what the view asked of it.
const vnc = vi.hoisted(() => ({
  screens: [] as {
    url: string;
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnected: boolean;
    dispatchEvent(event: Event): boolean;
  }[],
}));
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    url: string;
    viewOnly = false;
    scaleViewport = false;
    resizeSession = true;
    background = '';
    disconnected = false;
    constructor(_target: HTMLElement, url: string) {
      super();
      this.url = url;
      vnc.screens.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {}
  },
}));

// xterm: a fake terminal that records writes and lets the test type.
const xterm = vi.hoisted(() => ({
  written: '',
  type: (_data: string) => {},
  resize: (_size: { cols: number; rows: number }) => {},
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write(data: string) {
      xterm.written += data;
    }
    onData(listener: (data: string) => void) {
      xterm.type = listener;
      return { dispose() {} };
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      xterm.resize = listener;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  receive(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}
const RealWebSocket = globalThis.WebSocket;

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function screen(controlledByUserId: string | null = null) {
  return {
    id: SCREEN,
    botId: BOT,
    display: 10,
    status: 'running' as const,
    controlledByUserId,
    controlledSince: controlledByUserId ? '2026-10-18T10:00:00.000Z' : null,
  };
}

function computer(status: Computer['status'], controlledBy: string | null = null): Computer {
  return {
    id: COMPUTER,
    provider: 'docker',
    status,
    alwaysOn: false,
    idleTimeoutMin: 30,
    lastUsedAt: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    screens: [screen(controlledBy)],
  };
}

function bot(fields: Partial<Bot['state']> = {}): Bot {
  return {
    id: BOT,
    handle: 'scout',
    name: 'Scout',
    label: 'Research',
    description: '',
    avatar: { kind: 'generated', seed: 'Scout' },
    modelConfig: null,
    toolPolicy: {},
    pinned: false,
    hidden: false,
    isMain: false,
    chatId: BOT,
    state: {
      botId: BOT,
      state: 'idle',
      currentAction: null,
      runId: null,
      currentTool: null,
      updatedAt: '2026-10-18T10:00:00.000Z',
      ...fields,
    },
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  };
}

const files: Record<string, { name: string; type: 'file' | 'dir'; size: number }[]> = {
  '/home/bot': [
    { name: 'notes.txt', type: 'file', size: 2048 },
    { name: 'projects', type: 'dir', size: 0 },
  ],
  '/home/bot/projects': [{ name: 'plan.md', type: 'file', size: 12 }],
};

let state: ComputerState;
let controlledBy: string | null;
beforeEach(() => {
  server.requests = [];
  vnc.screens = [];
  xterm.written = '';
  FakeSocket.sockets = [];
  controlledBy = null;
  state = { available: true, computer: computer('running') };
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
  server.handle = async (request) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    if (pathname === '/api/v1/computer' && request.method === 'PATCH') {
      const patch = (await request.json()) as Partial<Computer>;
      state = { ...state, computer: { ...state.computer!, ...patch } };
      return Response.json(state.computer);
    }
    if (pathname === '/api/v1/computer') return Response.json(state);
    if (pathname === '/api/v1/computer/start') {
      state = { ...state, computer: computer('running') };
      return Response.json(state.computer);
    }
    if (pathname === '/api/v1/computer/restart') {
      state = { ...state, computer: computer('running') };
      return Response.json(state.computer);
    }
    if (pathname === '/api/v1/computer/files') {
      const path = searchParams.get('path') ?? '/home/bot';
      const entries = (files[path] ?? []).map((e) => ({ ...e, mtime: '2026-10-18T10:00:00Z' }));
      return Response.json({ path, entries });
    }
    if (pathname.startsWith('/api/v1/computer/files/') && request.method === 'PUT') {
      const name = decodeURIComponent(pathname.split('/').at(-1)!);
      const size = (await request.arrayBuffer()).byteLength;
      files['/home/bot']!.push({ name, type: 'file', size });
      return Response.json({ path: `/home/bot/${name}`, size });
    }
    if (pathname === `/api/v1/bots/${BOT}/screen/control`) {
      const { action } = (await request.json()) as { action: string };
      controlledBy = action === 'take' ? USER : null;
      return Response.json(screen(controlledBy));
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
  globalThis.WebSocket = RealWebSocket;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeRealtime() {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const client = {
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as WsClient;
  const realtime: Realtime = { client, onResync: () => () => {} };
  const emit = (type: string, payload: unknown, scope: Partial<WsEvent> = {}) =>
    act(() => {
      for (const h of handlers.get(type) ?? []) h({ type, ts: 0, ...scope, payload } as WsEvent);
    });
  return { realtime, emit };
}

let root: Root | undefined;
let host: HTMLElement;
let live: ReturnType<typeof fakeRealtime>;
let queryClient: QueryClient;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  localStorage.clear();
});

function Slot() {
  const { content } = useRightPanel();
  return content ? <aside>{content}</aside> : null;
}

function render(ui: ReactNode, { computer = true } = {}) {
  live = fakeRealtime();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    computer,
    deployment: 'self_hosted',
  });
  queryClient.setQueryData(botsQuery.queryKey, { items: [bot()] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RealtimeContext value={live.realtime}>
          <RightPanelProvider>
            {ui}
            <Slot />
          </RightPanelProvider>
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
  return host;
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${document.body.textContent}`);
}

const button = (label: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
const click = (el: Element | undefined | null) => act(() => (el as HTMLElement).click());
const posts = (path: string) =>
  server.requests.filter((r) => r.method !== 'GET' && r.path === path).map((r) => r.body);

describe('the computer dot on Preview (I5)', () => {
  it('lights only while the Bot is working with a computer tool', () => {
    expect(computerActive(bot({ state: 'working', currentTool: 'bash' }).state)).toBe(true);
    expect(computerActive(bot({ state: 'working', currentTool: 'browser_click' }).state)).toBe(
      true,
    );
    expect(computerActive(bot({ state: 'working', currentTool: 'web_search' }).state)).toBe(false);
    expect(computerActive(bot({ state: 'idle', currentTool: null }).state)).toBe(false);
  });

  it('follows bot.state, which carries the current tool', () => {
    const working = {
      type: 'bot.state',
      ts: 1,
      bot_id: BOT,
      payload: {
        botId: BOT,
        state: 'working',
        currentAction: 'Opening example.com',
        runId: null,
        currentTool: 'browser_navigate',
      },
    } as WsEventOf<'bot.state'>;
    const [next] = applyBotState([bot()], working);
    render(<BotTitleBar bot={next!} />);
    // A dot on the Preview button itself, not an icon beside it.
    const preview = button('Computer')!;
    const dot = preview.querySelector('[data-active]');
    expect(dot?.getAttribute('aria-label')).toBe('Using its computer');
    expect(dot?.getAttribute('title')).toBe('Opening example.com');
    expect(preview.getAttribute('title')).toBe('Opening example.com');
    expect(host.querySelectorAll('[role="img"][aria-label="Using its computer"]')).toHaveLength(1);

    act(() => root!.render(<></>));
    render(<BotTitleBar bot={bot()} />);
    expect(host.querySelector('[data-active]')).toBeNull();
    expect(button('Computer')!.hasAttribute('title')).toBe(false);
    expect(host.querySelector('[aria-label="Computer idle"]')).toBeNull();
  });

  it('is absent, with the Preview toggle, on an install without a computer', () => {
    render(<BotTitleBar bot={bot({ state: 'working', currentTool: 'bash' })} />, {
      computer: false,
    });
    expect(host.querySelector('[data-active]')).toBeNull();
    expect(button('Computer')).toBeUndefined();
  });
});

describe('The Computer panel and Takeover (K3)', () => {
  it('opens a view-only screen in the right panel and closes it again', async () => {
    render(<BotTitleBar bot={bot()} />);
    const toggle = button('Computer')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    await until(() => vnc.screens.length === 1, 'the screen');
    const panel = host.querySelector('aside')!;
    expect(panel.querySelector('h2')?.textContent).toBe('Computer');
    expect(vnc.screens[0]!.url).toBe(`ws://localhost:3000/api/v1/bots/${BOT}/screen/vnc`);
    expect(vnc.screens[0]!.viewOnly).toBe(true);
    expect(vnc.screens[0]!.scaleViewport).toBe(true);
    expect(vnc.screens[0]!.resizeSession).toBe(false);
    expect(button('Computer')!.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem(`openbots.panel.${BOT}`)!)).toEqual({ kind: 'screen' });

    act(() => vnc.screens[0]!.dispatchEvent(new Event('connect')));
    expect(panel.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('connected');

    click(button('Computer'));
    expect(host.querySelector('aside')).toBeNull();
    expect(vnc.screens[0]!.disconnected).toBe(true);
  });

  it('starts a stopped computer once when the panel opens, and shows its screen', async () => {
    state = { available: true, computer: computer('stopped') };
    render(<BotTitleBar bot={bot()} />);
    click(button('Computer'));
    await until(() => posts('/api/v1/computer/start').length === 1, 'the start');
    await until(() => vnc.screens.length === 1, 'the screen');
    expect(posts('/api/v1/computer/start')).toHaveLength(1);
  });

  it('waits for a hidden tab to come into view before it starts the computer', async () => {
    state = { available: true, computer: computer('stopped') };
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      render(<BotTitleBar bot={bot()} />);
      click(button('Computer'));
      await until(
        () =>
          !!host
            .querySelector('aside')
            ?.textContent?.includes("The computer is off. Start it to see Scout's screen."),
        'the off message',
      );
      expect(posts('/api/v1/computer/start')).toHaveLength(0);
      visibility.mockReturnValue('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await until(() => posts('/api/v1/computer/start').length === 1, 'the start');
    } finally {
      visibility.mockRestore();
    }
  });

  it('shows a computer that went off while the tab missed it, without starting it', async () => {
    render(<BotTitleBar bot={bot()} />);
    click(button('Computer'));
    await until(() => vnc.screens.length === 1, 'the screen');
    // Stopped elsewhere; the proxy refuses the screen and noVNC disconnects.
    state = { available: true, computer: computer('stopped') };
    act(() => vnc.screens[0]!.dispatchEvent(new Event('disconnect')));
    await until(
      () =>
        !!host
          .querySelector('aside')
          ?.textContent?.includes("The computer is off. Start it to see Scout's screen."),
      'the off message',
    );
    expect(posts('/api/v1/computer/start')).toHaveLength(0);
  });

  it('takes over full screen with exactly two controls and reflects screen.control', async () => {
    render(<BotTitleBar bot={bot()} />);
    click(button('Computer'));
    await until(() => vnc.screens.length === 1, 'the preview');
    click(button('Open full screen'));
    await until(() => vnc.screens.length === 2, 'the full-screen view');

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe("Scout's screen");
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Take control',
      'Hand back',
    ]);
    const view = vnc.screens[1]!;
    expect(view.viewOnly).toBe(true);
    // Takeover's socket is the control one, which the server hands back when it is gone (K3).
    expect(view.url).toBe(`ws://localhost:3000/api/v1/bots/${BOT}/screen/vnc?control=1`);
    expect(vnc.screens[0]!.url).not.toContain('control');

    click(button('Take control', dialog));
    await until(() => !view.viewOnly, 'control');
    expect(posts(`/api/v1/bots/${BOT}/screen/control`)).toEqual(['{"action":"take"}']);
    expect(button('Take control', dialog)!.disabled).toBe(true);
    expect(dialog.textContent).toContain('Scout waits until you hand it back');

    // Handed back elsewhere (another tab): the view goes back to watching.
    live.emit(
      'screen.control',
      { screenId: SCREEN, controller: 'bot', userId: null, botId: BOT, display: 10 },
      { bot_id: BOT },
    );
    await until(() => view.viewOnly, 'the hand back from elsewhere');
    expect(button('Take control', dialog)!.disabled).toBe(false);

    live.emit(
      'screen.control',
      { screenId: SCREEN, controller: 'user', userId: USER, botId: BOT, display: 10 },
      { bot_id: BOT },
    );
    await until(() => !view.viewOnly, 'the take from elsewhere');

    click(button('Hand back', dialog));
    await until(() => !document.body.querySelector('[role="dialog"]'), 'leaving full screen');
    expect(posts(`/api/v1/bots/${BOT}/screen/control`)).toEqual([
      '{"action":"take"}',
      '{"action":"release"}',
    ]);
    expect(view.disconnected).toBe(true);
  });

  it('takes control at once on the sign-in page for a sign-in request (K8)', async () => {
    let closed = false;
    render(
      <SignInTakeover
        botId={BOT}
        url="https://github.com/login"
        onClose={() => {
          closed = true;
        }}
      />,
    );
    await until(() => vnc.screens.length === 1, 'the full-screen view');
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe("Scout's screen");
    await until(() => !vnc.screens[0]!.viewOnly, 'control');
    expect(posts(`/api/v1/bots/${BOT}/screen/control`)).toEqual([
      '{"action":"take","url":"https://github.com/login"}',
    ]);

    click(button('Hand back', dialog));
    await until(() => closed, 'the hand back');
    expect(posts(`/api/v1/bots/${BOT}/screen/control`).at(-1)).toBe('{"action":"release"}');
  });

  it('leaves full screen with Hand back or Escape when only watching', async () => {
    render(<BotTitleBar bot={bot()} />);
    click(button('Computer'));
    await until(() => vnc.screens.length === 1, 'the preview');
    click(button('Open full screen'));
    await until(() => !!document.body.querySelector('[role="dialog"]'), 'full screen');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    click(button('Open full screen'));
    click(button('Hand back'));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(posts(`/api/v1/bots/${BOT}/screen/control`)).toEqual([]);
  });
});

describe('the Computer page', () => {
  it('says so when the install has no computer', async () => {
    state = { available: false, computer: null };
    render(<ComputerPage />);
    await until(() => !!host.textContent?.includes('no computer'), 'the message');
    expect(button('Start')).toBeUndefined();
  });

  it('starts the computer, showing the image pull from computer.status', async () => {
    state = { available: true, computer: null };
    let finish!: () => void;
    const handle = server.handle;
    server.handle = async (request) => {
      if (new URL(request.url).pathname === '/api/v1/computer/start') {
        await new Promise<void>((resolve) => (finish = resolve));
      }
      return handle(request);
    };
    render(<ComputerPage />);
    await until(() => !!button('Start'), 'Start');
    expect(host.querySelector('[data-status]')?.textContent).toBe('Not started');
    expect(host.querySelector('[aria-label="Idle"]'), 'no computer to set yet').toBeNull();
    click(button('Start'));
    await until(() => !!host.querySelector('[role="progressbar"]'), 'the pull progress');
    expect(host.querySelector('[data-status]')?.textContent).toBe('Setting up');

    // The row exists now; the next event moves it along.
    state = { available: true, computer: computer('creating') };
    live.emit('computer.status', { computerId: COMPUTER, status: 'creating' }, { user_id: USER });
    await until(
      () =>
        queryClient.getQueryData<ComputerState>(computerQuery.queryKey)?.computer?.status ===
        'creating',
      'the refetched row',
    );
    live.emit('computer.status', { computerId: COMPUTER, status: 'starting' }, { user_id: USER });
    await until(() => host.querySelector('[data-status]')?.textContent === 'Starting', 'starting');
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Starting');

    act(() => finish());
    await until(() => host.querySelector('[data-status]')?.textContent === 'Running', 'running');
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(posts('/api/v1/computer/start')).toHaveLength(1);
    expect(host.textContent).toContain('Terminal');
    expect(host.textContent).toContain('Files');
    expect(button('Start')).toBeUndefined();
    expect(button('Restart')).toBeDefined();
  });

  it('shows a failure from computer.status', async () => {
    render(<ComputerPage />);
    await until(() => !!button('Restart'), 'Restart');
    live.emit(
      'computer.status',
      { computerId: COMPUTER, status: 'error', error: 'image pull failed' },
      { user_id: USER },
    );
    await until(
      () => host.querySelector('[data-status]')?.textContent === 'Not working',
      'the error',
    );
    expect(host.textContent).toContain('image pull failed');
    expect(button('Start')).toBeDefined();
  });

  it('follows a start the server began on its own, with no reload (plan 9.5)', async () => {
    state = { available: true, computer: computer('stopped') };
    render(<ComputerPage />);
    await until(() => host.querySelector('[data-status]')?.textContent === 'Stopped', 'stopped');
    // The Mac app's launch, or an owner's message to a Bot, woke it.
    live.emit('computer.status', { computerId: COMPUTER, status: 'starting' }, { user_id: USER });
    await until(() => host.querySelector('[data-status]')?.textContent === 'Starting', 'starting');
    live.emit('computer.status', { computerId: COMPUTER, status: 'running' }, { user_id: USER });
    await until(() => host.querySelector('[data-status]')?.textContent === 'Running', 'running');
    expect(button('Restart')).toBeDefined();
    expect(posts('/api/v1/computer/start')).toHaveLength(0);
  });

  it('catches up on a start it missed before the socket opened', async () => {
    state = { available: true, computer: computer('stopped') };
    let connect!: () => void;
    function Connecting({ children }: { children: ReactNode }) {
      const [status, setStatus] = useState<RealtimeStatus>({
        status: 'connecting',
        everOpen: false,
      });
      connect = () => setStatus({ status: 'open', everOpen: true });
      return <RealtimeStatusContext value={status}>{children}</RealtimeStatusContext>;
    }
    render(
      <Connecting>
        <ComputerPage />
      </Connecting>,
    );
    await until(() => host.querySelector('[data-status]')?.textContent === 'Stopped', 'stopped');
    // Started while no socket was open: its events went nowhere.
    state = { available: true, computer: computer('running') };
    act(() => connect());
    await until(() => host.querySelector('[data-status]')?.textContent === 'Running', 'running');
    expect(posts('/api/v1/computer/start')).toHaveLength(0);
  });

  it('shows that a start is updating the computer after an upgrade (plan 16.3)', async () => {
    render(<ComputerPage />);
    await until(() => !!button('Restart'), 'Restart');
    live.emit('computer.status', { computerId: COMPUTER, status: 'updating' }, { user_id: USER });
    await until(() => host.querySelector('[data-status]')?.textContent === 'Updating', 'updating');
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(button('Restart')).toBeUndefined();
  });

  it('sets how long the computer idles before it stops, or never (plan 9.5)', async () => {
    render(<ComputerPage />);
    await until(() => !!host.querySelector('select[name="idle"]'), 'the idle setting');
    const idle = host.querySelector<HTMLSelectElement>('select[name="idle"]')!;
    expect(idle.value).toBe('30');
    expect([...idle.options].map((o) => o.textContent)).toEqual([
      '15 min',
      '30 min',
      '1 hour',
      '2 hours',
      '4 hours',
      '8 hours',
      '1 day',
      'Never',
    ]);
    const choose = async (value: string) => {
      const patches = server.requests.filter((r) => r.method === 'PATCH').length;
      act(() => {
        idle.value = value;
        idle.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(
        () =>
          server.requests.filter((r) => r.method === 'PATCH').length > patches &&
          !idle.disabled &&
          // The answer is written back, not just sent: a busy runner reaches here between the two.
          idle.value === value,
        `saved ${value}`,
      );
    };

    await choose('120');
    await choose('never');
    expect(
      server.requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body]),
    ).toEqual([
      ['/api/v1/computer', '{"alwaysOn":false,"idleTimeoutMin":120}'],
      ['/api/v1/computer', '{"alwaysOn":true}'],
    ]);
    expect(queryClient.getQueryData<ComputerState>(computerQuery.queryKey)?.computer).toMatchObject(
      { alwaysOn: true, idleTimeoutMin: 120 },
    );
    expect(idle.value).toBe('never');
  });

  it('keeps an idle time set outside the choices selectable', async () => {
    state = { available: true, computer: { ...computer('stopped'), idleTimeoutMin: 90 } };
    render(<ComputerPage />);
    await until(() => !!host.querySelector('select[name="idle"]'), 'the idle setting');
    const idle = host.querySelector<HTMLSelectElement>('select[name="idle"]')!;
    expect(idle.value).toBe('90');
    expect(idle.selectedOptions[0]?.textContent).toBe('90 min');
    expect(button('Start')).toBeDefined();
    expect(button('Restart')).toBeUndefined();
  });

  it('restarts the computer, which reopens the terminal', async () => {
    let finish!: () => void;
    const handle = server.handle;
    server.handle = async (request) => {
      if (new URL(request.url).pathname === '/api/v1/computer/restart') {
        await new Promise<void>((resolve) => (finish = resolve));
      }
      return handle(request);
    };
    render(<ComputerPage />);
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    click(button('Restart'));
    await until(() => !!button('Restart')?.disabled, 'Restart pending');
    live.emit('computer.status', { computerId: COMPUTER, status: 'stopping' }, { user_id: USER });
    await until(() => host.querySelector('[data-status]')?.textContent === 'Stopping', 'stopping');
    expect(host.textContent).not.toContain('Terminal');
    expect(FakeSocket.sockets[0]!.readyState).toBe(3);

    act(() => finish());
    await until(() => host.querySelector('[data-status]')?.textContent === 'Running', 'running');
    expect(posts('/api/v1/computer/restart')).toHaveLength(1);
    await until(() => FakeSocket.sockets.length === 2, 'a new terminal socket');
  });

  it('runs a terminal over /computer/pty', async () => {
    render(<ComputerPage />);
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    const socket = FakeSocket.sockets[0]!;
    expect(socket.url).toBe('ws://localhost:3000/api/v1/computer/pty?cols=100&rows=30');
    expect(host.textContent).toContain('Connecting…');
    socket.open();
    expect(host.textContent).not.toContain('Connecting…');

    socket.receive({ type: 'output', data: 'bot@computer:~$ ' });
    expect(xterm.written).toBe('bot@computer:~$ ');
    act(() => xterm.type('ls\r'));
    act(() => xterm.resize({ cols: 120, rows: 40 }));
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);

    socket.receive({ type: 'exit', exitCode: 0 });
    act(() => socket.onclose?.({ code: 1000 }));
    expect(xterm.written).toContain('[exited with 0]');
    click(button('Reconnect'));
    expect(FakeSocket.sockets).toHaveLength(2);
  });

  it('says the computer is off when the terminal socket closes with COMPUTER_OFF', async () => {
    render(<ComputerPage />);
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    const refetches = server.requests.filter((r) => r.path === '/api/v1/computer').length;
    state = { available: true, computer: computer('stopped') };
    act(() => FakeSocket.sockets[0]!.onclose?.({ code: COMPUTER_OFF_CLOSE_CODE }));
    await until(() => host.querySelector('[data-status]')?.textContent === 'Stopped', 'stopped');
    expect(server.requests.filter((r) => r.path === '/api/v1/computer').length).toBe(refetches + 1);
    expect(button('Start')).toBeDefined();
    expect(posts('/api/v1/computer/start')).toHaveLength(0);
  });

  it('offers Start when the file listing finds the computer off', async () => {
    const handle = server.handle;
    let off = true;
    server.handle = async (request) => {
      if (off && new URL(request.url).pathname === '/api/v1/computer/files') {
        return Response.json(
          { title: 'Conflict', status: 409, code: 'COMPUTER_OFF', detail: 'The computer is off.' },
          { status: 409 },
        );
      }
      return handle(request);
    };
    render(<FileBrowser />);
    await until(() => !!host.querySelector('[data-computer="off"]'), 'the off message');
    expect(host.textContent).toContain('The computer is off.');
    expect(posts('/api/v1/computer/start')).toHaveLength(0);
    off = false;
    click(button('Start'));
    await until(() => !!host.querySelector('[aria-label="Files"] li'), 'the listing');
    expect(posts('/api/v1/computer/start')).toHaveLength(1);
  });

  it('browses, downloads and uploads files under /home/bot (K7)', async () => {
    render(<ComputerPage />);
    await until(() => !!host.querySelector('[aria-label="Files"] li'), 'the listing');
    const rows = () =>
      [...host.querySelectorAll('[aria-label="Files"] li')].map((li) => li.textContent);
    expect(rows()).toEqual(['projects/', 'notes.txt2.0 KB']);
    const download = host.querySelector<HTMLAnchorElement>('[aria-label="Files"] a')!;
    expect(download.getAttribute('href')).toBe('/api/v1/computer/files/notes.txt');
    expect(download.hasAttribute('download')).toBe(true);

    click(button('projects/'));
    await until(() => rows()[0] === 'plan.md12 B', 'the subfolder');
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('projects');
    expect(
      host.querySelector<HTMLAnchorElement>('[aria-label="Files"] a')!.getAttribute('href'),
    ).toBe('/api/v1/computer/files/projects/plan.md');
    click(button('home'));
    await until(() => rows()[0] === 'projects/', 'home again');

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['hello world'], 'my report.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => rows().includes('my report.txt11 B'), 'the uploaded file');
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.path).toBe('/api/v1/computer/files/my%20report.txt');
    expect(put.body).toBe('hello world');
  });
});

describe('Reset computer', () => {
  function resetServer(answer: 'ok' | 'not-prepared' = 'ok') {
    let polls = 0;
    const handle = server.handle;
    server.handle = async (request) => {
      const { pathname } = new URL(request.url, 'http://localhost');
      if (pathname === '/api/v1/computer/reset/prepare') {
        return Response.json({ requestId: 'r1' }, { status: 202 });
      }
      if (pathname === '/api/v1/computer/reset/r1') {
        polls += 1;
        return Response.json(
          polls < 2
            ? { status: 'running', results: [], unsaved: [], runningSessions: [] }
            : {
                status: 'done',
                results: [
                  {
                    repoId: '00000000-0000-4000-8000-0000000000a1',
                    fullName: 'danielpang/OpenBots',
                    branch: 'openbots/rescue/2026-11-05T10-30',
                    pushed: true,
                    note: 'Pushed 2 commits and the uncommitted changes.',
                  },
                ],
                unsaved: [
                  {
                    fullName: 'danielpang/notes',
                    branch: 'drafts',
                    note: 'The connection cannot push to this repository.',
                  },
                ],
                runningSessions: [{ id: 's1', botId: BOT, repoFullName: 'danielpang/OpenBots' }],
              },
        );
      }
      if (pathname === '/api/v1/computer/reset') {
        return answer === 'ok'
          ? new Response(null, { status: 202 })
          : Response.json(
              {
                title: 'Conflict',
                code: 'RESET_NOT_PREPARED',
                detail: 'Check for unpushed work first.',
              },
              { status: 409 },
            );
      }
      if (pathname === '/api/v1/repos') return Response.json({ repos: [] });
      return handle(request);
    };
  }

  it(
    'checks for unpushed work, shows what was saved and what was not, then resets',
    { timeout: 15_000 },
    async () => {
      resetServer();
      render(<ComputerPage />);
      await until(() => !!button('Reset computer'), 'Reset computer');
      expect(button('Restart')).toBeDefined();
      click(button('Reset computer'));
      await until(
        () => !!document.body.textContent?.includes('Checking for unpushed work'),
        'the check',
      );
      expect(button('Reset')!.disabled).toBe(true);
      await until(() => !!document.querySelector('[data-reset="checked"]'), 'the results');
      const dialog = document.querySelector('[data-reset]')!;
      expect(
        dialog.querySelector('[data-reset-pushed="danielpang/OpenBots"]')!.textContent,
      ).toContain('openbots/rescue/2026-11-05T10-30');
      expect(
        dialog.querySelector('[data-reset-unsaved="danielpang/notes"]')!.textContent,
      ).toContain('The connection cannot push to this repository.');
      expect(dialog.textContent).toContain('1 coding session is running. Reset stops it.');
      expect(document.body.textContent).toContain(
        'The computer starts again with an empty home. Repositories marked keep cloned are cloned again.',
      );
      expect(document.body.textContent).not.toMatch(/[–—]| - /);
      click(dialog.querySelector('input[name="resetSignIns"]'));
      click(button('Reset'));
      await until(() => posts('/api/v1/computer/reset').length === 1, 'the reset');
      expect(JSON.parse(posts('/api/v1/computer/reset')[0]!)).toEqual({
        requestId: 'r1',
        confirm: true,
        resetSignIns: true,
      });
      expect(posts('/api/v1/computer/reset/prepare')).toHaveLength(1);
      await until(() => !document.querySelector('[data-reset]'), 'the dialog to close');
    },
  );

  it('says so plainly when the server has no finished check', { timeout: 15_000 }, async () => {
    resetServer('not-prepared');
    render(<ComputerPage />);
    await until(() => !!button('Reset computer'), 'Reset computer');
    click(button('Reset computer'));
    await until(() => !!document.querySelector('[data-reset="checked"]'), 'the results');
    click(button('Reset'));
    await until(
      () => !!document.body.textContent?.includes('The check is out of date.'),
      'the error',
    );
    expect(button('Reset')!.disabled).toBe(true);
    click(button('Check again'));
    await until(() => posts('/api/v1/computer/reset/prepare').length === 2, 'a new check');
  });
});

describe('terminal attach (CA7, I15)', () => {
  it('opens the terminal in a directory, as another user, with a command typed', async () => {
    render(
      <ComputerPage
        attach={{
          cwd: '/home/bot/repos/o/r/.worktrees/bot-x',
          user: 'coder',
          preset: 'claude --resume 7f3a',
        }}
      />,
    );
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    const url = new URL(FakeSocket.sockets[0]!.url);
    expect(url.pathname).toBe('/api/v1/computer/pty');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cols: '100',
      rows: '30',
      cwd: '/home/bot/repos/o/r/.worktrees/bot-x',
      user: 'coder',
      preset: 'claude --resume 7f3a',
    });
    expect(host.querySelector('[data-terminal-cwd]')?.textContent).toBe(
      'coder in /home/bot/repos/o/r/.worktrees/bot-x',
    );
  });

  it('builds the PTY URL with only the parameters given', () => {
    expect(ptyUrl(80, 24, { cwd: '/home/bot/a b' })).toBe(
      'ws://localhost:3000/api/v1/computer/pty?cols=80&rows=24&cwd=%2Fhome%2Fbot%2Fa+b',
    );
    expect(ptyUrl(80, 24)).toBe('ws://localhost:3000/api/v1/computer/pty?cols=80&rows=24');
  });
});

describe('Repositories (GH3)', () => {
  const REPO = '00000000-0000-4000-8000-0000000000r1';
  const checkout = (over: object) => ({
    state: 'ready',
    path: '/home/bot/repos/danielpang/OpenBots',
    ahead: 0,
    behind: 0,
    headSha: 'abc',
    lastFetchAt: null,
    error: null,
    ...over,
  });
  const repo = (id: string, fullName: string, check: ReturnType<typeof checkout> | null) => ({
    id,
    fullName,
    remoteUrl: `https://github.com/${fullName}.git`,
    defaultBranch: 'main',
    keepCloned: true,
    pinned: false,
    description: null,
    lastUsedAt: null,
    checkout: check,
  });
  let repos: ReturnType<typeof repo>[];

  beforeEach(() => {
    repos = [
      repo(REPO, 'danielpang/OpenBots', checkout({})),
      repo(
        'r2',
        'danielpang/openbots-relay',
        checkout({ state: 'behind', behind: 6, path: '/home/bot/repos/danielpang/openbots-relay' }),
      ),
      repo('r3', 'danielpang/site', null),
      repo('r4', 'danielpang/notes', checkout({ state: 'dirty' })),
      repo('r5', 'danielpang/broken', checkout({ state: 'error', error: 'Authentication failed' })),
      repo('r6', 'danielpang/big', checkout({ state: 'cloning', path: null })),
    ];
    const handle = server.handle;
    server.handle = async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/v1/repos' && request.method === 'GET') return Response.json({ repos });
      if (pathname === '/api/v1/repos' && request.method === 'POST') {
        const body = (await request.json()) as { remoteUrl: string };
        const added = repo('r7', 'danielpang/new', checkout({ state: 'cloning', path: null }));
        added.remoteUrl = body.remoteUrl;
        repos = [...repos, added];
        return Response.json({ repo: added }, { status: 201 });
      }
      const match = /^\/api\/v1\/repos\/([^/]+)(?:\/(clone|update))?$/.exec(pathname);
      if (match) {
        const [, id, action] = match;
        if (request.method === 'DELETE') {
          repos = repos.filter((r) => r.id !== id);
          return Response.json({
            filesDeleted: false,
            path: null,
            note: 'The clone stays on the computer.',
          });
        }
        const next = repos.find((r) => r.id === id)!;
        const updated = {
          ...next,
          checkout: checkout({
            state: action === 'clone' ? 'cloning' : 'ready',
            path: next.checkout?.path ?? null,
          }),
        };
        repos = repos.map((r) => (r.id === id ? updated : r));
        return Response.json({ repo: updated });
      }
      return handle(request);
    };
  });

  const row = (name: string) => host.querySelector<HTMLElement>(`[data-repo="${name}"]`)!;
  const pill = (name: string) => row(name).querySelector('[data-state]')!.textContent;

  it('lists each repository with its state, branch and path', async () => {
    render(<ComputerPage />);
    await until(() => !!row('danielpang/big'), 'the list');
    expect(pill('danielpang/OpenBots')).toBe('Ready');
    expect(pill('danielpang/openbots-relay')).toBe('Behind by 6');
    expect(pill('danielpang/site')).toBe('Missing');
    expect(pill('danielpang/notes')).toBe('Local changes');
    expect(pill('danielpang/broken')).toBe('Error');
    expect(row('danielpang/broken').textContent).toContain('Authentication failed');
    expect(pill('danielpang/big')).toBe('Cloning');
    expect(row('danielpang/big').querySelector('svg')).not.toBeNull();
    expect(row('danielpang/OpenBots').textContent).toContain(
      'main · /home/bot/repos/danielpang/OpenBots',
    );
    expect(row('danielpang/site').textContent).toContain('not on this computer');
    expect(button('Clone', row('danielpang/site'))).toBeDefined();
    expect(button('Update', row('danielpang/site'))).toBeUndefined();
    expect(button('Open terminal', row('danielpang/big'))).toBeUndefined();
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('updates and clones', async () => {
    render(<ComputerPage />);
    await until(() => !!row('danielpang/site'), 'the list');
    click(button('Update', row('danielpang/openbots-relay')));
    await until(() => pill('danielpang/openbots-relay') === 'Ready', 'updated');
    expect(posts('/api/v1/repos/r2/update')).toHaveLength(1);
    click(button('Clone', row('danielpang/site')));
    await until(() => pill('danielpang/site') === 'Cloning', 'cloning');
    expect(posts('/api/v1/repos/r3/clone')).toHaveLength(1);
  });

  it('opens the terminal in a repository', async () => {
    render(<ComputerPage />);
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    await until(() => !!row('danielpang/OpenBots'), 'the list');
    click(button('Open terminal', row('danielpang/OpenBots')));
    await until(() => FakeSocket.sockets.length === 2, 'a new terminal socket');
    expect(new URL(FakeSocket.sockets[1]!.url).searchParams.get('cwd')).toBe(
      '/home/bot/repos/danielpang/OpenBots',
    );
  });

  it('forgets a repository only after the inline confirm', async () => {
    render(<ComputerPage />);
    await until(() => !!row('danielpang/notes'), 'the list');
    click(button('Forget', row('danielpang/notes')));
    expect(row('danielpang/notes').textContent).toContain('Forget danielpang/notes?');
    click(button('Keep it', row('danielpang/notes')));
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
    click(button('Forget', row('danielpang/notes')));
    click(button('Forget', row('danielpang/notes')));
    await until(() => !row('danielpang/notes'), 'forgotten');
    expect(server.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/api/v1/repos/r4',
    ]);
    await until(() => !!document.querySelector('[data-toast]'), 'the toast');
    expect(document.querySelector('[data-toast]')!.textContent).toContain(
      'The clone stays on the computer.',
    );
  });

  it('adds a repository by URL, kept cloned by default', async () => {
    render(<ComputerPage />);
    await until(() => !!row('danielpang/OpenBots'), 'the list');
    click(button('Add by URL'));
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Add repository"]')!;
    expect(form.querySelector<HTMLInputElement>('input[name="keepCloned"]')!.checked).toBe(true);
    const input = form.querySelector<HTMLInputElement>('input[name="remoteUrl"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'https://github.com/danielpang/new.git',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => form.requestSubmit());
    await until(() => !!row('danielpang/new'), 'the new repository');
    expect(posts('/api/v1/repos')).toEqual([
      JSON.stringify({ remoteUrl: 'https://github.com/danielpang/new.git', keepCloned: true }),
    ]);
    expect(host.querySelector('form[aria-label="Add repository"]')).toBeNull();
  });

  it('refetches on computer.status', async () => {
    render(<ComputerPage />);
    await until(() => !!row('danielpang/OpenBots'), 'the list');
    const before = server.requests.filter((r) => r.path === '/api/v1/repos').length;
    repos = repos.map((r) => ({ ...r, checkout: null }));
    live.emit('computer.status', { computerId: COMPUTER, status: 'running' }, { user_id: USER });
    await until(() => pill('danielpang/OpenBots') === 'Missing', 'the refetch');
    expect(server.requests.filter((r) => r.path === '/api/v1/repos').length).toBeGreaterThan(
      before,
    );
  });
});

describe('the computer cache', () => {
  const event = <T extends 'computer.status' | 'screen.control'>(type: T, payload: unknown) =>
    ({ type, ts: Date.parse('2026-10-18T11:00:00.000Z'), payload }) as WsEventOf<T>;

  it('applies computer.status, or asks for a refetch when it cannot', () => {
    const next = applyComputerStatus(
      { available: true, computer: computer('running') },
      event('computer.status', { computerId: COMPUTER, status: 'stopping' }),
    );
    expect(next?.computer?.status).toBe('stopping');
    expect(
      applyComputerStatus(
        { available: true, computer: null },
        event('computer.status', { computerId: COMPUTER, status: 'creating' }),
      ),
    ).toBeUndefined();
  });

  it('applies screen.control, or asks for a refetch for an unknown screen', () => {
    const taken = applyScreenControl(
      { available: true, computer: computer('running') },
      event('screen.control', { screenId: SCREEN, controller: 'user', userId: USER }),
    );
    expect(taken?.computer?.screens[0]).toMatchObject({
      controlledByUserId: USER,
      controlledSince: '2026-10-18T11:00:00.000Z',
    });
    const back = applyScreenControl(
      taken,
      event('screen.control', { screenId: SCREEN, controller: 'bot', userId: null }),
    );
    expect(back?.computer?.screens[0]?.controlledByUserId).toBeNull();
    expect(
      applyScreenControl(
        taken,
        event('screen.control', { screenId: BOT, controller: 'bot', userId: null }),
      ),
    ).toBeUndefined();
  });

  it('builds file URLs relative to /home/bot', () => {
    expect(computerFileUrl('/home/bot/a b/c#.txt')).toBe('/api/v1/computer/files/a%20b/c%23.txt');
    expect(computerQuery.queryKey).toEqual(['computer']);
  });
});
