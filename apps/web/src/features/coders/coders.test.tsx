// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import type { CoderAccount, CoderLogin } from './api.js';
import { codingSessionHost, computerTerminalHref } from './session-host.js';
import { accountWords, CodingAgentsSettings, keyProviders } from './settings.js';

// Settings > Coding agents against a fake server (CA2, CA3): a card per
// agent, Sign in polling the login until it ends, Use API key and Sign out;
// and what a coding session widget asks of the app.

const LOGIN = '00000000-0000-4000-8000-0000000000e1';
const ANTHROPIC = '00000000-0000-4000-8000-0000000000p1';
const OPENAI = '00000000-0000-4000-8000-0000000000p2';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    handle: (async () => Response.error()) as (
      request: Request,
      path: string,
      body: unknown,
    ) => Promise<Response>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname } = new URL(request.url, 'http://localhost');
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    state.requests.push({ method: request.method, path: pathname, body });
    return state.handle(request, pathname, body);
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = (over: Partial<CoderAccount> & Pick<CoderAccount, 'agent'>): CoderAccount => ({
  label: { claude: 'Claude Code', codex: 'Codex', pi: 'pi' }[over.agent],
  available: true,
  authKind: 'none',
  accountLabel: null,
  signedInAt: null,
  version: '1.0.0',
  lastError: null,
  providerId: null,
  needsSignIn: (over.authKind ?? 'none') === 'none',
  lastErrorKind: over.lastError ? 'other' : null,
  planProvider: null,
  checkAvailable: over.agent === 'pi',
  signIn: ({ claude: 'link', codex: 'device', pi: 'terminal' } as const)[over.agent],
  ...over,
});

const provider = (
  id: string,
  name: string,
  kind: 'anthropic' | 'openai' | 'google' | 'xai' | 'custom',
  protocol: 'native' | 'openai_compatible' | 'anthropic_compatible' = 'native',
) => ({
  id,
  name,
  slug: kind,
  kind,
  protocol,
  baseUrl: null,
  local: false,
  headers: [],
  hasKey: true,
  keyHint: null,
  discovery: 'list_models',
  presetId: kind,
});

let agents: CoderAccount[];
let login: CoderLogin;
let polls: number;

