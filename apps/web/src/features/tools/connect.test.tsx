// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeContext, type Realtime } from '../transcript/realtime.js';
import type { CatalogEntry, Connector } from './api.js';
import { CatalogCard } from './catalog.js';
import { ConnectorCard } from './connector-card.js';
import { CustomServerForm } from './custom-server.js';
import { OAUTH_MESSAGE_TYPE } from './oauth.js';
import { ToolsPage } from './tools-page.js';

// One-click Connect (plan 8): the click opens the sign-in window, the
// server's start answer points it at the provider, and the callback page or
// the owner's socket finishes the flow.

const ID = '00000000-0000-4000-8000-0000000000c1';
const AUTH_URL = 'https://auth.example.com/authorize?state=s';
const CALLBACK = 'http://localhost:3000/api/v1/connectors/oauth/callback';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; search: string; body: unknown }[],
    connectors: [] as Record<string, unknown>[],
    catalog: [] as unknown[],
    created: null as Record<string, unknown> | null,
    discovery: null as Record<string, unknown> | null,
    /** The start answer: a URL, or a problem code. */
    start: null as string | null,
    device: null as {
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
      interval: number;
    } | null,
    devicePoll: { status: 'pending', interval: 1 } as Record<string, unknown>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    state.requests.push({ method: request.method, path: url.pathname, search: url.search, body });
    const path = url.pathname;
    if (path.endsWith('/oauth/start')) {
      if (state.start) {
        return Response.json({ title: 'Needs a client', code: state.start }, { status: 400 });
      }
      return Response.json({
        authorizationUrl: state.device?.verificationUrl ?? AUTH_URL,
        ...(state.device ? { device: state.device } : {}),
      });
    }
    if (path.endsWith('/oauth/device')) return Response.json(state.devicePoll);
    if (path === '/api/v1/connectors/discover') return Response.json(state.discovery);
    if (path === '/api/v1/connectors/catalog') {
      return Response.json({ items: state.catalog, oauthCallbackUrl: CALLBACK });
    }
    if (path === '/api/v1/connectors' && request.method === 'POST') {
      return Response.json(state.created, { status: 201 });
    }
    if (path === '/api/v1/connectors') return Response.json({ items: state.connectors });
    if (path.endsWith('/test')) return Response.json({ connector: state.created, tools: [] });
    return Response.json({});
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'vercel',
  name: 'Vercel',
  description: 'Deployments',
  kind: 'mcp_http',
  icon: 'vercel',
  homepage: null,
  version: null,
  runtime: null,
  command: null,
  args: null,
  url: 'https://mcp.vercel.com',
  auth: ['oauth'],
  builtin: null,
  params: [],
  secrets: [],
  oauth: { scopes: [], dynamicRegistration: true, clientSetupUrl: null },
  disabledByAdmin: false,
  ...over,
});

const connector = (over: Partial<Connector> = {}): Connector => ({
  id: ID,
  name: 'Vercel',
  slug: 'vercel',
  kind: 'mcp_http',
  catalogId: 'vercel',
  transport: 'http',
  command: null,
  args: null,
  env: null,
  url: 'https://mcp.vercel.com',
  auth: 'oauth',
  headers: null,
  builtin: null,
  params: {},
  secrets: [],
  oauth: { clientConfigured: false, connected: false, expiresAt: null },
  status: 'untested',
  lastError: null,
  lastCheckedAt: null,
  disabledByAdmin: false,
  trusted: false,
  local: false,
  toolCount: 0,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  ...over,
});

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

