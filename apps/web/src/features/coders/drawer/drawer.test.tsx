// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { CodingSessionEntry, CoderTranscriptEvent, WsEvent } from '@openbots/shared';
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
import { RightPanelProvider, useRightPanel } from '../../../app/right-panel.js';
import { RealtimeContext, type Realtime } from '../../transcript/realtime.js';
import type { CodingSession, PendingApproval } from '../api.js';
import { Route as CodingRoute } from '../../../routes/_app/coding.js';
import { CodingSessionsButton, CodingSessionsLink } from './drawer.js';
import { upsertSession } from './live.js';
import { matchApprovals, transcriptItems } from './transcript.js';
import { mergeEntries, unbrokenSeq } from './use-session-transcript.js';

// The coding sessions drawer (CA15) against a fake server and socket: the
// sidebar toggle and its live count, the list, a session as a conversation
// with its approvals, composer and terminal, and the transcript kept in seq
// order from realtime batches with gaps read from the server.

const upload = vi.hoisted(() => vi.fn());
vi.mock('../../transcript/api.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  uploadFile: upload,
}));

const BOT = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = '00000000-0000-4000-8000-0000000000m1';
const LIVE = '00000000-0000-4000-8000-0000000000s1';
const DONE = '00000000-0000-4000-8000-0000000000s2';
const APPROVAL = '00000000-0000-4000-8000-0000000000a1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; search: string; body: unknown }[],
    handle: (async () => Response.error()) as (
      request: Request,
      path: string,
      search: URLSearchParams,
      body: unknown,
    ) => Promise<Response>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname, search, searchParams } = new URL(request.url, 'http://localhost');
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    state.requests.push({ method: request.method, path: pathname, search, body });
    return state.handle(request, pathname, searchParams, body);
  };
  return state;
});

// xterm: a fake terminal, as the computer tests use.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
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
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  send() {}
  close() {
    this.closed = true;
  }
}
const RealWebSocket = globalThis.WebSocket;

afterAll(() => {
  globalThis.fetch = server.realFetch;
  globalThis.WebSocket = RealWebSocket;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(over: Partial<CodingSession> & Pick<CodingSession, 'id'>): CodingSession {
  return {
    botId: BOT,
    runId: null,
    chatId: BOT,
    messageId: MESSAGE,
    partIndex: 0,
    agent: 'claude',
    title: '',
    repoId: null,
    repoFullName: 'acme/web',
    branch: 'openbots/fix-login',
    base: 'main',
    mode: 'edit',
    status: 'settled',
    pushAllowed: false,
    vendorSessionId: null,
    usage: { input_tokens: 0, output_tokens: 0, billed: 'unknown' },
    summary: null,
    changedFiles: [],
    commits: [],
    prUrl: null,
    diffArtifactId: null,
    error: null,
    worktreePath: '/home/coder/work/acme/web',
    startedAt: '2026-11-06T09:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-11-06T09:00:00.000Z',
    ...over,
  } as CodingSession;
}

let seqAt = 0;
const entry = (event: CoderTranscriptEvent, turn = 1, seq = ++seqAt): CodingSessionEntry => ({
  seq,
  turn,
  at: '2026-11-06T09:00:00.000Z',
  event,
});

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: APPROVAL,
    runId: '00000000-0000-4000-8000-0000000000r1',
    messageId: MESSAGE,
    sessionId: DONE,
    toolName: 'Bash',
    args: {},
    summary: 'git push',
    reason: 'Push the branch',
    status: 'pending',
    note: null,
    decidedBy: null,
    decidedAt: null,
    expiresAt: null,
    createdAt: '2026-11-06T09:00:00.000Z',
    botId: BOT,
    chatId: BOT,
    seq: 4,
    ...over,
  } as PendingApproval;
}

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
  const emit = (type: string, payload: unknown) =>
    act(() => {
      for (const h of handlers.get(type) ?? []) h({ type, ts: 0, payload } as WsEvent);
    });
  return { realtime, emit };
}

let sessions: CodingSession[];
let transcripts: Record<string, CodingSessionEntry[]>;
let approvals: PendingApproval[];
let fake: ReturnType<typeof fakeRealtime>;
let terminal: Response | (() => Response);

