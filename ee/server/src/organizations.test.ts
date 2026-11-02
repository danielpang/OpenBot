import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@openbots/server/db/client';
import { ORIGIN, createTestApp, type TestApp } from '@openbots/server/test-app';
import { managedExtensions } from './index.js';
import { createAccount, emailTo, mailbox, signUpByEmail, startSignUp } from './testing.js';

// The managed service's organizations end to end (plan 21.6): onboarding,
// invitations with and without email, roles and the owner rules,
// suspension, removal, switching, and the plugin's own HTTP endpoints
// staying closed.

interface Org {
  id: string;
  name: string;
  role: string;
  suspended: boolean;
  active: boolean;
}

const resend = vi.fn<typeof fetch>(async () => Response.json({ id: 'email_1' }));

/** The session cookie a response sets, if any. */
function cookieOf(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.includes('session_token='));
}

async function signIn(t: TestApp, email: string) {
  const res = await t.app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  return { res, cookie: cookieOf(res) };
}

/**
 * Makes an account (sign-up.ts has its own tests), confirms its email and
 * signs in. Returns the sign-up response and the session.
 */
async function join(t: TestApp, email: string, extra: Record<string, unknown> = {}) {
  const res = await createAccount(t, email, extra);
  if (!res.ok) return { res, cookie: undefined };
  await t.db
    .update(schema.users)
    .set({ emailVerified: true })
    .where(eq(schema.users.email, email.toLowerCase()));
  const signedIn = await signIn(t, email);
  expect(signedIn.res.status).toBe(200);
  return { res, cookie: signedIn.cookie };
}