interface FakePopup {
  closed: boolean;
  location: { replace: ReturnType<typeof vi.fn> };
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let root: Root;
let host: HTMLElement;
let live: ReturnType<typeof fakeRealtime>;
let popup: FakePopup;
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  server.requests.length = 0;
  server.connectors = [];
  server.catalog = [];
  server.created = connector();
  server.discovery = null;
  server.start = null;
  server.device = null;
  server.devicePoll = { status: 'pending', interval: 1 };
  popup = {
    closed: false,
    location: { replace: vi.fn() },
    focus: vi.fn(),
    close: vi.fn(() => {
      popup.closed = true;
    }),
  };
  open = vi.fn(() => popup);
  vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  live = fakeRealtime();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (window as { openbots?: unknown }).openbots;
});

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RealtimeContext value={live.realtime}>{ui}</RealtimeContext>
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

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const started = () => server.requests.find((r) => r.path.endsWith('/oauth/start'));
const tested = () => server.requests.some((r) => r.path === `/api/v1/connectors/${ID}/test`);

function setValue(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('one-click Connect', () => {
  it('shows a GitHub code, polls for approval and tests the connected connector', async () => {
    const github = entry({
      id: 'github',
      name: 'GitHub',
      oauth: {
        scopes: ['repo'],
        dynamicRegistration: false,
        deviceFlow: true,
        clientSetupUrl: null,
      },
    });
    server.device = {
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      interval: 1,
    };
    render(<CatalogCard entry={github} added={false} />);
    act(() => button('Connect')!.click());
    await until(() => !!host.textContent?.includes('ABCD-EFGH'), 'the device code');
    expect(host.querySelector('form')).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledWith('https://github.com/login/device');
    expect(button('Connect')!.disabled).toBe(true);
    await until(
      () => server.requests.some((r) => r.path.endsWith('/oauth/device')),
      'the device poll',
    );
    expect(host.textContent).toContain('Waiting for GitHub approval');
    server.devicePoll = { status: 'connected' };
    await until(tested, 'the connected tools');
    expect(host.textContent).not.toContain('ABCD-EFGH');
  });

  it('stops device polling when cancelled', async () => {
    server.device = {
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://github.com/login/device',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      interval: 60,
    };
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Connect')!.click());
    await until(() => !!host.textContent?.includes('ABCD-EFGH'), 'the device code');
    act(() => button('Cancel')!.click());
    expect(host.textContent).not.toContain('ABCD-EFGH');
    expect(server.requests.some((r) => r.path.endsWith('/oauth/device'))).toBe(false);
  });

  it('adds the connector, starts OAuth and opens a popup in the click', async () => {
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Connect')!.click());
    // The window opens in the click, before any answer, so it is not blocked.
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0]! as [string, string, string];
    expect(url).toBe('');
    expect(name).toBe('openbots-oauth');
    expect(features).toMatch(/popup=yes,width=520,height=720/);

    await until(() => popup.location.replace.mock.calls.length > 0, 'the provider page');
    expect(popup.location.replace).toHaveBeenCalledWith(AUTH_URL);
    expect(server.requests.find((r) => r.method === 'POST')).toMatchObject({
      path: '/api/v1/connectors',
      body: { catalogId: 'vercel' },
    });
    expect(started()).toMatchObject({ path: `/api/v1/connectors/${ID}/oauth/start` });
    expect(started()!.search).toBe('?mode=popup');
    // No intermediate form, and no client fields.
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('OAuth client ID');
    expect(host.textContent).toContain('Finish signing in in the new window.');

    // The callback page posts from the popup; another window or origin is ignored.
    const message = (data: unknown, origin: string, source: unknown) =>
      act(() => {
        const event = new MessageEvent('message', { data, origin });
        Object.defineProperty(event, 'source', { value: source });
        window.dispatchEvent(event);
      });
    const data = { type: OAUTH_MESSAGE_TYPE, status: 'connected', connectorId: ID };
    message(data, 'https://evil.example.com', popup);
    message(data, window.location.origin, {});
    expect(host.textContent).toContain('Finish signing in');
    message(data, window.location.origin, popup);
    await until(tested, 'the test after connecting');
    expect(host.textContent).not.toContain('Finish signing in');
  });

  it('just adds a connector that needs no sign-in, closing the window', async () => {
    server.created = connector({ auth: 'none', oauth: null, catalogId: null });
    server.discovery = {
      auth: 'none',
      dynamicRegistration: false,
      reachable: true,
      message: null,
      oauthCallbackUrl: CALLBACK,
    };
    render(<CustomServerForm stdio="admin_only" />);
    setValue(host.querySelector('input[type="url"]')!, 'https://open.example.com/mcp');
    act(() => button('Connect')!.closest('form')!.requestSubmit());
    await until(tested, 'the test after adding');
    expect(started()).toBeUndefined();
    expect(
      server.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/connectors'),
    ).toMatchObject({ body: { url: 'https://open.example.com/mcp', auth: 'none' } });
    if (open.mock.calls.length) expect(popup.close).toHaveBeenCalled();
  });

  it('falls back to a tab, then to a link, when popups are blocked', async () => {
    open.mockReturnValue(null);
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Connect')!.click());
    await until(() => host.textContent!.includes('blocked'), 'the blocked notice');
    expect(open).toHaveBeenLastCalledWith(AUTH_URL, '_blank');
    const link = host.querySelector<HTMLAnchorElement>('a[href^="https://auth.example.com"]')!;
    expect(link.href).toBe(AUTH_URL);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
  });

  it('opens the default browser in the Mac app and comes back to the front', async () => {
    const bridge = { open: vi.fn(async () => undefined), finished: vi.fn(async () => undefined) };
    (window as { openbots?: unknown }).openbots = {
      platform: { kind: 'desktop', os: 'darwin', version: '1', nativeNotifications: true },
      onNavigate: () => () => {},
      oauth: bridge,
    };
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Connect')!.click());
    await until(() => bridge.open.mock.calls.length > 0, 'the browser');
    expect(open).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledWith(AUTH_URL);
    expect(started()!.search).toBe('?mode=external');
    expect(host.textContent).toContain('Finish signing in in your browser.');

    live.emit('connector.updated', { connectorId: ID, oauth: 'connected' });
    await until(() => bridge.finished.mock.calls.length > 0, 'the window back');
    await until(tested, 'the test after connecting');
  });

  it('says why when the sign-in failed, from the socket', async () => {
    render(<CatalogCard entry={entry()} added={false} />);
    act(() => button('Connect')!.click());
    await until(() => Boolean(started()), 'the start');
    await until(() => host.textContent!.includes('Finish signing in'), 'waiting');
    live.emit('connector.updated', { connectorId: ID, oauth: 'error', error: 'access_denied' });
    await until(() => host.textContent!.includes('access_denied'), 'the reason');
    expect(tested()).toBe(false);
  });
});