beforeEach(() => {
  seqAt = 0;
  upload.mockReset();
  upload.mockResolvedValue({ id: 'attached-file', name: 'screen.png', mime: 'image/png', size: 5 });
  server.requests = [];
  FakeSocket.sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  sessions = [];
  transcripts = {};
  approvals = [];
  terminal = () => Response.json({ cwd: '/home/coder/work/acme/web', user: 'coder' });
  server.handle = async (request, path, search, body) => {
    if (path === '/api/v1/coding-sessions') return Response.json({ sessions });
    if (path === '/api/v1/bots') {
      return Response.json({ items: [{ id: BOT, name: 'Scout', state: { botId: BOT } }] });
    }
    if (path === '/api/v1/approvals') return Response.json({ items: approvals });
    const match = /^\/api\/v1\/coding-sessions\/([^/]+)\/(\w+)$/.exec(path);
    if (match) {
      const [, id, what] = match;
      if (what === 'events') {
        const after = Number(search.get('after') ?? 0);
        const limit = Number(search.get('limit') ?? 200);
        const rest = (transcripts[id!] ?? []).filter((e) => e.seq > after);
        return Response.json({ entries: rest.slice(0, limit), hasMore: rest.length > limit });
      }
      if (what === 'turns') {
        const s = sessions.find((x) => x.id === id)!;
        if (s.status !== 'settled') {
          return Response.json(
            { title: 'Conflict', detail: 'This session is still running', code: 'SESSION_RUNNING' },
            { status: 409 },
          );
        }
        const next = { ...s, status: 'queued' as const };
        sessions = sessions.map((x) => (x.id === id ? next : x));
        return Response.json({ session: next, prompt: (body as { prompt: string }).prompt });
      }
      if (what === 'terminal') return typeof terminal === 'function' ? terminal() : terminal;
      if (what === 'stop') {
        const next = { ...sessions.find((x) => x.id === id)!, status: 'stopped' as const };
        sessions = sessions.map((x) => (x.id === id ? next : x));
        return Response.json({ session: next });
      }
    }
    if (path === `/api/v1/approvals/${APPROVAL}/decide`) {
      approvals = [];
      return Response.json({ approval: { ...pending(), status: 'approved' }, resumedRunId: null });
    }
    void request;
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function Slot() {
  const { content, width } = useRightPanel();
  return content ? <aside data-width={width}>{content}</aside> : null;
}

function render(botId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fake = fakeRealtime();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <RealtimeContext value={fake.realtime}>
          <RightPanelProvider>
            <CodingSessionsButton botId={botId} />
            <Slot />
          </RightPanelProvider>
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (!check()) throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}

const toggle = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Coding sessions'))!;
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
const drawer = () => host.querySelector('aside');

async function openSession(id: string) {
  act(() => toggle().click());
  await until(() => !!host.querySelector(`[data-session-row="${id}"]`), 'the row');
  act(() => host.querySelector<HTMLButtonElement>(`[data-session-row="${id}"]`)!.click());
  await until(() => !!host.querySelector(`[data-session="${id}"]`), 'the session');
}

function type(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the coding sessions drawer (CA15)', () => {
  it('navigates away from bot conversations to a dedicated coding sessions page', async () => {
    sessions = [session({ id: LIVE, status: 'running', title: 'Fix the login form' })];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fake = fakeRealtime();
    const rootRoute = createRootRoute({
      component: () => (
        <RightPanelProvider>
          <CodingSessionsLink />
          <main>
            <Outlet />
          </main>
          <Slot />
        </RightPanelProvider>
      ),
    });
    const botRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/bot',
      component: () => (
        <>
          <p>Bot conversation</p>
          <CodingSessionsButton botId={BOT} />
        </>
      ),
    });
    const codingRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/coding',
      component: CodingRoute.options.component,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([botRoute, codingRoute]),
      history: createMemoryHistory({ initialEntries: ['/bot'] }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <RealtimeContext value={fake.realtime}>
            <RouterProvider router={router} />
          </RealtimeContext>
        </QueryClientProvider>,
      );
    });
    await until(() => host.textContent!.includes('Bot conversation'), 'bot conversation');
    act(() => toggle().click());
    await until(() => !!drawer(), 'bot coding panel');
    act(() => host.querySelector<HTMLAnchorElement>('a[href="/coding"]')!.click());
    await until(() => !!host.querySelector('main [data-session-row]'), 'coding page');
    expect(host.textContent).not.toContain('Bot conversation');
    expect(drawer()).toBeNull();
    expect(host.querySelector('main h2')?.textContent).toBe('Coding sessions');
    expect(host.querySelector('button[aria-label="Close Coding sessions"]')).toBeNull();
    expect(host.querySelector('[data-live-count]')?.textContent).toBe('1');
    act(() => host.querySelector<HTMLButtonElement>(`[data-session-row="${LIVE}"]`)!.click());
    await until(() => !!host.querySelector(`main [data-session="${LIVE}"]`), 'session on page');
    expect(host.textContent).not.toContain('Bot conversation');
  });
  it('filters the bot entry to sessions triggered by that bot', async () => {
    sessions = [session({ id: LIVE, botId: BOT }), session({ id: DONE, botId: 'other-bot' })];
    render(BOT);
    act(() => toggle().click());
    await until(() => !!host.querySelector(`[data-session-row="${LIVE}"]`), 'bot sessions');
    expect(host.querySelector(`[data-session-row="${DONE}"]`)).toBeNull();
    await until(() => !!drawer()?.textContent?.includes('Scout · Coding sessions'), 'bot name');
  });
  it('toggles from the sidebar, wide, and counts the live sessions', async () => {
    sessions = [
      session({ id: LIVE, status: 'running', title: 'Fix the login form' }),
      session({ id: DONE, status: 'settled', title: 'Bump the deps' }),
    ];
    render();
    await until(() => !!host.querySelector('[data-live-count]'), 'the live count');
    expect(host.querySelector('[data-live-count]')?.textContent).toBe('1');

    act(() => toggle().click());
    expect(drawer()?.getAttribute('data-width')).toBe('wide');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    act(() => toggle().click());
    expect(drawer()).toBeNull();

    sessions = sessions.map((s) => ({ ...s, status: 'settled' as const }));
    fake.emit('coding_session.updated', { session: sessions[0] });
    await until(() => !host.querySelector('[data-live-count]'), 'no live count');
  });

  it('lists the sessions with their marks and titles, running first', async () => {
    sessions = [
      session({ id: DONE, status: 'settled', title: 'Bump the deps', agent: 'codex' }),
      session({ id: LIVE, status: 'waiting', agent: 'pi', repoFullName: 'acme/api' }),
    ];
    render();
    act(() => toggle().click());
    await until(() => !!host.querySelector('[data-group="Earlier"]'), 'the groups');
    const groups = [...host.querySelectorAll('[data-group]')].map((g) =>
      g.getAttribute('data-group'),
    );
    expect(groups).toEqual(['Running', 'Earlier']);
    const running = host.querySelector('[data-group="Running"]')!;
    // An empty title reads as the repository's name.
    expect(running.textContent).toContain('api');
    expect(running.textContent).toContain('acme/api · openbots/fix-login');
    expect(running.textContent).toContain('Waiting for you');
    expect(running.querySelector('[data-agent-mark="pi"]')?.textContent).toBe('π');
    const earlier = host.querySelector('[data-group="Earlier"]')!;
    expect(earlier.textContent).toContain('Bump the deps');
    expect(earlier.querySelector('[data-agent-mark="codex"]')?.getAttribute('aria-label')).toBe(
      'Codex',
    );
    await until(() => earlier.textContent!.includes('Scout'), "the Bot's name");

    const created = session({ id: 'new', status: 'queued', title: 'Write the docs' });
    sessions = [created, ...sessions];
    fake.emit('coding_session.updated', { session: created });
    await until(
      () => !!host.querySelector('[data-group="Running"]')?.textContent?.includes('Write the docs'),
      'the new session',
    );
  });

  it('says so when there are no sessions', async () => {
    render();
    act(() => toggle().click());
    await until(() => drawer()!.textContent!.includes('No coding sessions yet.'), 'empty state');
    expect(drawer()!.textContent).toContain(
      'No coding sessions yet. Ask a Bot to work on a repository, or start one from its chat.',
    );
  });

  it('shows a session as a conversation with its actions, approval and result', async () => {
    sessions = [
      session({
        id: DONE,
        status: 'settled',
        title: 'Fix the login form',
        changedFiles: [{ path: 'src/login.tsx', kind: 'edit', added: 4, removed: 1 }],
        prUrl: 'https://github.com/acme/web/pull/7',
      }),
    ];
    transcripts[DONE] = [
      entry({ type: 'prompt', text: 'Fix the login form', by: 'bot' }),
      entry({ type: 'text', text: 'Looking at **login.tsx** now.' }),
      entry({ type: 'tool_use', name: 'Read', summary: 'src/login.tsx' }),
      entry({ type: 'command', command: 'pnpm test', exit_code: 0 }),
      entry({ type: 'file_change', path: 'src/login.tsx', kind: 'edit', added: 4, removed: 1 }),
      entry({ type: 'tool_use', name: 'Grep', summary: 'onSubmit' }),
      entry({
        type: 'approval_request',
        request_id: APPROVAL,
        action_class: 'push',
        title: 'Push the branch',
        detail: 'git push origin openbots/fix-login',
        tool_name: 'Bash',
      }),
      entry({ type: 'usage', input_tokens: 1200, output_tokens: 300, billed: 'api' }),
      entry({ type: 'result', ok: true, summary: 'Fixed the **submit** handler.' }),
      entry({ type: 'prompt', text: 'Now add a test', by: 'owner' }, 2),
      entry({ type: 'error', message: 'The agent exited' }, 2),
    ];
    render();
    await openSession(DONE);
    await until(() => !!host.querySelector('[data-entry="result"]'), 'the transcript');
    expect(button('Approve')).toBeUndefined();
    // The request reaches the owner after the drawer opened.
    approvals = [pending(), pending({ id: 'other', sessionId: LIVE })];
    fake.emit('approval.requested', { approval: pending() });

    const prompts = [...host.querySelectorAll('[data-entry="prompt"]')];
    expect(prompts.map((p) => p.textContent)).toEqual([
      'ScoutFix the login form',
      'YouNow add a test',
    ]);
    expect(host.querySelector('[data-entry="text"] strong')?.textContent).toBe('login.tsx');

    const actions = host.querySelector('[data-entry="actions"]')!;
    expect(actions.textContent).toBe('4 actions');
    act(() => button('4 actions', actions)!.click());
    expect(
      [...actions.querySelectorAll('[data-action] summary')].map((a) => a.textContent),
    ).toEqual([
      'Readsrc/login.tsx',
      'Run (exit 0)pnpm test',
      'Editsrc/login.tsx +4 −1',
      'GreponSubmit',
    ]);
    const action = actions.querySelector<HTMLDetailsElement>('details')!;
    expect(action.open).toBe(false);
    act(() => action.querySelector('summary')!.click());
    expect(action.open).toBe(true);
    expect(action.querySelector('pre')?.textContent).toBe('src/login.tsx');
    act(() => action.querySelector('summary')!.click());
    expect(action.open).toBe(false);
    act(() => button('Hide actions', actions)!.click());
    expect(actions.querySelector('[data-action]')).toBeNull();

    await until(() => !!host.querySelector(`[data-approval="${APPROVAL}"]`), 'the approval');
    const card = host.querySelector('[data-entry="approval"]')!;
    expect(card.textContent).toContain('Push the branch');
    expect(card.textContent).toContain('Push');
    expect(card.querySelector('code')?.textContent).toBe('git push origin openbots/fix-login');
    act(() => button('Approve', card)!.click());
    await until(
      () => server.requests.some((r) => r.path === `/api/v1/approvals/${APPROVAL}/decide`),
      'the decision',
    );
    expect(
      server.requests.find((r) => r.path === `/api/v1/approvals/${APPROVAL}/decide`)?.body,
    ).toEqual({ decision: 'approve' });
    await until(() => !button('Approve', card), 'the buttons gone');

    const result = host.querySelector('[data-entry="result"]')!;
    expect(result.querySelector('strong')?.textContent).toBe('submit');
    expect(result.textContent).toContain('1 file changed');
    expect(result.querySelector('[data-usage]')?.textContent).toBe('1,200 in / 300 out tokens');
    expect(result.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/acme/web/pull/7',
    );
    expect(host.querySelector('[data-entry="error"]')?.className).toContain('text-destructive');
    expect(
      [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open in chat'),
    ).toBeUndefined();

    act(() => button('Back')!.click());
    expect(host.querySelector(`[data-session-row="${DONE}"]`)).not.toBeNull();
  });

  it('keeps the composer shut while live and sends the next prompt once ended', async () => {
    sessions = [session({ id: LIVE, status: 'running', title: 'Fix the login form' })];
    render();
    await openSession(LIVE);
    const textarea = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(host.querySelector('[data-edit-mode]')).toBeNull();
    expect(host.querySelector('button[aria-label="Add to coding message"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Ask before edits');
    expect(textarea().disabled).toBe(true);
    expect(host.textContent).toContain('Working. Send your next message when this turn ends.');
    expect(button('Stop')).toBeDefined();

    sessions = sessions.map((s) => ({ ...s, status: 'settled' as const }));
    fake.emit('coding_session.updated', { session: sessions[0] });
    await until(() => !textarea().disabled, 'the composer open');
    expect(button('Stop')).toBeUndefined();
    type(textarea(), 'Now add a test');
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(
      () => server.requests.some((r) => r.path === `/api/v1/coding-sessions/${LIVE}/turns`),
      'the turn',
    );
    expect(
      server.requests.find((r) => r.path === `/api/v1/coding-sessions/${LIVE}/turns`)?.body,
    ).toEqual({ prompt: 'Now add a test' });
    await until(() => textarea().disabled, 'the composer shut again');
    expect(host.textContent).toContain('Queued');
  });

  it('shows attachments and edit approvals only inside the plus menu', async () => {
    sessions = [session({ id: DONE, status: 'settled' })];
    render();
    await openSession(DONE);
    expect(document.body.textContent).not.toContain('Ask before edits');
    act(() =>
      host
        .querySelector('button[aria-label="Add to coding message"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    await until(() => !!document.querySelector('[role="menu"]'), 'plus menu');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      'Attach screenshot or image',
    );
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Attach files');
    await until(
      () =>
        document.querySelector('[role="menu"]')?.textContent?.includes('Ask before edits') === true,
      'edit choices',
    );
  });

  it('uploads attachments before sending their IDs with the next turn', async () => {
    sessions = [session({ id: DONE, status: 'settled' })];
    render();
    await openSession(DONE);
    let finish!: (value: unknown) => void;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach files"]')!;
    const file = new File(['image'], 'screen.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(upload).toHaveBeenCalledWith(file);
    expect(button('Send')?.disabled).toBe(true);
    expect(host.textContent).toContain('Uploading');
    await act(async () =>
      finish({ id: 'attached-file', name: 'screen.png', mime: 'image/png', size: 5 }),
    );
    act(() => button('Send')!.click());
    await until(() => server.requests.some((r) => r.path.endsWith('/turns')), 'attached turn');
    expect(server.requests.find((r) => r.path.endsWith('/turns'))?.body).toEqual({
      prompt: 'Please review the attached files.',
      attachments: ['attached-file'],
    });
  });

  it('retains failed uploads and lets the owner remove them', async () => {
    sessions = [session({ id: DONE, status: 'settled' })];
    render();
    await openSession(DONE);
    upload.mockRejectedValue(new Error('Upload unavailable'));
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['file'], 'notes.txt')] });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    await until(() => host.textContent!.includes('Upload unavailable'), 'upload failure');
    expect(button('Send')?.disabled).toBe(true);
    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]')!.click(),
    );
    expect(host.textContent).not.toContain('notes.txt');
  });

  it("shows the server's reason when a turn is refused", async () => {
    sessions = [session({ id: DONE, status: 'settled' })];
    render();
    await openSession(DONE);
    // The server still sees it running.
    sessions = sessions.map((s) => ({ ...s, status: 'running' as const }));
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    type(textarea, 'Try again');
    act(() => button('Send')!.click());
    await until(() => host.textContent!.includes('This session is still running'), 'the refusal');
  });

  it('stops a live session', async () => {
    sessions = [session({ id: LIVE, status: 'running' })];
    render();
    await openSession(LIVE);
    act(() => button('Stop')!.click());
    await until(() => host.textContent!.includes('Stopped'), 'stopped');
    expect(server.requests.some((r) => r.path === `/api/v1/coding-sessions/${LIVE}/stop`)).toBe(
      true,
    );
  });

  it('mounts the terminal on the worktree and closes it when toggled off', async () => {
    sessions = [session({ id: DONE })];
    render();
    await openSession(DONE);
    act(() => button('Terminal')!.click());
    await until(() => FakeSocket.sockets.length === 1, 'the terminal socket');
    expect(server.requests.some((r) => r.path === `/api/v1/coding-sessions/${DONE}/terminal`)).toBe(
      true,
    );
    const url = new URL(FakeSocket.sockets[0]!.url);
    expect(url.pathname).toBe('/api/v1/computer/pty');
    expect(url.searchParams.get('cwd')).toBe('/home/coder/work/acme/web');
    expect(url.searchParams.get('user')).toBe('coder');
    act(() => button('Terminal')!.click());
    expect(FakeSocket.sockets[0]!.closed).toBe(true);
    expect(host.querySelector('[data-terminal]')).toBeNull();
  });

  it('says why when the session has no worktree', async () => {
    sessions = [session({ id: DONE })];
    terminal = () =>
      Response.json(
        {
          title: 'Conflict',
          detail: 'This session has no worktree any more.',
          code: 'NO_WORKTREE',
        },
        { status: 409 },
      );
    render();
    await openSession(DONE);
    act(() => button('Terminal')!.click());
    await until(
      () => host.textContent!.includes('This session has no worktree any more.'),
      'the reason',
    );
    expect(FakeSocket.sockets).toHaveLength(0);
  });

  it('appends realtime entries in seq order and reads a gap from the server', async () => {
    sessions = [session({ id: LIVE, status: 'running' })];
    transcripts[LIVE] = [entry({ type: 'prompt', text: 'Fix it', by: 'bot' })];
    render();
    await openSession(LIVE);
    await until(() => !!host.querySelector('[data-entry="prompt"]'), 'the first entry');

    fake.emit('coding_session.events', {
      sessionId: LIVE,
      entries: [entry({ type: 'text', text: 'On it.' }, 1, 2)],
    });
    expect(host.querySelectorAll('[data-entry="text"]')).toHaveLength(1);
    // Another session's batch is not this one's.
    fake.emit('coding_session.events', {
      sessionId: DONE,
      entries: [entry({ type: 'text', text: 'Elsewhere' }, 1, 3)],
    });
    expect(host.textContent).not.toContain('Elsewhere');

    transcripts[LIVE].push(
      entry({ type: 'text', text: 'On it.' }, 1, 2),
      entry({ type: 'text', text: 'Missed this one.' }, 1, 3),
    );
    server.requests = [];
    fake.emit('coding_session.events', {
      sessionId: LIVE,
      entries: [entry({ type: 'text', text: 'Then this.' }, 1, 4)],
    });
    await until(() => host.textContent!.includes('Missed this one.'), 'the gap filled');
    const read = server.requests.find((r) => r.path.endsWith('/events'));
    expect(new URLSearchParams(read!.search).get('after')).toBe('2');
    expect([...host.querySelectorAll('[data-entry="text"]')].map((e) => e.textContent)).toEqual([
      'On it.',
      'Missed this one.',
      'Then this.',
    ]);
  });
});