describe('organizations on the managed service', () => {
  let t: TestApp;
  let ada: string;
  let acme: string;

  const call = (cookie: string | undefined, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(status);
    return (await r.json()) as T;
  }

  const code = async (res: Response | Promise<Response>) =>
    ((await (await res).json()) as { code?: string }).code;

  /** Signs up and creates an organization, as onboarding does. */
  async function founder(email: string, org: string) {
    const { cookie } = await join(t, email);
    const created = await json<Org>(call(cookie, 'POST', '/organizations', { name: org }), 201);
    return { cookie: cookie!, org: created.id };
  }

  /** Invites `email` into the inviter's active organization and signs them up through the link. */
  async function invite(inviter: string, email: string, role = 'member') {
    const invitation = await json<{ id: string; link: string }>(
      call(inviter, 'POST', '/organization/invitations', { email, role }),
      201,
    );
    const { res, cookie } = await join(t, email);
    expect(res.status).toBe(200);
    await json(call(cookie, 'POST', `/invitations/${invitation.id}/accept`));
    return { cookie: cookie!, id: await t.userId(email), invitation: invitation.id };
  }

  beforeAll(async () => {
    t = await createTestApp(
      { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' },
      {
        extensions: managedExtensions({
          email: { apiKey: 're_test', from: 'OpenBots <hi@example.com>', fetch: resend },
        }),
      },
    );
    ({ cookie: ada, org: acme } = await founder('ada@example.com', 'Acme'));
  });
  afterAll(() => t.close());

  it('starts a new account with no organization, until it creates one as its owner', async () => {
    const { cookie } = await join(t, 'new@example.com');
    expect(await json(call(cookie, 'GET', '/me'))).toMatchObject({ workspace: null, role: null });
    expect(await json(call(cookie, 'GET', '/organizations'))).toEqual({ items: [] });
    expect((await call(cookie, 'GET', '/bots')).status).toBe(403);

    const created = await json<Org>(
      call(cookie, 'POST', '/organizations', { name: 'Fresh Co' }),
      201,
    );
    expect(created).toMatchObject({ name: 'Fresh Co', role: 'owner', active: true });
    expect(await json(call(cookie, 'GET', '/me'))).toMatchObject({
      role: 'owner',
      workspace: { id: created.id, name: 'Fresh Co' },
    });
    expect((await call(cookie, 'GET', '/bots')).status).toBe(200);
    const [row] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, created.id));
    expect(row).toMatchObject({ workspaceId: created.id, action: 'organization.create' });
  });

  it('invites by email through Resend, and the link joins the invitee without the onboarding step', async () => {
    resend.mockClear();
    const res = await json<{ id: string; link: string; emailed: boolean }>(
      call(ada, 'POST', '/organization/invitations', { email: 'Bea@Example.com' }),
      201,
    );
    expect(res).toMatchObject({
      email: 'bea@example.com',
      role: 'member',
      emailed: true,
      link: `${ORIGIN}/sign-up?invite=${res.id}`,
    });
    expect(resend).toHaveBeenCalledTimes(1);
    const [url, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: 'OpenBots <hi@example.com>',
      to: ['bea@example.com'],
      subject: 'Join Acme on OpenBots',
    });
    expect(String(sent.text)).toContain(res.link);
    expect(String(sent.text)).not.toMatch(/[–—]/);

    const { cookie } = await join(t, 'bea@example.com');
    // The recipient sees it; it names its organization.
    expect(await json(call(cookie, 'GET', `/invitations/${res.id}`))).toMatchObject({
      organization: 'Acme',
      role: 'member',
    });
    expect(await json(call(cookie, 'POST', `/invitations/${res.id}/accept`))).toEqual({
      organizationId: acme,
    });
    expect(await json(call(cookie, 'GET', '/me'))).toMatchObject({
      role: 'member',
      workspace: { id: acme },
    });
    // Spent: a second accept, or anyone else, finds nothing.
    expect((await call(cookie, 'POST', `/invitations/${res.id}/accept`)).status).toBe(404);
  });

  it('keeps an invitation to its address, its expiry and its organization', async () => {
    const res = await json<{ id: string }>(
      call(ada, 'POST', '/organization/invitations', { email: 'cy@example.com' }),
      201,
    );
    const { cookie: eve } = await join(t, 'eve@example.com');
    expect((await call(eve, 'GET', `/invitations/${res.id}`)).status).toBe(404);
    expect((await call(eve, 'POST', `/invitations/${res.id}/accept`)).status).toBe(404);

    const { cookie: cy } = await join(t, 'cy@example.com');
    await t.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invites.id, res.id));
    expect((await call(cy, 'POST', `/invitations/${res.id}/accept`)).status).toBe(404);

    // Revoked, a new one's link stops working too.
    const again = await json<{ id: string }>(
      call(ada, 'POST', '/organization/invitations', { email: 'cy@example.com' }),
      201,
    );
    expect((await call(ada, 'DELETE', `/organization/invitations/${again.id}`)).status).toBe(204);
    expect((await call(cy, 'POST', `/invitations/${again.id}/accept`)).status).toBe(404);
    // An invitation of another organization cannot be revoked from this one.
    const other = await founder('olga@example.com', 'Other Org');
    const theirs = await json<{ id: string }>(
      call(other.cookie, 'POST', '/organization/invitations', { email: 'pat@example.com' }),
      201,
    );
    expect((await call(ada, 'DELETE', `/organization/invitations/${theirs.id}`)).status).toBe(404);
    const pending = await json<{ items: { id: string }[] }>(
      call(ada, 'GET', '/organization/invitations'),
    );
    expect(pending.items.map((i) => i.id)).not.toContain(theirs.id);
  });

  it('works as copyable links when the server cannot send email', async () => {
    const plain = await createTestApp(
      { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' },
      { extensions: managedExtensions() },
    );
    try {
      const { cookie } = await join(plain, 'owner@example.com');
      const request = (path: string, body?: unknown) =>
        plain.app.request(`/api/v1${path}`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie: cookie!, 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      expect((await request('/organizations', { name: 'Plain' })).status).toBe(201);
      const res = await request('/organization/invitations', { email: 'link@example.com' });
      expect(await res.json()).toMatchObject({
        emailed: false,
        link: expect.stringContaining('/sign-up?invite='),
      });
    } finally {
      await plain.close();
    }
  });

  it('lets owners and admins manage members, and only owners touch owners', async () => {
    const admin = await invite(ada, 'ann@example.com', 'admin');
    const member = await invite(ada, 'max@example.com');
    const adaId = await t.userId('ada@example.com');
    // A member manages nothing.
    expect((await call(member.cookie, 'GET', '/organization/members')).status).toBe(403);
    expect(
      (await call(member.cookie, 'POST', '/organization/invitations', { email: 'x@example.com' }))
        .status,
    ).toBe(403);
    // Admins invite, change roles and suspend members.
    expect(
      await json(
        call(admin.cookie, 'PATCH', `/organization/members/${member.id}`, { role: 'admin' }),
      ),
    ).toMatchObject({ role: 'admin' });
    await json(
      call(admin.cookie, 'PATCH', `/organization/members/${member.id}`, { role: 'member' }),
    );
    // But not make an owner, invite one, make themselves one, or touch the owner.
    for (const [path, body] of [
      [`/organization/members/${member.id}`, { role: 'owner' }],
      [`/organization/members/${admin.id}`, { role: 'owner' }],
      [`/organization/members/${adaId}`, { role: 'member' }],
      [`/organization/members/${adaId}`, { suspended: true }],
    ] as const) {
      expect((await call(admin.cookie, 'PATCH', path, body)).status, path).toBe(403);
    }
    expect((await call(admin.cookie, 'DELETE', `/organization/members/${adaId}`)).status).toBe(403);
    expect(
      (
        await call(admin.cookie, 'POST', '/organization/invitations', {
          email: 'boss@example.com',
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    // An owner makes owners.
    expect(
      await json(call(ada, 'PATCH', `/organization/members/${admin.id}`, { role: 'owner' })),
    ).toMatchObject({ role: 'owner' });
    await json(call(ada, 'PATCH', `/organization/members/${admin.id}`, { role: 'admin' }));
    const roles = await t.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'member.role'));
    expect(roles.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps an owner: the last one cannot be demoted, suspended, removed or leave', async () => {
    const adaId = await t.userId('ada@example.com');
    expect(
      await code(call(ada, 'PATCH', `/organization/members/${adaId}`, { role: 'admin' })),
    ).toBe('LAST_OWNER');
    expect(await code(call(ada, 'POST', '/organization/leave'))).toBe('LAST_OWNER');
    expect(
      await code(call(ada, 'PATCH', `/organization/members/${adaId}`, { suspended: true })),
    ).toBe('CANNOT_SUSPEND_SELF');
    expect(await code(call(ada, 'DELETE', `/organization/members/${adaId}`))).toBe(
      'CANNOT_REMOVE_SELF',
    );
    // With a second owner, the first may step down.
    const co = await invite(ada, 'co@example.com', 'owner');
    expect(
      await json(call(ada, 'PATCH', `/organization/members/${adaId}`, { role: 'admin' })),
    ).toMatchObject({ role: 'admin' });
    // Now Co is the last owner, and an admin cannot remove or suspend them.
    expect((await call(ada, 'DELETE', `/organization/members/${co.id}`)).status).toBe(403);
    await json(call(co.cookie, 'PATCH', `/organization/members/${adaId}`, { role: 'owner' }));
  });

  it('suspends a member in one organization only, their sessions and keys too', async () => {
    const sam = await invite(ada, 'sam@example.com');
    const key = await json<{ key: string }>(
      call(sam.cookie, 'POST', '/api-keys', { name: 'sam' }),
      201,
    );
    const own = await json<Org>(
      call(sam.cookie, 'POST', '/organizations', { name: 'Sam Co' }),
      201,
    );
    // Back to Acme, then suspended there.
    expect((await call(sam.cookie, 'POST', `/organizations/${acme}/activate`)).status).toBe(204);
    await json(call(ada, 'PATCH', `/organization/members/${sam.id}`, { suspended: true }));
    const both: Record<string, string>[] = [
      { cookie: sam.cookie },
      { authorization: `Bearer ${key.key}` },
    ];
    for (const headers of both) {
      const res = await t.app.request('/api/v1/bots', { headers: { origin: ORIGIN, ...headers } });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('MEMBER_SUSPENDED');
    }
    // They cannot switch back in, but their own organization works.
    expect(await code(call(sam.cookie, 'POST', `/organizations/${acme}/activate`))).toBe(
      'MEMBER_SUSPENDED',
    );
    expect((await call(sam.cookie, 'POST', `/organizations/${own.id}/activate`)).status).toBe(204);
    expect((await call(sam.cookie, 'GET', '/bots')).status).toBe(200);
    const listed = await json<{ items: Org[] }>(call(sam.cookie, 'GET', '/organizations'));
    expect(listed.items.find((o) => o.id === acme)).toMatchObject({ suspended: true });
    // Restored, they are back in Acme.
    await json(call(ada, 'PATCH', `/organization/members/${sam.id}`, { suspended: false }));
    expect((await call(sam.cookie, 'POST', `/organizations/${acme}/activate`)).status).toBe(204);
    expect((await call(sam.cookie, 'GET', '/bots')).status).toBe(200);
  });

  it("removes a member: their session's organization ends and their data stays out of reach", async () => {
    const rex = await invite(ada, 'rex@example.com');
    const bot = await json<{ id: string }>(
      call(rex.cookie, 'POST', '/bots', { name: 'Rex Bot', modelConfig: null }),
      201,
    );
    expect((await call(ada, 'DELETE', `/organization/members/${rex.id}`)).status).toBe(204);
    expect(await json(call(rex.cookie, 'GET', '/me'))).toMatchObject({ workspace: null });
    expect((await call(rex.cookie, 'GET', `/bots/${bot.id}`)).status).toBe(403);
    // The owner never sees a member's Bot, removed or not (U2).
    expect((await call(ada, 'GET', `/bots/${bot.id}`)).status).toBe(404);
    expect((await call(rex.cookie, 'POST', `/organizations/${acme}/activate`)).status).toBe(404);
    const [stays] = await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
    expect(stays).toBeDefined();
  });

  it('refuses an organization the caller is not in, and switching with an API key', async () => {
    const outsider = await founder('out@example.com', 'Outside');
    expect((await call(outsider.cookie, 'POST', `/organizations/${acme}/activate`)).status).toBe(
      404,
    );
    const key = await json<{ key: string }>(
      call(outsider.cookie, 'POST', '/api-keys', { name: 'k' }),
      201,
    );
    const viaKey = await t.app.request(`/api/v1/organizations/${outsider.org}/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}` },
    });
    expect(await code(viaKey)).toBe('SESSION_REQUIRED');
  });

  it("keeps better-auth's organization endpoints off HTTP", async () => {
    for (const path of [
      '/organization/create',
      '/organization/set-active',
      '/organization/update-member-role',
      '/organization/invite-member',
      '/organization/accept-invitation',
      '/organization/list',
    ]) {
      const res = await t.app.request(`/api/auth${path}`, {
        method: path === '/organization/list' ? 'GET' : 'POST',
        headers: { origin: ORIGIN, cookie: ada, 'content-type': 'application/json' },
        body: path === '/organization/list' ? undefined : JSON.stringify({ name: 'X', slug: 'x' }),
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("reads the organization's audit log, for owners and admins only", async () => {
    const page = await json<{ items: { action: string; actorLabel: string | null }[] }>(
      call(ada, 'GET', '/organization/audit?action=member.&limit=200'),
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.action.startsWith('member.'))).toBe(true);
    const outsider = await founder('auditor@example.com', 'Audit Co');
    const theirs = await json<{ items: { action: string }[] }>(
      call(outsider.cookie, 'GET', '/organization/audit?limit=200'),
    );
    expect(theirs.items.some((e) => e.action.startsWith('member.'))).toBe(false);
    const member = await invite(ada, 'reader@example.com');
    expect((await call(member.cookie, 'GET', '/organization/audit')).status).toBe(403);
    expect((await call(undefined, 'GET', '/organization/audit')).status).toBe(401);
    expect((await call(ada, 'GET', '/organization/audit?from=yesterday')).status).toBe(400);
  });

  it('caps invitations an organization sends an hour', async () => {
    const busy = await founder('busy@example.com', 'Busy');
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (
        await call(busy.cookie, 'POST', '/organization/invitations', {
          email: `guest${i}@example.com`,
        })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe('sign-up by invitation only', () => {
  let t: TestApp;
  const mail = mailbox();
  beforeAll(async () => {
    t = await createTestApp(
      { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'invite' },
      { extensions: managedExtensions({ email: emailTo(mail) }) },
    );
  });
  afterAll(() => t.close());

  it('lets the first user in, then only addresses with a pending invitation', async () => {
    const first = await join(t, 'first@example.com');
    expect(first.res.status).toBe(200);
    const stranger = await startSignUp(t, 'stranger@example.com');
    expect(stranger.res.status).toBe(400);
    expect(await stranger.res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
    const post = (path: string, body: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: first.cookie!, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/organizations', { name: 'Private' })).status).toBe(201);
    const invited = (await (
      await post('/organization/invitations', { email: 'friend@example.com' })
    ).json()) as { id: string };
    // Knowing the invited address is not enough: the link's invite must come too.
    const without = await startSignUp(t, 'friend@example.com');
    expect(without.res.status).toBe(400);
    expect(await without.res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
    const other = (await (
      await post('/organization/invitations', { email: 'other@example.com' })
    ).json()) as { id: string };
    expect((await startSignUp(t, 'friend@example.com', other.id)).res.status).toBe(400);
    expect((await startSignUp(t, 'friend@example.com', 'not-an-id')).res.status).toBe(400);
    // A server call is held to the same policy.
    expect((await createAccount(t, 'friend@example.com', { invite: other.id })).status).toBe(400);
    // An expired one proves nothing.
    await t.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invites.id, invited.id));
    expect((await startSignUp(t, 'friend@example.com', invited.id)).res.status).toBe(400);
    await t.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.invites.id, invited.id));
    const friend = await signUpByEmail(t, mail, 'friend@example.com', { invite: invited.id });
    expect(friend.res.status).toBe(200);
    // Accepted once: it joins them, and the link proves nothing afterwards.
    const accept = await t.app.request(`/api/v1/invitations/${invited.id}/accept`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: friend.cookie! },
    });
    expect(accept.status).toBe(200);
    const again = await t.app.request(`/api/v1/invitations/${invited.id}/accept`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: friend.cookie! },
    });
    expect(again.status).toBe(404);
  });

  it('signs a returning member in to the organization they joined last', async () => {
    const { cookie } = await signIn(t, 'first@example.com');
    const me = await t.app.request('/api/v1/me', { headers: { cookie: cookie! } });
    expect(await me.json()).toMatchObject({ role: 'owner', workspace: { name: 'Private' } });
  });
});
