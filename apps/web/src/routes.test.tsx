import { afterAll, describe, expect, it, vi } from 'vitest';
import { configureWeb } from './app/extensions.js';
import { me, renderPath } from './test-utils.js';

// The API client binds `fetch` when its module loads, so the fake goes in
// before any import: it answers paths in `server.routes` and 401s the rest.
const server = vi.hoisted(() => {
  const state = { routes: {} as Record<string, unknown>, realFetch: globalThis.fetch };
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (!(pathname in state.routes)) {
      return Response.json({ title: 'Not signed in', status: 401 }, { status: 401 });
    }
    // A route's `__status` answers with that status (an error's problem document).
    const body = state.routes[pathname] as { __status?: number } | undefined;
    return Response.json(body, { status: body?.__status ?? 200 });
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

// The install's deployment, as /api/v1/capabilities reports it.
const capabilities = (deployment: 'self_hosted' | 'managed') => ({
  '/api/v1/capabilities': { oauth: { github: false, google: false }, computer: false, deployment },
});
const managed = capabilities('managed');
const selfHosted = capabilities('self_hosted');
// The Mac app on This Mac, which signs its owner in itself.
const local = {
  '/api/v1/capabilities': {
    ...selfHosted['/api/v1/capabilities'],
    auth: 'local',
  },
};
const localOwner = () => {
  const owner = me('owner');
  return { ...owner, user: { ...owner.user, email: 'owner@openbots.local', name: 'Ada' } };
};
const text = (html: string) => html.replace(/<[^>]*>/g, ' ');

describe('routes', () => {
  it('sends a signed-out visitor to sign in', async () => {
    server.routes = {};
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/sign-in');
    expect(html).toContain('Sign in');
  });

  it('renders the shell: New, the roster sections, the page links, no right panel', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/');
    expect(html).toContain('New');
    for (const section of ['Pinned', 'Bots', 'Groups']) expect(html).toContain(`>${section}</h2>`);
    for (const page of ['connectors', 'skills', 'computer', 'settings']) {
      expect(html).toContain(`href="/${page}"`);
    }
    expect(html).not.toContain('<aside');
  });

  it('fits the shell to the window and scrolls only the main pane', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { html } = await renderPath('/');
    // Positioned panes keep hidden absolute elements from stretching the document.
    expect(html).toContain('data-slot="shell" class="relative flex h-dvh overflow-hidden"');
    expect(html).toContain(
      '<main data-slot="content" class="relative min-w-0 flex-1 overflow-auto"',
    );
  });

  it('names the connectors page Connectors in the sidebar and the page title', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { pathname, html } = await renderPath('/connectors');
    expect(pathname).toBe('/connectors');
    expect(html).toMatch(/href="\/connectors"[^>]*>Connectors</);
    expect(html).toContain('>Connectors</h1>');
    expect(html).not.toContain('>Tools<');
  });

  it('sends an old /tools link to Connectors and keeps its search', async () => {
    server.routes = { '/api/v1/me': me('member') };
    expect((await renderPath('/tools')).pathname).toBe('/connectors');
    const { pathname, search } = await renderPath('/tools?connector=c1&oauth=connected');
    expect(pathname).toBe('/connectors');
    expect(search).toBe('?connector=c1&oauth=connected');
  });

  it('has no organization tabs of its own on the managed service', async () => {
    server.routes = { ...managed, '/api/v1/me': me('owner') };
    const owner = (await renderPath('/settings/account')).html;
    expect(owner).toContain('href="/settings/models"');
    // Limits live in the managed build's organization settings (plan 21.5).
    expect(owner).not.toContain('href="/settings/limits"');
    expect(owner).not.toContain('href="/settings/admin"');
    expect((await renderPath('/settings/limits')).pathname).toBe('/settings/account');
  });

  it("adds the managed build's settings tabs to whoever may see them", async () => {
    configureWeb({
      settingsTabs: [
        {
          section: 'organization',
          label: 'Organization',
          visible: (caller) => caller.role !== 'member',
          Component: () => <p>Organization page</p>,
        },
      ],
    });
    try {
      server.routes = { ...managed, '/api/v1/me': me('admin') };
      const tab = await renderPath('/settings/organization');
      expect(tab.pathname).toBe('/settings/organization');
      expect(tab.html).toContain('Organization page');
      expect(tab.html).toContain('href="/settings/organization"');
      server.routes = { ...managed, '/api/v1/me': me('member') };
      expect((await renderPath('/settings/organization')).pathname).toBe('/settings/account');
      expect((await renderPath('/settings/nowhere')).pathname).toBe('/settings/account');
    } finally {
      configureWeb({});
    }
  });

  it('sends someone with no active organization, or suspended in it, to onboarding', async () => {
    const nobody = { ...me('member'), role: null, workspace: null, limits: null };
    server.routes = { ...managed, '/api/v1/me': nobody };
    const onboarding = await renderPath('/');
    expect(onboarding.pathname).toBe('/onboarding');
    expect(onboarding.html).toContain('not part of a workspace');
    const suspended = me('member');
    server.routes = {
      ...managed,
      '/api/v1/me': { ...suspended, workspace: { ...suspended.workspace, suspended: true } },
    };
    expect((await renderPath('/connectors')).pathname).toBe('/onboarding');
    // With an organization, onboarding is only for an invite.
    server.routes = { ...managed, '/api/v1/me': me('member') };
    expect((await renderPath('/onboarding')).pathname).toBe('/');
    expect((await renderPath('/onboarding?invite=abc')).pathname).toBe('/onboarding');
  });

  it('sends an account whose email is not verified to sign in, which says why', async () => {
    server.routes = {
      ...managed,
      '/api/v1/me': { __status: 403, status: 403, code: 'EMAIL_NOT_VERIFIED', title: 'Verify' },
    };
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/sign-in');
    expect(html).toContain('This email is not confirmed');
  });

  it('gives a self-hosted owner Limits, and no organization tabs', async () => {
    for (const routes of [selfHosted, {}]) {
      server.routes = { ...routes, '/api/v1/me': me('owner') };
      const { html } = await renderPath('/settings/account');
      for (const tab of ['account', 'models', 'events', 'limits']) {
        expect(html).toContain(`href="/settings/${tab}"`);
      }
      expect(html).not.toContain('href="/settings/admin"');
      expect(html).not.toContain('href="/settings/audit"');
    }
    expect((await renderPath('/settings/limits')).pathname).toBe('/settings/limits');
  });

  it('puts Devices right after the first Settings tab on every deployment', async () => {
    for (const [routes, first] of [
      [selfHosted, 'account'],
      [managed, 'account'],
      [local, 'general'],
    ] as const) {
      server.routes = {
        ...routes,
        '/api/v1/me': first === 'general' ? localOwner() : me('owner'),
      };
      const { html, pathname } = await renderPath('/settings/devices');
      expect(pathname).toBe('/settings/devices');
      const tabs = [...html.matchAll(/href="\/settings\/([a-z]+)"/g)].map((m) => m[1]);
      expect(tabs.slice(0, 2)).toEqual([first, 'devices']);
    }
  }, 20_000);

  it('says nothing about admins to a self-hosted owner in Settings', async () => {
    server.routes = { ...selfHosted, '/api/v1/me': me('owner') };
    for (const tab of ['account', 'models', 'events', 'limits']) {
      const { html } = await renderPath(`/settings/${tab}`);
      expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/admin/i);
      expect(html).not.toMatch(/href="\/settings\/(admin|audit)"/);
    }
    // Four pages rendered in turn; slow when the whole repository's tests run at once.
  }, 20_000);

  it('marks the open settings tab the way the sidebar marks its open link', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { html } = await renderPath('/settings/models');
    const tab = (path: string) => html.match(new RegExp(`<a [^>]*href="${path}"[^>]*>`))![0];
    expect(tab('/settings/models')).toContain('data-status="active"');
    expect(tab('/settings/models')).toContain('aria-selected="true"');
    expect(tab('/settings/models')).toContain('data-[status=active]:bg-accent');
    expect(tab('/settings/models')).toContain('data-[status=active]:font-medium');
    expect(tab('/settings/account')).not.toContain('data-status="active"');
    expect(tab('/settings/account')).not.toContain('aria-selected');
  });

  it('sends a member who opens the Admin or Audit log tab, or bare Settings, to Account', async () => {
    server.routes = { ...managed, '/api/v1/me': me('member') };
    expect((await renderPath('/settings/admin')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings/audit')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings')).pathname).toBe('/settings/account');
  });

  it('explains an invite rejection passed back from an OAuth signup', async () => {
    server.routes = { ...managed };
    const { html } = await renderPath('/sign-up?invite=obi_x&error=INVITE_INVALID');
    expect(html).toContain('This invite link is invalid');
  });

  it('sends every visitor of a new install to the setup wizard', async () => {
    server.routes = { '/api/v1/setup': { setupRequired: true } };
    for (const path of ['/', '/sign-in', '/sign-up', '/settings/models']) {
      const { pathname, html } = await renderPath(path);
      expect(pathname).toBe('/setup');
      expect(html).toContain('Create your account');
      expect(html).toContain('Your account will be its owner.');
      expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/admin/i);
    }
  });

  it('shows how to pair instead of the account form when the owner is made by pairing', async () => {
    server.routes = { '/api/v1/setup': { setupRequired: true, pairingOnly: true } };
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/setup');
    expect(html).toContain('Set up OpenBots from your phone');
    expect(html).toContain('openbots pair');
    expect(html).not.toContain('Create your account');
  });

  it('hides the setup wizard once a user exists', async () => {
    server.routes = { '/api/v1/setup': { setupRequired: false } };
    const signedOut = await renderPath('/setup');
    expect(signedOut.pathname).toBe('/sign-in');
    expect(signedOut.html).not.toContain('Create your account');

    server.routes = { '/api/v1/setup': { setupRequired: false }, '/api/v1/me': me('admin') };
    expect((await renderPath('/setup')).pathname).toBe('/');
  });

  it('offers only sign-in on a self-hosted install once its owner exists', async () => {
    server.routes = { ...selfHosted, '/api/v1/setup': { setupRequired: false } };
    const signUp = await renderPath('/sign-up');
    expect(signUp.pathname).toBe('/sign-in');
    expect(signUp.search).toBe('?signup=closed');
    expect(signUp.html).toContain(
      'This OpenBots server has one account, its owner. Sign up is closed.',
    );
    expect(signUp.html).not.toContain('href="/sign-up"');

    const signIn = await renderPath('/sign-in');
    expect(signIn.html).not.toContain('Sign up is closed');
    expect(signIn.html).not.toContain('href="/sign-up"');
  });

  it('keeps sign-up on the managed service', async () => {
    server.routes = { ...managed, '/api/v1/setup': { setupRequired: false } };
    expect((await renderPath('/sign-up')).pathname).toBe('/sign-up');
    expect((await renderPath('/sign-in')).html).toContain('href="/sign-up"');
  });
});