describe('the drawer helpers (CA15)', () => {
  it('merges entries by seq and finds the unbroken prefix', () => {
    const a = entry({ type: 'text', text: 'a' }, 1, 1);
    const b = entry({ type: 'text', text: 'b' }, 1, 2);
    const d = entry({ type: 'text', text: 'd' }, 1, 4);
    const merged = mergeEntries([a], [d, b, a]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(unbrokenSeq(merged)).toBe(2);
    expect(mergeEntries(merged, [a])).toBe(merged);
  });

  it('puts a turn usage on its result and groups actions', () => {
    const items = transcriptItems([
      entry({ type: 'tool_use', name: 'Read', summary: 'a' }, 1, 1),
      entry({ type: 'tool_use', name: 'Read', summary: 'b' }, 1, 2),
      entry({ type: 'usage', input_tokens: 1, output_tokens: 2, billed: 'subscription' }, 1, 3),
      entry({ type: 'result', ok: true, summary: 'Done' }, 1, 4),
      entry({ type: 'result', ok: true, summary: 'Done again' }, 2, 5),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['actions', 'result', 'result']);
    expect(items[1]).toMatchObject({ usage: { billed: 'subscription' } });
    expect(items[2]).not.toHaveProperty('usage');
  });

  it("matches a request to the session's pending approval by its id", () => {
    const ask = (seq: number, id: string) =>
      entry(
        { type: 'approval_request', request_id: id, action_class: 'push', title: 'Push' },
        1,
        seq,
      );
    const items = transcriptItems([ask(1, 'x'), ask(2, 'y'), ask(3, 'z')]);
    const found = matchApprovals(
      items,
      [pending({ id: 'x' }), pending({ id: 'y', sessionId: LIVE }), pending({ id: 'z' })],
      DONE,
    );
    expect([...found].map(([seq, a]) => [seq, a.id])).toEqual([
      [1, 'x'],
      [3, 'z'],
    ]);
    expect(matchApprovals(items, undefined, DONE).size).toBe(0);
  });

  it('replaces a known session and puts a new one first', () => {
    const one = session({ id: LIVE, status: 'running' });
    const two = session({ id: DONE });
    expect(upsertSession([one, two], { ...two, status: 'failed' }).map((s) => s.status)).toEqual([
      'running',
      'failed',
    ]);
    expect(upsertSession([two], one).map((s) => s.id)).toEqual([LIVE, DONE]);
  });
});