beforeEach(() => {
  server.requests = [];
  polls = 0;
  agents = [
    account({ agent: 'claude' }),
    account({ agent: 'codex', authKind: 'api_key', providerId: OPENAI }),
    account({ agent: 'pi', lastError: 'pi could not start: missing binary' }),
  ];
  login = {
    id: LOGIN,
    agent: 'claude',
    status: 'pending',
    url: null,
    deviceCode: null,
    accountLabel: null,
    error: null,
    expiresAt: null,
  };
  server.handle = async (request, path, body) => {
    if (path === '/api/v1/coders') return Response.json({ agents });
    if (path === '/api/v1/providers') {
      return Response.json({
        items: [
          provider(ANTHROPIC, 'Anthropic', 'anthropic'),
          provider(OPENAI, 'OpenAI', 'openai'),
        ],
      });
    }
    if (path === '/api/v1/coders/claude/login' && request.method === 'POST') {
      return Response.json({ login }, { status: 201 });
    }
    if (path === `/api/v1/coders/claude/login/${LOGIN}` && request.method === 'GET') {
      polls++;
      // The login prints its link on the second poll.
      if (polls >= 2) login = { ...login, url: 'https://claude.ai/oauth/authorize?state=k3Wq' };
      return Response.json({ login });
    }
    if (path === `/api/v1/coders/claude/login/${LOGIN}/code`) {
      login = { ...login, status: 'awaiting_code' };
      return Response.json({ login });
    }
    if (path === `/api/v1/coders/claude/login/${LOGIN}` && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/coders/claude/api-key') {
      const providerId = (body as { providerId: string }).providerId;
      agents = agents.map((a) =>
        a.agent === 'claude' ? { ...a, authKind: 'api_key', providerId } : a,
      );
      return Response.json({ account: agents[0] });
    }
    if (path === '/api/v1/coders/codex/sign-out') {
      agents = agents.map((a) =>
        a.agent === 'codex' ? { ...a, authKind: 'none', providerId: null } : a,
      );
      return Response.json({ account: agents[1] });
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    computer: true,
    deployment: 'self_hosted',
  } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (!check()) throw new Error(`timed out waiting for ${what}: ${host.textContent}`);
}

const card = (agent: string) => host.querySelector<HTMLElement>(`[data-agent="${agent}"]`)!;
const buttonIn = (el: Element | null, label: string) =>
  [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto = Object.getPrototypeOf(el) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

describe('Settings > Coding agents (CA2)', () => {
  it('shows a card per agent with its version, status and error', async () => {
    render(<CodingAgentsSettings />);
    await until(() => !!card('pi'), 'the cards');
    await until(() => card('codex').textContent!.includes('Using API key: OpenAI'), 'providers');
    expect(card('claude').textContent).toContain('Claude Code');
    expect(card('claude').textContent).toContain('Version 1.0.0');
    expect(card('claude').querySelector('[data-account-status]')?.textContent).toBe(
      'Not signed in',
    );
    expect(card('pi').textContent).toContain('pi could not start: missing binary');
    expect(card('pi').textContent).toContain(
      'pi signs in from its own terminal: run pi, type /login and pick a provider. A ChatGPT plan, a Claude plan, GitHub Copilot and the other providers pi lists all work; Anthropic bills a Claude plan used through pi as extra usage, not against the plan. You can also use an API key from Settings > Models.',
    );
    expect(card('pi').textContent).not.toContain("Anthropic's terms reserve");
    expect(buttonIn(card('claude'), 'Sign in')).toBeDefined();
    expect(buttonIn(card('claude'), 'Sign out')).toBeUndefined();
    expect(buttonIn(card('codex'), 'Sign out')).toBeDefined();
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('signs in: starts the login, polls it for the link, sends the code, and cancels', async () => {
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('claude'), 'Sign in'), 'Sign in');
    await act(async () => buttonIn(card('claude'), 'Sign in')!.click());
    await until(() => !!card('claude').querySelector(`[data-login="${LOGIN}"]`), 'the login');
    expect(card('claude').textContent).toContain(
      'Waiting for Claude Code to show its sign-in link',
    );

    // Polling picks up the link the login printed.
    await until(() => !!card('claude').querySelector('[data-sign-in-url]'), 'the link');
    expect(card('claude').querySelector('[data-sign-in-url]')?.textContent).toBe(
      'https://claude.ai/oauth/authorize?state=k3Wq',
    );
    expect(polls).toBeGreaterThan(0);

    setValue(
      card('claude').querySelector<HTMLInputElement>('input[aria-label="Code"]')!,
      'abcd1234',
    );
    await act(async () => buttonIn(card('claude'), 'Done')!.closest('form')!.requestSubmit());
    await until(() => card('claude').textContent!.includes('Checking the code'), 'checking');
    expect(server.requests.find((r) => r.path.endsWith('/code'))?.body).toEqual({
      code: 'abcd1234',
    });

    await act(async () => buttonIn(card('claude'), 'Cancel')!.click());
    await until(() => !card('claude').querySelector('[data-login]'), 'the cancel');
    expect(
      server.requests.some(
        (r) => r.method === 'DELETE' && r.path === `/api/v1/coders/claude/login/${LOGIN}`,
      ),
    ).toBe(true);
  });

  it('shows the link and the paste field when the login asks for the code at once', async () => {
    // The Claude CLI prints its link and asks for the code straight away.
    login = {
      ...login,
      status: 'awaiting_code',
      url: 'https://claude.ai/oauth/authorize?state=k3Wq',
    };
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('claude'), 'Sign in'), 'Sign in');
    await act(async () => buttonIn(card('claude'), 'Sign in')!.click());
    await until(() => !!card('claude').querySelector('[data-sign-in-url]'), 'the link');
    expect(buttonIn(card('claude'), 'Copy')).toBeDefined();
    expect(
      [...card('claude').querySelectorAll('a')].some((a) => a.textContent === 'Open link'),
    ).toBe(true);
    expect(card('claude').querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(card('claude').textContent).not.toContain('Checking the code');

    setValue(
      card('claude').querySelector<HTMLInputElement>('input[aria-label="Code"]')!,
      'abcd1234',
    );
    await act(async () => buttonIn(card('claude'), 'Done')!.closest('form')!.requestSubmit());
    await until(() => card('claude').textContent!.includes('Checking the code'), 'checking');
    expect(card('claude').querySelector('input[aria-label="Code"]')).toBeNull();
  });

  it('shows a lapsed plan sign-in with its error and Sign in again', async () => {
    agents = agents.map((a) =>
      a.agent === 'claude'
        ? {
            ...a,
            authKind: 'subscription',
            accountLabel: 'dan@example.com',
            lastError: 'claude: needs_login',
            needsSignIn: true,
            lastErrorKind: 'sign_in',
          }
        : a,
    );
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('claude'), 'Sign in again'), 'Sign in again');
    expect(card('claude').querySelector('[data-account-error]')?.textContent).toBe(
      'Claude Code is not signed in on the computer any more. Sign in again.',
    );
    expect(card('claude').textContent).not.toContain('needs_login');
    expect(buttonIn(card('claude'), 'Sign out')).toBeDefined();
    await act(async () => buttonIn(card('claude'), 'Sign in again')!.click());
    await until(() => !!card('claude').querySelector(`[data-login="${LOGIN}"]`), 'the login');
    expect(
      server.requests.some((r) => r.method === 'POST' && r.path === '/api/v1/coders/claude/login'),
    ).toBe(true);
  });

  it('stops polling and reads the account again once signed in', async () => {
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('claude'), 'Sign in'), 'Sign in');
    await act(async () => buttonIn(card('claude'), 'Sign in')!.click());
    await until(() => polls > 0, 'a poll');
    login = { ...login, status: 'signed_in', accountLabel: 'dan@example.com' };
    agents = agents.map((a) =>
      a.agent === 'claude'
        ? { ...a, authKind: 'subscription', accountLabel: 'dan@example.com', needsSignIn: false }
        : a,
    );
    await until(
      () => card('claude').textContent!.includes('Signed in as dan@example.com'),
      'signed in',
    );
    const seen = polls;
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(polls).toBe(seen);
    expect(card('claude').querySelector('[data-login]')).toBeNull();
    expect(buttonIn(card('claude'), 'Sign in')).toBeUndefined();
    expect(buttonIn(card('claude'), 'Sign out')).toBeDefined();
  });

  it('says when a sign-in expired, and offers Sign in again', async () => {
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('claude'), 'Sign in'), 'Sign in');
    await act(async () => buttonIn(card('claude'), 'Sign in')!.click());
    await until(() => polls > 0, 'a poll');
    login = { ...login, status: 'expired' };
    await until(() => card('claude').textContent!.includes('expired'), 'expired');
    expect(buttonIn(card('claude'), 'Sign in')).toBeDefined();
  });

  it('uses an API key from a provider the agent can use', async () => {
    render(<CodingAgentsSettings />);
    await until(() => !!buttonIn(card('claude'), 'Use API key'), 'Use API key');
    act(() => buttonIn(card('claude'), 'Use API key')!.click());
    const picker = card('claude').querySelector<HTMLSelectElement>(
      'select[aria-label="Claude Code API key"]',
    )!;
    // Claude Code takes Anthropic keys only.
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'Choose a provider',
      'Anthropic',
    ]);
    setValue(picker, ANTHROPIC);
    await act(async () => buttonIn(card('claude'), 'Use this key')!.click());
    await until(
      () => card('claude').textContent!.includes('Using API key: Anthropic'),
      'the key in use',
    );
    expect(server.requests.find((r) => r.path === '/api/v1/coders/claude/api-key')?.body).toEqual({
      providerId: ANTHROPIC,
    });
  });

  it('signs out', async () => {
    render(<CodingAgentsSettings />);
    await until(() => !!buttonIn(card('codex'), 'Sign out'), 'Sign out');
    await act(async () => buttonIn(card('codex'), 'Sign out')!.click());
    await until(
      () => card('codex').querySelector('[data-account-status]')?.textContent === 'Not signed in',
      'signed out',
    );
  });

  it('words the status line and filters providers by agent', () => {
    const providers = [
      provider(ANTHROPIC, 'Anthropic', 'anthropic'),
      provider(OPENAI, 'OpenAI', 'openai'),
    ] as never[];
    expect(accountWords(account({ agent: 'claude', authKind: 'subscription' }), [])).toBe(
      'Signed in',
    );
    expect(
      accountWords(account({ agent: 'codex', authKind: 'api_key', providerId: 'gone' }), []),
    ).toBe('Using API key: a provider from Settings > Models');
    expect(keyProviders('codex', providers).map((p) => p.name)).toEqual(['OpenAI']);
    expect(keyProviders('pi', providers)).toHaveLength(2);
  });
});