describe('routes in the Mac app local mode (auth: local)', () => {
  const signedIn = () => ({
    ...local,
    '/api/v1/me': localOwner(),
    '/api/v1/setup': { setupRequired: false },
  });

  it('opens the app signed in, with no sign out, account or email anywhere', async () => {
    server.routes = signedIn();
    for (const path of [
      '/',
      '/settings',
      '/settings/general',
      '/settings/models',
      '/settings/limits',
    ]) {
      const { html } = await renderPath(path);
      expect(text(html), path).not.toMatch(/sign out|sign in|account|password/i);
      expect(html, path).not.toContain('owner@openbots.local');
      expect(html, path).not.toContain('href="/settings/account"');
    }
  });

  it('puts General, with the name Bots use, where Account was', async () => {
    server.routes = signedIn();
    expect((await renderPath('/settings')).pathname).toBe('/settings/general');
    expect((await renderPath('/settings/account')).pathname).toBe('/settings/general');
    expect((await renderPath('/settings/admin')).pathname).toBe('/settings/general');
    const { html } = await renderPath('/settings/general');
    expect(html).toMatch(/href="\/settings\/general"[^>]*>General</);
    expect(html).toContain('Your name');
    expect(html).toContain('Bots use it to address you.');
    expect(html).toContain('value="Ada"');
    expect(html).toContain('API keys');
  });

  it('keeps General to local mode and Account to the rest', async () => {
    server.routes = { ...selfHosted, '/api/v1/me': me('owner') };
    expect((await renderPath('/settings/general')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings/account')).html).toContain('Sign out');
  });

  it('shows a line instead of the sign-in and sign-up forms', async () => {
    server.routes = { ...local, '/api/v1/setup': { setupRequired: false } };
    for (const path of ['/sign-in', '/sign-up']) {
      const { pathname, html } = await renderPath(path);
      expect(pathname).toBe(path);
      expect(html).toContain('Open OpenBots from the Mac app');
      expect(html).not.toContain('<form');
      expect(text(html)).not.toMatch(/password|email/i);
    }
  });

  it('sends a signed-out window to /sign-in, where the Mac app signs it in again', async () => {
    // Setup would be required for a signed-out visitor elsewhere; here sign-in is the app's.
    server.routes = { ...local, '/api/v1/setup': { setupRequired: true } };
    for (const path of ['/', '/settings/general', '/setup']) {
      expect((await renderPath(path)).pathname, path).toBe('/sign-in');
    }
  });

  it('takes a signed-in window from /sign-in and /sign-up into the app', async () => {
    server.routes = signedIn();
    expect((await renderPath('/sign-in')).pathname).toBe('/');
    expect((await renderPath('/sign-up')).pathname).toBe('/');
  });

  it('starts the setup wizard at the providers, skipping the account step', async () => {
    server.routes = { ...signedIn(), '/api/v1/setup': { setupRequired: true } };
    for (const path of ['/', '/settings/models', '/setup']) {
      const { pathname, html } = await renderPath(path);
      expect(pathname, path).toBe('/setup');
      expect(html).toContain('Add a model provider');
      expect(text(html)).not.toMatch(/account|password|email/i);
    }
  });
});
