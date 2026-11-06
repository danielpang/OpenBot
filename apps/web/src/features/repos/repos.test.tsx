// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { GithubCard } from '../tools/github-card.js';
import type { GitConnectionView, GithubAppStatus, RemoteRepo } from './api.js';
import { diskTotal, formatDisk, isStuck, Repositories, STUCK_MS } from './repositories.js';

// Repositories and git connections in the web app against a fake REST
// server: the Connectors page's GitHub card (GH1, GH8), the repository picker
// (GH2), and the Computer page's Repositories with found clones, Keep cloned,
// Pin, Forget with its files, and rescue polling (GH3 to GH6).

const CONN = '00000000-0000-4000-8000-0000000000e1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    handle: (async () => Response.json({ title: 'Not found' }, { status: 404 })) as (
      request: Request,
    ) => Promise<Response>,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname, search } = new URL(request.url, 'http://localhost');
    const text = request.method === 'GET' ? '' : await request.clone().text();
    state.requests.push({
      method: request.method,
      path: pathname + search,
      body: text ? (JSON.parse(text) as unknown) : null,
    });
    return state.handle(request);
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (over: Partial<GitConnectionView> = {}): GitConnectionView => ({
  id: CONN,
  provider: 'github',
  kind: 'app',
  installationId: '42',
  accountLogin: 'danielpang',
  accountType: 'user',
  actAs: 'bot',
  status: 'connected',
  lastSyncedAt: null,
  repoCount: 2,
  error: null,
  ...over,
});

const remote = (fullName: string, over: Partial<RemoteRepo> = {}): RemoteRepo => ({
  fullName,
  private: false,
  defaultBranch: 'main',
  description: null,
  pushedAt: null,
  remembered: false,
  ...over,
});

const checkout = (over: object = {}) => ({
  state: 'ready',
  path: '/home/bot/repos/danielpang/OpenBots',
  ahead: 0,
  behind: 0,
  headSha: 'abc',
  lastFetchAt: null,
  error: null,
  ...over,
});

const repo = (id: string, fullName: string, over: object = {}) => ({
  id,
  fullName,
  remoteUrl: `https://github.com/${fullName}.git`,
  defaultBranch: 'main',
  keepCloned: true,
  pinned: false,
  description: null,
  lastUsedAt: null,
  lastRemotePushAt: null,
  found: false,
  checkout: checkout({ path: `/home/bot/repos/${fullName}` }),
  ...over,
});

let app: GithubAppStatus;
let connections: GitConnectionView[];
let remotes: RemoteRepo[];
let repos: ReturnType<typeof repo>[];
let found: { path: string; remoteUrl: string; fullName: string | null }[];
let rescuePolls: number;
let actAsAnswer: 'ok' | 'needs-sign-in';
let syncReauthorize: boolean;