describe('the Advanced OAuth client', () => {
  it('is folded away, and only for providers that cannot register OpenBots', async () => {
    server.catalog = [];
    render(
      <CatalogCard
        entry={entry({
          id: 'gmail',
          name: 'Gmail',
          oauth: {
            scopes: [],
            dynamicRegistration: false,
            clientSetupUrl: 'https://console.cloud.google.com/apis/credentials',
          },
        })}
        added={false}
      />,
    );
    act(() => button('Connect')!.click());
    // No window yet: there is a client to enter first.
    expect(open).not.toHaveBeenCalled();
    const advanced = host.querySelector('details')!;
    expect(advanced.querySelector('summary')!.textContent).toBe('Advanced');
    expect(advanced.open).toBe(false);
    expect(host.textContent).toContain('Gmail needs your own OAuth app. Add it under Advanced.');
    await until(
      () =>
        host.querySelector<HTMLInputElement>('input[aria-label="Callback URL"]')?.value ===
        CALLBACK,
      'the callback URL',
    );

    // Connect without a client says where to put it, and opens Advanced.
    act(() => button('Connect')!.closest('form')!.requestSubmit());
    expect(host.textContent).toContain('Add your OAuth client under Advanced.');
    expect(host.querySelector('details')!.open).toBe(true);
    expect(server.requests.some((r) => r.method === 'POST')).toBe(false);

    setValue(host.querySelector('input[name="oauth:clientId"]')!, 'my-app');
    act(() => button('Connect')!.closest('form')!.requestSubmit());
    await until(() => Boolean(started()), 'the start');
    expect(server.requests.find((r) => r.method === 'POST')!.body).toEqual({
      catalogId: 'gmail',
      oauthClient: { clientId: 'my-app' },
    });
    await until(() => popup.location.replace.mock.calls.length > 0, 'the provider page');
  });

  it('shows for a pasted URL only when its server needs a client', async () => {
    server.discovery = {
      auth: 'oauth',
      dynamicRegistration: true,
      reachable: true,
      message: null,
      oauthCallbackUrl: CALLBACK,
    };
    render(<CustomServerForm stdio="admin_only" />);
    const input = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    setValue(input, 'https://dcr.example.com/mcp');
    await until(
      () => server.requests.some((r) => r.path === '/api/v1/connectors/discover'),
      'the check',
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(host.textContent).not.toContain('Advanced');

    server.discovery = { ...server.discovery, dynamicRegistration: false };
    setValue(input, 'https://nodcr.example.com/mcp');
    await until(() => host.textContent!.includes('Advanced'), 'the Advanced fields');
    expect(host.textContent).toContain('This server cannot register OpenBots by itself.');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Callback URL"]')!.value).toBe(
      CALLBACK,
    );
    expect(host.querySelector('input[name="oauth:clientId"]')).not.toBeNull();
  });

  it('opens in the card when the server says a client is needed', async () => {
    server.start = 'OAUTH_CLIENT_REQUIRED';
    const custom = connector({ catalogId: null, name: 'Mine' });
    render(<ConnectorCard connector={custom} entry={undefined} />);
    act(() => button('Connect')!.click());
    await until(() => Boolean(host.querySelector('details[open]')), 'Advanced');
    expect(host.textContent).toContain('This server cannot register OpenBots by itself.');
    expect(popup.close).toHaveBeenCalled();
  });
});

