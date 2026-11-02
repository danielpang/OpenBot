import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { meQuery } from '@openbots/web/api';
import type { ActiveMe } from '@openbots/web/extensions';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { invitationQuery, organizationsQuery, type Organization } from './api.js';
import { managedWeb } from './extensions.js';
import { assignableRoles, MemberRow } from './members.js';
import { Onboarding } from './onboarding.js';
import { OrganizationSwitcher } from './switcher.js';

// The managed web app's pieces (plan 21.5), rendered to HTML.

const me = (role: 'owner' | 'admin' | 'member', suspended = false): ActiveMe => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'ada@example.com',
    name: 'Ada',
    image: null,
    emailVerified: true,
    createdAt: '2026-10-14T00:00:00.000Z',
  },
  role,
  workspace: { id: '00000000-0000-4000-8000-0000000000a1', name: 'Acme', suspended },
  limits: {} as ActiveMe['limits'],
});

const org = (id: string, name: string, extra: Partial<Organization> = {}): Organization => ({
  id,
  name,
  slug: name.toLowerCase(),
  role: 'member',
  suspended: false,
  active: false,
  ...extra,
});

function render(node: ReactNode, seed: [readonly unknown[], unknown][] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  for (const [key, data] of seed) queryClient.setQueryData(key, data);
  return renderToString(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');

describe('the managed web app', () => {
  it('gives everyone the Organization tab, and owners and admins Members and Audit log', () => {
    const tabs = (role: 'owner' | 'admin' | 'member') =>
      managedWeb.settingsTabs!.filter((tab) => tab.visible(me(role))).map((tab) => tab.section);
    expect(tabs('member')).toEqual(['organization']);
    expect(tabs('admin')).toEqual(['organization', 'members', 'audit']);
    expect(tabs('owner')).toEqual(['organization', 'members', 'audit']);
  });

  it('shows the switcher only with two or more organizations', () => {
    const one = { items: [org('a', 'Acme', { active: true })] };
    expect(render(<OrganizationSwitcher />, [[organizationsQuery.queryKey, one]])).toBe('');
    const two = { items: [org('a', 'Acme', { active: true }), org('b', 'Beta')] };
    const html = render(<OrganizationSwitcher />, [[organizationsQuery.queryKey, two]]);
    expect(html).toContain('aria-label="Organization"');
    expect(text(html)).toContain('Acme');
  });

  it('asks a new account to create its organization, in one step', () => {
    const nobody = { ...me('member'), role: null, workspace: null, limits: null };
    const html = render(<Onboarding me={nobody} />, [[organizationsQuery.queryKey, { items: [] }]]);
    expect(text(html)).toContain('Create your organization');
    expect(html).toContain('name="name"');
    expect(html.match(/<input/g)).toHaveLength(1);
  });

  it('offers a suspended member their other organizations, and a new one', () => {
    const items = [org('a', 'Acme', { suspended: true, active: true }), org('b', 'Beta')];
    const html = text(
      render(<Onboarding me={me('member', true)} />, [[organizationsQuery.queryKey, { items }]]),
    );
    expect(html).toContain('You are suspended in Acme.');
    expect(html).toContain('Pick an organization');
    expect(html).toContain('Beta');
    expect(html).toContain('Or create a new one.');
  });

  it('joins an invite without the onboarding step', () => {
    const id = '00000000-0000-4000-8000-0000000000c1';
    const html = text(
      render(<Onboarding me={me('member')} invite={id} />, [
        [
          invitationQuery(id).queryKey,
          {
            id,
            organization: 'Acme',
            role: 'admin',
            invitedBy: 'Bob',
            expiresAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      ]),
    );
    expect(html).toContain('Join Acme');
    expect(html).toContain('Bob invited you as an admin.');
    expect(html).not.toContain('Create your organization');
  });

  it("keeps an admin's hands off owners: no Owner choice, and an owner's row is locked", () => {
    expect(assignableRoles('admin')).toEqual(['member', 'admin']);
    expect(assignableRoles('owner')).toEqual(['member', 'admin', 'owner']);
    const owner = {
      id: '00000000-0000-4000-8000-0000000000d1',
      name: 'Olga',
      email: 'olga@example.com',
      role: 'owner' as const,
      createdAt: '2026-10-14T00:00:00.000Z',
      suspendedAt: null,
    };
    const row = (callerRole: 'owner' | 'admin') =>
      render(
        <ul>
          <MemberRow
            member={owner}
            self={false}
            callerRole={callerRole}
            pending={false}
            onChange={() => {}}
            onRemove={() => {}}
          />
        </ul>,
        [[meQuery.queryKey, me(callerRole)]],
      );
    expect(row('admin')).toMatch(/<select[^>]*disabled/);
    expect(text(row('admin'))).not.toContain('Suspend');
    expect(row('owner')).not.toMatch(/<select[^>]*disabled/);
    expect(text(row('owner'))).toContain('Suspend');
  });

  it('carries an invite through a GitHub or Google sign-in', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await managedWeb.beforeSocialSignIn!('00000000-0000-4000-8000-0000000000c1');
      const request = fetch.mock.calls[0]![0] as Request;
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe(
        '/api/v1/invitations/00000000-0000-4000-8000-0000000000c1/oauth',
      );
      // An invitation that is no longer pending carries nothing, and the sign-in goes on.
      fetch.mockResolvedValue(Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
      await expect(managedWeb.beforeSocialSignIn!('x')).resolves.toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses no dashes in its copy', () => {
    const html = [
      render(<Onboarding me={{ ...me('member'), role: null, workspace: null, limits: null }} />, [
        [organizationsQuery.queryKey, { items: [] }],
      ]),
    ].join('');
    expect(html).not.toMatch(/[–—]/);
  });
});