beforeEach(() => {
  server.requests.length = 0;
  app = {
    configured: true,
    source: 'config',
    slug: 'openbots',
    installUrlAvailable: true,
    manifestAvailable: false,
    publicUrlOk: true,
  };
  actAsAnswer = 'ok';
  syncReauthorize = false;
  connections = [connection()];
  remotes = [
    remote('danielpang/OpenBots', { remembered: true, private: true }),
    remote('danielpang/site', { pushedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
    remote('danielpang/notes'),
  ];
  repos = [repo('r1', 'danielpang/OpenBots')];
  found = [
    {
      path: '/home/bot/scratch/pi-mono',
      remoteUrl: 'https://github.com/badlogic/pi-mono.git',
      fullName: 'badlogic/pi-mono',
    },
  ];
  rescuePolls = 0;
  server.handle = async (request) => {
    const { pathname, searchParams } = new URL(request.url);
    const method = request.method;
    const json = async () => (await request.clone().json()) as Record<string, unknown>;
    if (pathname === '/api/v1/git-connections/github-app') return Response.json(app);
    if (pathname === '/api/v1/git-connections/github-app/manifest') {
      return Response.json({
        url: 'https://github.com/settings/apps/new?state=s1',
        manifest: { name: 'OpenBots', url: 'https://bots.example.com' },
      });
    }
    if (pathname === '/api/v1/git-connections') return Response.json({ connections });
    if (pathname === '/api/v1/git-connections/token') {
      const added = connection({ id: 'c2', kind: 'token', accountLogin: 'octo' });
      connections = [...connections, added];
      return Response.json({ connection: added }, { status: 201 });
    }
    if (pathname === `/api/v1/git-connections/${CONN}/repositories`) {
      const q = searchParams.get('q') ?? '';
      return Response.json({ repositories: remotes.filter((r) => r.fullName.includes(q)) });
    }
    if (pathname === `/api/v1/git-connections/${CONN}/sync`) {
      connections = connections.map((c) => ({ ...c, repoCount: 5 }));
      return Response.json({
        connection: connections[0],
        ...(syncReauthorize ? { needsReauthorize: true } : {}),
      });
    }
    if (pathname === `/api/v1/git-connections/${CONN}`) {
      if (method === 'DELETE') {
        connections = [];
        return new Response(null, { status: 204 });
      }
      if (actAsAnswer === 'needs-sign-in') {
        return Response.json(
          {
            title: 'Conflict',
            code: 'ACT_AS_NEEDS_SIGN_IN',
            detail: 'Sign in with GitHub on the GitHub connector first, then choose Me.',
          },
          { status: 409 },
        );
      }
      const body = await json();
      connections = connections.map((c) => ({ ...c, ...body }));
      return Response.json({ connection: connections[0] });
    }
    if (pathname === '/api/v1/connectors') {
      return Response.json({ items: [{ id: 'k1', catalogId: 'github', name: 'GitHub' }] });
    }
    if (pathname === '/api/v1/repos' && method === 'GET') return Response.json({ repos });
    if (pathname === '/api/v1/repos/remember') {
      const body = (await json()) as { fullNames: string[] };
      const added = body.fullNames.map((n, i) =>
        repo(`n${i}`, n, { checkout: checkout({ state: 'cloning', path: null }) }),
      );
      repos = [...repos, ...added];
      return Response.json({ repos: added });
    }
    if (pathname === '/api/v1/repos/found') return Response.json({ found });
    if (pathname === '/api/v1/repos/found/remember') {
      const added = repo('f1', 'badlogic/pi-mono', { found: true });
      found = [];
      repos = [...repos, added];
      return Response.json({ repo: added });
    }
    if (pathname === '/api/v1/repos/scan') return new Response(null, { status: 202 });
    if (pathname === '/api/v1/repos/rescue') return Response.json({ requestId: 'q1' });
    if (pathname === '/api/v1/repos/rescue/q1') {
      rescuePolls += 1;
      return Response.json(
        rescuePolls < 2
          ? { status: 'running', results: [] }
          : {
              status: 'done',
              results: [
                {
                  repoId: 'r1',
                  fullName: 'danielpang/OpenBots',
                  branch: 'openbots/rescue/2026-11-05T10-30',
                  pushed: true,
                  note: 'Pushed 2 commits and the uncommitted changes.',
                },
                {
                  repoId: 'r2',
                  fullName: 'danielpang/notes',
                  branch: null,
                  pushed: false,
                  note: 'The connection cannot push to this repository.',
                },
              ],
            },
      );
    }
    const match = /^\/api\/v1\/repos\/([^/]+)$/.exec(pathname);
    if (match) {
      const id = match[1]!;
      if (method === 'DELETE') {
        repos = repos.filter((r) => r.id !== id);
        const deleted = searchParams.get('deleteFiles') === 'true';
        return Response.json({
          filesDeleted: deleted,
          path: '/home/bot/repos/danielpang/OpenBots',
          note: deleted
            ? 'Deleted /home/bot/repos/danielpang/OpenBots from the computer.'
            : 'The clone stays on the computer.',
        });
      }
      const body = await json();
      repos = repos.map((r) => (r.id === id ? { ...r, ...body } : r));
      return Response.json({ repo: repos.find((r) => r.id === id) });
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

function render(ui: ReactNode, deployment: 'managed' | 'self_hosted' = 'self_hosted') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    computer: true,
    deployment,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>));
}

async function until(check: () => boolean, what: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${document.body.textContent}`);
}

const button = (label: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (el: Element | undefined | null) => act(() => (el as HTMLElement).click());
const sent = (method: string, path: string) =>
  server.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto = Object.getPrototypeOf(el) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const noDashes = () => expect(document.body.textContent).not.toMatch(/[–—]| - /);

describe('the GitHub card (GH1, GH8)', () => {
  it('installs the App when this install has one', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    render(<GithubCard admin />);
    await until(() => !!button('Install the OpenBots app'), 'the install button');
    expect(button('Create a GitHub App for this install')).toBeUndefined();
    click(button('Install the OpenBots app'));
    expect(assign).toHaveBeenCalledWith('/api/v1/git-connections/github-app/install');
    noDashes();
  });

  const noApp = (over: Partial<GithubAppStatus> = {}): GithubAppStatus => ({
    configured: false,
    source: null,
    slug: null,
    installUrlAvailable: false,
    manifestAvailable: true,
    publicUrlOk: true,
    ...over,
  });
  const createForm = () =>
    host.querySelector<HTMLFormElement>('form[aria-label="Create a GitHub App"]');
  function catchSubmit() {
    const submitted: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this);
    });
    return submitted;
  }

  it('creates an App on the personal account when the manifest flow is available', async () => {
    app = noApp();
    const submitted = catchSubmit();
    render(<GithubCard admin />);
    await until(() => !!createForm(), 'the create form');
    expect(createForm()!.textContent).toContain('Create a GitHub App for this install');
    expect(createForm()!.textContent).toContain('On your personal account');
    expect(createForm()!.textContent).toContain('On an organization');
    expect(button('Install the OpenBots app')).toBeUndefined();
    click(button('Create the App on GitHub'));
    await until(() => submitted.length === 1, 'the manifest form');
    const form = submitted[0]!;
    expect(form.method.toLowerCase()).toBe('post');
    expect(form.action).toBe('https://github.com/settings/apps/new?state=s1');
    const field = form.querySelector<HTMLInputElement>('input[name="manifest"]')!;
    expect(JSON.parse(field.value)).toEqual({ name: 'OpenBots', url: 'https://bots.example.com' });
    expect(sent('POST', '/api/v1/git-connections/github-app/manifest')).toEqual([{}]);
    form.remove();
    noDashes();
  });

  it('creates an App on an organization, sending its login', async () => {
    app = noApp();
    const submitted = catchSubmit();
    render(<GithubCard admin />);
    await until(() => !!createForm(), 'the create form');
    click(createForm()!.querySelector('input[value="organization"]'));
    expect(button('Create the App on GitHub')!.disabled).toBe(true);
    setValue(createForm()!.querySelector('input[name="organization"]')!, ' acme ');
    click(button('Create the App on GitHub'));
    await until(() => submitted.length === 1, 'the manifest form');
    expect(sent('POST', '/api/v1/git-connections/github-app/manifest')).toEqual([
      { organization: 'acme' },
    ]);
    submitted[0]!.remove();
  });

  it('says an https public URL is needed when the manifest flow is not available', async () => {
    app = noApp({ manifestAvailable: false, publicUrlOk: false });
    render(<GithubCard admin />);
    await until(() => !!host.querySelector('[data-no-app]'), 'the explanation');
    expect(host.querySelector('[data-no-app]')!.textContent).toContain(
      'Creating one needs an https public URL (OPENBOTS_PUBLIC_URL) that GitHub can reach.',
    );
    expect(createForm()).toBeNull();
    expect(button('Paste a token instead')).toBeDefined();
    noDashes();
  });

  it('shows nothing about creating an App on a managed install', async () => {
    app = noApp({ manifestAvailable: false });
    render(<GithubCard admin />, 'managed');
    await until(() => !!button('Paste a token instead'), 'the card');
    expect(createForm()).toBeNull();
    expect(host.querySelector('[data-no-app]')).toBeNull();
  });

  it('lists connections with status, act as, sync and disconnect', async () => {
    connections = [
      connection(),
      connection({
        id: 'c3',
        accountLogin: 'acme',
        status: 'needs_reinstall',
        accountType: 'organization',
      }),
    ];
    render(<GithubCard admin />);
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-connection="${id}"]`)!;
    await until(() => !!row('c3'), 'the rows');
    expect(row(CONN).querySelector('[data-status]')!.textContent).toBe('Connected');
    expect(row(CONN).textContent).toContain('2 repositories');
    expect(row('c3').querySelector('[data-status]')!.textContent).toBe('Needs reinstall');
    expect(button('Pick repositories', row('c3'))).toBeUndefined();

    setValue(row(CONN).querySelector('select')!, 'owner');
    await until(() => sent('PATCH', `/api/v1/git-connections/${CONN}`).length === 1, 'the patch');
    expect(sent('PATCH', `/api/v1/git-connections/${CONN}`)).toEqual([{ actAs: 'owner' }]);

    click(button('Sync', row(CONN)));
    await until(() => row(CONN).textContent!.includes('5 repositories'), 'the sync');

    click(button('Disconnect', row(CONN)));
    expect(row(CONN).textContent).toContain('Disconnect danielpang?');
    click(button('Disconnect', row(CONN)));
    await until(() => !row(CONN), 'disconnected');
    expect(sent('DELETE', `/api/v1/git-connections/${CONN}`)).toHaveLength(1);
    noDashes();
  });

  it('offers Act as only on App connections and says what the list reaches', async () => {
    connections = [connection(), connection({ id: 'c4', kind: 'token', accountLogin: 'octo' })];
    render(<GithubCard admin />);
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-connection="${id}"]`)!;
    await until(() => !!row('c4'), 'the rows');
    expect(row(CONN).querySelector('select')).not.toBeNull();
    expect(row('c4').querySelector('select')).toBeNull();
    expect(row('c4').textContent).not.toContain('Act as');
    expect(host.querySelector('[data-reach-note]')!.textContent).toContain('push access');
  });

  it('shows the server message and a link to the GitHub connector when Me needs a sign-in', async () => {
    actAsAnswer = 'needs-sign-in';
    render(<GithubCard admin />);
    const row = () => host.querySelector<HTMLElement>(`[data-connection="${CONN}"]`)!;
    await until(() => !!row(), 'the row');
    setValue(row().querySelector('select')!, 'owner');
    await until(() => !!row().querySelector('[data-act-as-sign-in]'), 'the sign-in note');
    const note = row().querySelector('[data-act-as-sign-in]')!;
    expect(note.textContent).toContain(
      'Sign in with GitHub on the GitHub connector first, then choose Me.',
    );
    await until(
      () => note.querySelector('a')!.getAttribute('href') === '/connectors?connector=k1',
      'the connector link',
    );
  });

  it('offers Re-check access when a sync says GitHub needs it', async () => {
    syncReauthorize = true;
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    render(<GithubCard admin />);
    const row = () => host.querySelector<HTMLElement>(`[data-connection="${CONN}"]`)!;
    await until(() => !!row(), 'the row');
    expect(button('Re-check access', row())).toBeUndefined();
    click(button('Sync', row()));
    await until(() => !!button('Re-check access', row()), 'the button');
    click(button('Re-check access', row()));
    expect(assign).toHaveBeenCalledWith(`/api/v1/git-connections/${CONN}/reauthorize`);
  });

  it('connects with a pasted token', async () => {
    render(<GithubCard admin />);
    await until(() => !!button('Paste a token instead'), 'the link');
    click(button('Paste a token instead'));
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Paste a GitHub token"]')!;
    setValue(form.querySelector('input[name="token"]')!, 'github_pat_abc');
    act(() => form.requestSubmit());
    await until(() => !!host.querySelector('[data-connection="c2"]'), 'the token connection');
    expect(sent('POST', '/api/v1/git-connections/token')).toEqual([{ token: 'github_pat_abc' }]);
  });

  it('opens the picker for a connection GitHub sent back', async () => {
    const handled = vi.fn();
    render(<GithubCard admin arrival={{ connection: CONN }} onArrivalHandled={handled} />);
    await until(() => !!document.querySelector('[data-remote="danielpang/site"]'), 'the picker');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('GitHub is connected');
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe('the repository picker (GH2)', () => {
  it('lists repositories, keeps the remembered ones checked, and remembers the picked', async () => {
    render(<GithubCard admin />);
    await until(() => !!button('Pick repositories'), 'the row');
    click(button('Pick repositories'));
    const item = (name: string) => document.querySelector<HTMLElement>(`[data-remote="${name}"]`)!;
    const box = (name: string) => item(name).querySelector<HTMLInputElement>('input')!;
    await until(() => !!item('danielpang/notes'), 'the list');
    expect(box('danielpang/OpenBots').checked).toBe(true);
    expect(box('danielpang/OpenBots').disabled).toBe(true);
    expect(item('danielpang/OpenBots').textContent).toContain('Private');
    expect(item('danielpang/site').textContent).toContain('main · pushed 4 min ago');

    const keep = () => button('Keep on the computer') ?? button('Keep 2 on the computer');
    expect(keep()!.disabled).toBe(true);
    click(box('danielpang/site'));
    click(box('danielpang/notes'));
    expect(button('Keep 2 on the computer')).toBeDefined();

    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search repositories"]',
    )!;
    setValue(search, 'site');
    await until(() => !item('danielpang/notes'), 'the search');
    expect(server.requests.some((r) => r.path.endsWith('/repositories?q=site'))).toBe(true);

    click(button('Keep 2 on the computer'));
    await until(() => !document.querySelector('[data-remote]'), 'the dialog to close');
    expect(sent('POST', '/api/v1/repos/remember')).toEqual([
      { fullNames: ['danielpang/site', 'danielpang/notes'], connectionId: CONN },
    ]);
    noDashes();
  });
});

describe('the Repositories section (GH3 to GH6)', () => {
  const row = (name: string) => host.querySelector<HTMLElement>(`[data-repo="${name}"]`)!;

  it('opens the picker from Add from GitHub, or links to Connectors without a connection', async () => {
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!button('Add from GitHub'), 'the button');
    expect(button('Add by URL')).toBeDefined();
    click(button('Add from GitHub'));
    await until(() => !!document.querySelector('[data-remote="danielpang/site"]'), 'the picker');
    act(() => root?.unmount());
    host.remove();

    connections = [];
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!host.querySelector('[data-connect-github]'), 'the link');
    expect(host.querySelector('[data-connect-github]')!.getAttribute('href')).toBe('/connectors');
    expect(button('Add from GitHub')).toBeUndefined();
  });

  it('shows Updating, the last push, and patches Keep cloned and Pin', async () => {
    repos = [
      repo('r1', 'danielpang/OpenBots', {
        lastRemotePushAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      }),
      repo('r2', 'danielpang/relay', { checkout: checkout({ state: 'updating' }) }),
    ];
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!row('danielpang/relay'), 'the list');
    expect(row('danielpang/relay').querySelector('[data-state]')!.textContent).toBe('Updating');
    expect(row('danielpang/OpenBots').textContent).toContain('Last pushed to GitHub 3 hours ago');
    expect(host.textContent).toContain('Keep cloned is set per repository');

    click(row('danielpang/OpenBots').querySelector('input[name="keepCloned"]'));
    await until(() => sent('PATCH', '/api/v1/repos/r1').length === 1, 'the keep patch');
    await until(
      () =>
        !row('danielpang/OpenBots').querySelector<HTMLInputElement>('input[name="keepCloned"]')!
          .checked,
      'unchecked',
    );
    click(button('Pin', row('danielpang/relay')));
    await until(() => !!button('Unpin', row('danielpang/relay')), 'pinned');
    expect(sent('PATCH', '/api/v1/repos/r1')).toEqual([{ keepCloned: false }]);
    expect(sent('PATCH', '/api/v1/repos/r2')).toEqual([{ pinned: true }]);
    // Pinned repositories come first.
    expect(host.querySelector('[data-repo]')!.getAttribute('data-repo')).toBe('danielpang/relay');
    noDashes();
  });

  it('shows disk use per repository and the total in the header', async () => {
    repos = [
      repo('r1', 'danielpang/OpenBots', { diskBytes: Math.round(12.4 * 1024 * 1024) }),
      repo('r2', 'danielpang/relay', {
        checkout: checkout({ path: '/home/bot/repos/danielpang/relay' }),
        diskBytes: 512 * 1024,
      }),
      repo('r3', 'danielpang/notes', { diskBytes: null }),
    ];
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!row('danielpang/notes'), 'the list');
    expect(row('danielpang/OpenBots').querySelector('[data-disk]')!.textContent).toBe(' · 12.4 MB');
    expect(row('danielpang/relay').querySelector('[data-disk]')!.textContent).toBe(' · 512.0 KB');
    expect(row('danielpang/notes').querySelector('[data-disk]')).toBeNull();
    expect(host.querySelector('[data-disk-total]')!.textContent).toBe('12.9 MB on disk');
    expect(formatDisk(900)).toBe('900 B');
    expect(formatDisk(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(diskTotal([])).toBeNull();
    noDashes();
  });

  it('forgets a repository and its files when asked', async () => {
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!row('danielpang/OpenBots'), 'the list');
    click(button('Forget', row('danielpang/OpenBots')));
    click(row('danielpang/OpenBots').querySelector('input[name="deleteFiles"]'));
    click(button('Forget', row('danielpang/OpenBots')));
    await until(() => !row('danielpang/OpenBots'), 'forgotten');
    expect(server.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/api/v1/repos/r1?deleteFiles=true',
    ]);
    await until(() => !!host.querySelector('[data-toast]'), 'the toast');
    expect(host.querySelector('[data-toast]')!.textContent).toContain(
      'Deleted /home/bot/repos/danielpang/OpenBots from the computer.',
    );
  });

  it('shows Stuck instead of a spinner for a clone that has not moved in 30 minutes', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    repos = [
      repo('r1', 'danielpang/OpenBots', {
        checkout: checkout({ state: 'cloning', updatedAt: old }),
      }),
      repo('r2', 'danielpang/relay', { checkout: checkout({ state: 'updating' }) }),
    ];
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!row('danielpang/relay'), 'the list');
    const stuck = row('danielpang/OpenBots');
    expect(stuck.querySelector('[data-stuck]')!.textContent).toBe('Stuck');
    expect(stuck.textContent).toContain('Will retry when the computer starts.');
    expect(stuck.querySelector('svg')).toBeNull();
    expect(row('danielpang/relay').querySelector('[data-stuck]')).toBeNull();
    expect(row('danielpang/relay').textContent).toContain('Updating');
  });

  it('tells a stuck clone by its last change, or by when the page first saw it busy', () => {
    const now = Date.now();
    const cloning = (updatedAt?: string) =>
      repo('r1', 'o/r', { checkout: checkout({ state: 'cloning', updatedAt }) }) as never;
    expect(isStuck(cloning(new Date(now - STUCK_MS).toISOString()), now, now)).toBe(true);
    expect(isStuck(cloning(new Date(now - 60_000).toISOString()), now, now)).toBe(false);
    expect(isStuck(cloning(), now - STUCK_MS, now)).toBe(true);
    expect(isStuck(cloning(), now - 60_000, now)).toBe(false);
  });

  it('lists clones found on the computer, remembers one, and scans', async () => {
    render(<Repositories running onOpenTerminal={() => {}} />);
    const item = () => host.querySelector<HTMLElement>('[data-found="/home/bot/scratch/pi-mono"]');
    await until(() => !!item(), 'the found clone');
    expect(host.textContent).toContain('Found on the computer, not remembered');
    expect(item()!.textContent).toContain('badlogic/pi-mono');
    expect(item()!.textContent).toContain('https://github.com/badlogic/pi-mono.git');
    click(button('Remember', item()!));
    await until(() => !!row('badlogic/pi-mono') && !item(), 'remembered');
    expect(sent('POST', '/api/v1/repos/found/remember')).toEqual([
      { path: '/home/bot/scratch/pi-mono' },
    ]);
    click(button('Scan now'));
    await until(() => sent('POST', '/api/v1/repos/scan').length === 1, 'the scan');
  });

  it(
    'watches the found list after a scan until it changes, then stops',
    { timeout: 15_000 },
    async () => {
      found = [];
      render(<Repositories running onOpenTerminal={() => {}} />);
      await until(() => !!button('Scan now'), 'the scan button');
      const gets = () => server.requests.filter((r) => r.path === '/api/v1/repos/found').length;
      click(button('Scan now'));
      await until(() => sent('POST', '/api/v1/repos/scan').length === 1, 'the scan');
      await until(() => button('Scanning…') !== undefined, 'scanning');
      const before = gets();
      found = [{ path: '/home/bot/scratch/new', remoteUrl: 'https://x/y.git', fullName: 'x/y' }];
      await until(
        () => !!host.querySelector('[data-found="/home/bot/scratch/new"]'),
        'the new clone',
        5_000,
      );
      expect(gets()).toBeGreaterThan(before);
      await until(() => !!button('Scan now'), 'scanning to stop');
      const after = gets();
      await act(() => new Promise((r) => setTimeout(r, 2_500)));
      expect(gets()).toBe(after);
    },
  );

  it('rescues unpushed work, polling until it is done', { timeout: 15_000 }, async () => {
    render(<Repositories running onOpenTerminal={() => {}} />);
    await until(() => !!row('danielpang/OpenBots'), 'the list');
    click(button('Rescue unpushed work'));
    await until(() => !!host.querySelector('[data-rescue="running"]'), 'running');
    await until(() => !!host.querySelector('[data-rescue="done"]'), 'done', 10_000);
    expect(rescuePolls).toBe(2);
    const result = (name: string) => host.querySelector<HTMLElement>(`[data-rescued="${name}"]`)!;
    expect(result('danielpang/OpenBots').textContent).toContain('Pushed');
    expect(result('danielpang/OpenBots').textContent).toContain('openbots/rescue/2026-11-05T10-30');
    expect(result('danielpang/notes').textContent).toContain('Not pushed');
    expect(result('danielpang/notes').textContent).toContain(
      'The connection cannot push to this repository.',
    );
    expect(sent('POST', '/api/v1/repos/rescue')).toHaveLength(1);
    noDashes();
  });
});