describe('Settings > Coding agents: Codex, pi and Check (CA3)', () => {
  it('runs the Codex device flow with the link and code and nothing to paste', async () => {
    const handle = server.handle;
    server.handle = async (request, path, body) => {
      if (path === '/api/v1/coders/codex/login' && request.method === 'POST') {
        return Response.json(
          {
            login: {
              ...login,
              agent: 'codex',
              url: 'https://auth.openai.com/codex/device',
              deviceCode: 'QWER-5678',
            },
          },
          { status: 201 },
        );
      }
      if (path.startsWith('/api/v1/coders/codex/login/')) {
        return Response.json({
          login: {
            ...login,
            agent: 'codex',
            url: 'https://auth.openai.com/codex/device',
            deviceCode: 'QWER-5678',
          },
        });
      }
      return handle(request, path, body);
    };
    render(<CodingAgentsSettings pollMs={20} />);
    await until(() => !!buttonIn(card('codex'), 'Sign in'), 'Sign in');
    await act(async () => buttonIn(card('codex'), 'Sign in')!.click());
    await until(() => !!card('codex').querySelector('[data-device-code]'), 'the device code');
    expect(card('codex').querySelector('[data-sign-in-url]')?.textContent).toBe(
      'https://auth.openai.com/codex/device',
    );
    expect(card('codex').querySelector('[data-device-code]')?.textContent).toBe('QWER-5678');
    expect(card('codex').textContent).toContain(
      'Enter this code on the OpenAI page; nothing to paste back here.',
    );
    expect(card('codex').querySelector('input[aria-label="Code"]')).toBeNull();
  });

  it('opens the pi sign-in in the Computer page terminal, then Check reads the account', async () => {
    const handle = server.handle;
    server.handle = async (request, path, body) => {
      if (path === '/api/v1/coders/pi/login' && request.method === 'POST') {
        return Response.json(
          {
            code: 'CODER_LOGIN_IN_TERMINAL',
            message: 'pi signs in inside its own terminal. Run /login there.',
            terminal: { cwd: '/home/coder', user: 'coder', preset: 'pi' },
          },
          { status: 409 },
        );
      }
      if (path === '/api/v1/coders/pi/check' && request.method === 'POST') {
        agents = agents.map((a) =>
          a.agent === 'pi'
            ? {
                ...a,
                authKind: 'subscription',
                accountLabel: 'dan@example.com',
                lastError: null,
                lastErrorKind: null,
                needsSignIn: false,
              }
            : a,
        );
        return Response.json({ account: agents[2] });
      }
      return handle(request, path, body);
    };
    const navigate = vi.fn();
    render(<CodingAgentsSettings pollMs={20} onNavigate={navigate} />);
    // Not signed in: the panel shows from the account alone, as after a reload.
    await until(() => !!card('pi')?.querySelector('[data-terminal-login]'), 'the terminal note');
    expect(buttonIn(card('pi'), 'Check')).toBeDefined();
    expect(buttonIn(card('pi'), 'Use API key')).toBeDefined();
    await act(async () => buttonIn(card('pi'), 'Sign in')!.click());
    await until(() => navigate.mock.calls.length > 0, 'the terminal');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      '/computer?cwd=%2Fhome%2Fcoder&user=coder&preset=pi',
    );
    // The cache write that carries the terminal reaches the card on React Query's next notify.
    await until(
      () =>
        !!card('pi').textContent?.includes(
          'pi signs in inside its own terminal. Run /login there.',
        ),
      'the terminal message',
    );
    expect(buttonIn(card('pi'), 'Open the terminal')).toBeDefined();
    await act(async () => buttonIn(card('pi'), 'Check')!.click());
    await until(
      () =>
        card('pi').querySelector('[data-account-status]')?.textContent ===
        'Signed in as dan@example.com',
      'the account',
    );
    expect(card('pi').querySelector('[data-terminal-login]')).toBeNull();
    expect(buttonIn(card('pi'), 'Use API key')).toBeDefined();
    // Signed in, pi still takes Check.
    expect(buttonIn(card('pi'), 'Check')).toBeDefined();
    expect(card('pi').textContent).not.toMatch(/[–—]| - /);
  });

  it('offers Check where the view says, Claude Code included, and reads the new version', async () => {
    agents = agents.map((a) =>
      a.agent === 'claude' || a.agent === 'codex'
        ? {
            ...a,
            authKind: 'subscription',
            accountLabel: 'dan@example.com',
            needsSignIn: false,
            checkAvailable: a.agent === 'claude',
          }
        : a,
    );
    const handle = server.handle;
    server.handle = async (request, path, body) => {
      if (path === '/api/v1/coders/claude/check') {
        agents = agents.map((a) => (a.agent === 'claude' ? { ...a, version: '2.1.0' } : a));
        return Response.json({ account: agents[0] });
      }
      return handle(request, path, body);
    };
    render(<CodingAgentsSettings />);
    await until(() => !!buttonIn(card('claude'), 'Check'), 'Check');
    // `checkAvailable` false: no Check, whatever the agent.
    expect(buttonIn(card('codex'), 'Check')).toBeUndefined();
    expect(card('claude').textContent).toContain('Version 1.0.0');
    await act(async () => buttonIn(card('claude'), 'Check')!.click());
    await until(() => card('claude').textContent!.includes('Version 2.1.0'), 'the new version');
    expect(server.requests.some((r) => r.path === '/api/v1/coders/codex/check')).toBe(false);
  });

  it('says what a signed-in plan bills, by the provider pi signed in to', async () => {
    const signedIn = {
      authKind: 'subscription',
      accountLabel: 'dan@example.com',
      needsSignIn: false,
    } as const;
    agents = [
      account({ agent: 'claude', ...signedIn, planProvider: 'anthropic' }),
      account({ agent: 'codex', ...signedIn, planProvider: 'openai' }),
      account({ agent: 'pi', ...signedIn, planProvider: 'anthropic' }),
    ];
    render(<CodingAgentsSettings />);
    await until(() => !!card('pi')?.querySelector('[data-plan]'), 'the plan line');
    const plan = (agent: string) => card(agent).querySelector('[data-plan]')?.textContent;
    expect(plan('claude')).toBe('Usage is billed to your Claude plan.');
    expect(plan('codex')).toBe('Usage is billed to your ChatGPT plan.');
    expect(plan('pi')).toBe('Usage is billed to your Claude plan as extra usage.');
    act(() => root!.unmount());
    host.remove();
    agents = [account({ agent: 'pi', ...signedIn, planProvider: 'openai' })];
    render(<CodingAgentsSettings />);
    await until(() => !!card('pi')?.querySelector('[data-plan]'), 'the plan line');
    expect(plan('pi')).toBe('Usage is billed to your ChatGPT plan.');
    act(() => root!.unmount());
    host.remove();
    agents = [account({ agent: 'pi', ...signedIn, planProvider: 'other' })];
    render(<CodingAgentsSettings />);
    await until(() => !!card('pi')?.querySelector('[data-plan]'), 'the plan line');
    expect(plan('pi')).toBe('Usage is billed to your plan.');
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('says a rejected key with a link to Settings > Models, and other errors as they are', async () => {
    agents = agents.map((a) =>
      a.agent === 'codex'
        ? { ...a, lastError: '401 invalid_api_key', lastErrorKind: 'key' }
        : a.agent === 'claude'
          ? { ...a, lastError: 'git clone failed', lastErrorKind: 'other' }
          : a,
    );
    render(<CodingAgentsSettings />);
    await until(() => !!card('codex')?.querySelector('[data-account-error]'), 'the error');
    const error = card('codex').querySelector('[data-account-error]')!;
    expect(error.textContent).toBe('The API key was rejected. Change it under Settings > Models.');
    expect(error.querySelector('a')?.getAttribute('href')).toBe('/settings/models');
    expect(card('claude').querySelector('[data-account-error]')?.textContent).toBe(
      'git clone failed',
    );
    expect(buttonIn(card('claude'), 'Sign in again')).toBeUndefined();
    expect(host.textContent).not.toMatch(/[–—]| - /);
  });

  it('offers only the providers each agent can use', () => {
    const providers = [
      provider('a', 'Anthropic', 'anthropic'),
      provider('b', 'Proxy', 'custom', 'anthropic_compatible'),
      provider('c', 'OpenAI', 'openai'),
      provider('d', 'Router', 'custom', 'openai_compatible'),
      provider('e', 'Google', 'google'),
      provider('f', 'xAI', 'xai'),
    ] as never[];
    const names = (agent: 'claude' | 'codex' | 'pi') =>
      keyProviders(agent, providers).map((p) => p.name);
    expect(names('claude')).toEqual(['Anthropic', 'Proxy']);
    expect(names('codex')).toEqual(['OpenAI', 'Router']);
    expect(names('pi')).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI']);
  });
});

describe('the coding session host', () => {
  it('opens the Computer page terminal where the server says, and reads the log', async () => {
    server.handle = async (_request, path) => {
      if (path === '/api/v1/coding-sessions/s1/terminal') {
        return Response.json({
          cwd: '/home/bot/repos/o/r/.worktrees/bot-x',
          user: 'coder',
          preset: 'claude --resume 7f3a',
        });
      }
      if (path === '/api/v1/coding-sessions/s1/log') return new Response('the whole log');
      if (path === '/api/v1/approvals/a1/decide') return Response.json({ status: 'approved' });
      return Response.json({ title: 'Not found' }, { status: 404 });
    };
    const navigate = vi.fn();
    const coder = codingSessionHost(navigate);
    await coder.openTerminal('s1');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      '/computer?cwd=%2Fhome%2Fbot%2Frepos%2Fo%2Fr%2F.worktrees%2Fbot-x&user=coder&preset=claude+--resume+7f3a',
    );
    expect(await coder.loadLog('s1')).toBe('the whole log');
    await coder.decideApproval('a1', 'deny');
    expect(server.requests.at(-1)).toEqual({
      method: 'POST',
      path: '/api/v1/approvals/a1/decide',
      body: { decision: 'deny' },
    });
    await expect(coder.loadLog('nope')).rejects.toThrow('Not found');
    expect(computerTerminalHref({ cwd: '/home/bot/x' })).toBe('/computer?cwd=%2Fhome%2Fbot%2Fx');
  });
});