describe('the connectors list', () => {
  it('shows Connected as soon as the sign-in finishes, without a reload', async () => {
    server.connectors = [connector()];
    render(<ToolsPage search={{}} />);
    await until(() => host.textContent!.includes('Not connected'), 'the card');
    server.connectors = [
      connector({ oauth: { clientConfigured: true, connected: true, expiresAt: null } }),
    ];
    live.emit('connector.updated', { connectorId: ID, oauth: 'connected' });
    await until(
      () =>
        host.querySelector(`[data-connector="${ID}"] [data-status]`)?.textContent === 'Connected',
      'Connected',
    );
  });

  it('offers one Reconnect once the tokens expired or were revoked, running the same flow', async () => {
    const expired = connector({
      oauth: { clientConfigured: true, connected: true, expiresAt: null },
      status: 'needs_auth',
      lastError: 'The sign-in expired; sign in again.',
    });
    render(<ConnectorCard connector={expired} entry={entry()} />);
    expect(host.querySelector('[data-status]')!.textContent).toBe('Sign-in expired');
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons.filter((b) => b === 'Reconnect' || b === 'Connect')).toEqual(['Reconnect']);
    act(() => button('Reconnect')!.click());
    expect(open).toHaveBeenCalledTimes(1);
    await until(() => popup.location.replace.mock.calls.length > 0, 'the provider page');
    // The connector exists: nothing is created.
    expect(server.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(started()!.path).toBe(`/api/v1/connectors/${ID}/oauth/start`);

    // A working connector has no sign-in button.
    render(
      <ConnectorCard
        connector={connector({
          oauth: { clientConfigured: true, connected: true, expiresAt: null },
          status: 'ok',
        })}
        entry={entry()}
      />,
    );
    expect(button('Reconnect')).toBeUndefined();
    expect(button('Connect')).toBeUndefined();
  });
});
