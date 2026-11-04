import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@openbots/server/db/client';
import { createTestApp, type TestApp } from '@openbots/server/test-app';
import { emailFromEnv, managedExtensions } from './index.js';
import { readInviteCookie, signInviteCookie } from './plugin.js';
import {
  CODE_TRIES,
  SENDS_PER_DAY,
  SENDS_PER_HOUR,
  STARTS_PER_IP,
  TRIES_PER_IP,
} from './sign-up.js';
import {
  PASSWORD,
  completeSignUp,
  cookieOf,
  createAccount,
  emailTo,
  mailbox,
  post,
  sessionOf,
  signIn,
  signUpByEmail,
  startSignUp,
  verifyCode,
} from './testing.js';

// Email sign-up on the managed service (plan 21.6, sign-up.ts): the email
// first, confirmed with a code bound to its request, then the name and
// password. Nothing an unauthenticated request does deletes or replaces an
// account; limits come before work; codes stay out of logs. And a GitHub
// sign-up from an invite link carries the invite in a signed cookie.

function managedApp(email = {}, env: Record<string, string> = {}) {
  return createTestApp(
    { OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open', ...env },
    { extensions: managedExtensions({ email }) },
  );
}

const userRows = (t: TestApp, email: string) =>
  t.db.select().from(schema.users).where(eq(schema.users.email, email));

const pendingRows = (t: TestApp) =>
  t.db
    .select()
    .from(schema.verifications)
    .where(like(schema.verifications.identifier, 'sign-up:%'));

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('email sign-up', () => {
  let t: TestApp;
  const mail = mailbox();

  beforeAll(async () => {
    t = await managedApp(emailTo(mail));
  });
  afterAll(() => t.close());

  it('takes the email, then the code, then the name and password', async () => {
    const start = await startSignUp(t, 'vera@example.com');
    expect(start.res.status).toBe(200);
    expect(start.request).toBeDefined();
    const header = start.res.headers.getSetCookie().find((c) => c.startsWith('openbots_sign_up='))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    // No account and no password yet.
    expect(await userRows(t, 'vera@example.com')).toEqual([]);
    const code = mail.code('vera@example.com')!;
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.sent.at(-1)!.subject).toBe(`${code} is your OpenBots code`);
    expect(mail.sent.at(-1)!.text).not.toMatch(/https?:\/\//);
    // The code is stored as an HMAC, not as itself.
    expect(JSON.stringify(await pendingRows(t))).not.toContain(code);

    // Credentials before the code are refused.
    const early = await completeSignUp(t, start.request);
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    expect((await verifyCode(t, start.request, code)).status).toBe(200);
    const done = await completeSignUp(t, start.request, { name: 'Vera' });
    expect(done.status).toBe(200);
    const me = await t.app.request('/api/v1/me', { headers: { cookie: sessionOf(done)! } });
    expect(await me.json()).toMatchObject({
      user: { name: 'Vera', emailVerified: true },
      workspace: null,
    });
    expect((await signIn(t, 'vera@example.com')).status).toBe(200);
    // Once: the request is spent.
    expect((await completeSignUp(t, start.request)).status).toBe(400);
    expect((await verifyCode(t, start.request, code)).status).toBe(400);
  });

  it('lets no second sign-up set a credential the inbox owner then confirms', async () => {
    const victim = await startSignUp(t, 'pat@example.com');
    const victimCode = mail.code('pat@example.com')!;
    const attacker = await startSignUp(t, 'pat@example.com');
    expect(attacker.res.status).toBe(200);
    const attackerCode = mail.code('pat@example.com')!;
    expect(await userRows(t, 'pat@example.com')).toEqual([]);
    // The newest email is the attacker's request: its code does not complete the victim's.
    if (attackerCode !== victimCode) {
      const crossed = await verifyCode(t, victim.request, attackerCode);
      expect(crossed.status).toBe(400);
      expect(await crossed.json()).toMatchObject({ code: 'INVALID_OTP' });
    }
    // Nor can the attacker finish theirs without the code from the inbox.
    expect((await completeSignUp(t, attacker.request, { password: 'attacker pass' })).status).toBe(
      400,
    );
    expect((await verifyCode(t, victim.request, victimCode)).status).toBe(200);
    const done = await completeSignUp(t, victim.request, { name: 'Pat' });
    expect(done.status).toBe(200);
    expect((await signIn(t, 'pat@example.com', 'attacker pass')).status).toBe(401);
    expect((await signIn(t, 'pat@example.com')).status).toBe(200);
  });

  it('deletes and replaces nothing for an unauthenticated request', async () => {
    // An unconfirmed account from before this flow, and a confirmed one.
    await createAccount(t, 'old@example.com', { password: 'old password' });
    await signUpByEmail(t, mail, 'kept@example.com', { name: 'Kept' });
    const before = [
      ...(await userRows(t, 'old@example.com')),
      ...(await userRows(t, 'kept@example.com')),
    ];
    const credentials = await t.db.select().from(schema.accounts);
    for (const address of ['old@example.com', 'kept@example.com']) {
      expect((await startSignUp(t, address)).res.status).toBe(200);
    }
    const after = [
      ...(await userRows(t, 'old@example.com')),
      ...(await userRows(t, 'kept@example.com')),
    ];
    expect(after).toEqual(before);
    expect(await t.db.select().from(schema.accounts)).toEqual(credentials);
  });

  it('deletes a leftover unconfirmed account with everything tied to it, once the code is in', async () => {
    await createAccount(t, 'legacy@example.com', { name: 'Squatter', password: 'squatter pass' });
    const [old] = await userRows(t, 'legacy@example.com');
    // What someone may have tied to it: a GitHub identity, a session, a
    // membership and an invitation they sent.
    const org = await t.createOrganization('Squat Co');
    await t.addMember(old!.id, org);
    await t.db.insert(schema.accounts).values({
      userId: old!.id,
      providerId: 'github',
      accountId: 'gh-squatter',
    });
    await t.db.insert(schema.sessions).values({
      userId: old!.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await t.db.insert(schema.invites).values({
      workspaceId: org,
      email: 'friend@example.com',
      inviterId: old!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // Unusable until confirmed.
    const early = await signIn(t, 'legacy@example.com', 'squatter pass');
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    // Starting a sign-up changes nothing; confirming it replaces the account.
    const start = await startSignUp(t, 'legacy@example.com');
    expect(await userRows(t, 'legacy@example.com')).toEqual([old]);
    expect((await verifyCode(t, start.request, mail.code('legacy@example.com')!)).status).toBe(200);
    const done = await completeSignUp(t, start.request, { name: 'Lee' });
    expect(done.status).toBe(200);
    const [now] = await userRows(t, 'legacy@example.com');
    expect(now).toMatchObject({ name: 'Lee', emailVerified: true });
    expect(now!.id).not.toBe(old!.id);
    for (const table of [schema.accounts, schema.sessions] as const) {
      expect(await t.db.select().from(table).where(eq(table.userId, old!.id))).toEqual([]);
    }
    expect(
      await t.db
        .select()
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, old!.id)),
    ).toEqual([]);
    expect(
      await t.db.select().from(schema.invites).where(eq(schema.invites.inviterId, old!.id)),
    ).toEqual([]);
    expect((await signIn(t, 'legacy@example.com', 'squatter pass')).status).toBe(401);
    expect((await signIn(t, 'legacy@example.com')).status).toBe(200);
  });

  it('tells an existing account by email, and answers the same', async () => {
    const fresh = await startSignUp(t, 'nobody@example.com');
    const taken = await startSignUp(t, 'vera@example.com');
    expect(taken.res.status).toBe(fresh.res.status);
    expect(await taken.res.json()).toEqual(await fresh.res.json());
    expect(taken.request).toBeDefined();
    const notice = mail.sent.at(-1)!;
    expect(notice).toMatchObject({
      to: 'vera@example.com',
      subject: 'Someone tried to sign up with your email',
    });
    expect(notice.text).not.toMatch(/\d{6}/);
    // No code completes it.
    const res = await verifyCode(t, taken.request, '123456');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_OTP' });
  });

  it('expires a code after 10 minutes', async () => {
    const start = await startSignUp(t, 'exp@example.com');
    await t.db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(schema.verifications.identifier, 'sign-up:%'));
    const res = await verifyCode(t, start.request, mail.code('exp@example.com')!);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('checks the send limit before making or sending anything', async () => {
    for (let i = 0; i < SENDS_PER_HOUR; i++) {
      expect((await startSignUp(t, 'busy@example.com')).res.status).toBe(200);
    }
    const rows = (await pendingRows(t)).length;
    const sent = mail.sent.length;
    const over = await startSignUp(t, 'busy@example.com');
    expect(over.res.status).toBe(429);
    expect(await over.res.json()).toMatchObject({ code: 'TOO_MANY_CODES' });
    expect(Number(over.res.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect((await pendingRows(t)).length).toBe(rows);
    expect(mail.sent.length).toBe(sent);
  });

  it('kills a code after 5 tries', async () => {
    const start = await startSignUp(t, 'guess@example.com');
    const code = mail.code('guess@example.com')!;
    for (let i = 1; i < CODE_TRIES; i++) {
      const res = await verifyCode(t, start.request, wrong(code));
      expect(await res.json()).toMatchObject({ code: 'INVALID_OTP' });
    }
    const last = await verifyCode(t, start.request, wrong(code));
    expect(await last.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    // Dead: the right code no longer works, and a new one does.
    const late = await verifyCode(t, start.request, code);
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    const again = await startSignUp(t, 'guess@example.com');
    expect((await verifyCode(t, again.request, mail.code('guess@example.com')!)).status).toBe(200);
  });

  it("lets nobody spend another request's tries", async () => {
    const victim = await startSignUp(t, 'kim@example.com');
    const victimCode = mail.code('kim@example.com')!;
    const attacker = await startSignUp(t, 'kim@example.com');
    for (let i = 0; i < CODE_TRIES + 2; i++) {
      await verifyCode(t, attacker.request, wrong(victimCode));
    }
    expect((await verifyCode(t, victim.request, victimCode)).status).toBe(200);
  });

  it('needs the request a code was sent for', async () => {
    await startSignUp(t, 'bound@example.com');
    const res = await verifyCode(t, undefined, mail.code('bound@example.com')!);
    expect(res.status).toBe(400);
    const forged = await verifyCode(t, 'openbots_sign_up=forged', mail.code('bound@example.com')!);
    expect(forged.status).toBe(400);
  });

  it('refuses an address after 15 failed tries in an hour, and never counts a right code', async () => {
    // 14 failures across codes, then the right code: fine.
    const tryWrong = async (address: string, times: number) => {
      const start = await startSignUp(t, address);
      for (let i = 0; i < times; i++) {
        await verifyCode(t, start.request, wrong(mail.code(address)!));
      }
    };
    for (const n of [5, 5, 4]) await tryWrong('near@example.com', n);
    const near = await startSignUp(t, 'near@example.com');
    expect((await verifyCode(t, near.request, mail.code('near@example.com')!)).status).toBe(200);

    // 15: even a new, right code is refused until the hour clears.
    for (const n of [5, 5, 5]) await tryWrong('over@example.com', n);
    const over = await startSignUp(t, 'over@example.com');
    const locked = await verifyCode(t, over.request, mail.code('over@example.com')!);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: 'TOO_MANY_FAILURES' });
    expect(Number(locked.headers.get('x-retry-after'))).toBeGreaterThan(3000);
    await t.db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(schema.verifications.identifier, 'sign-up-fail:%'));
    expect((await verifyCode(t, over.request, mail.code('over@example.com')!)).status).toBe(200);
  });

  it('sends one address at most 20 codes a day', async () => {
    const consume = t.deps.infra.limiter.consume.bind(t.deps.infra.limiter);
    // As if the hours went by: only the daily cap is left.
    const spy = vi
      .spyOn(t.deps.infra.limiter, 'consume')
      .mockImplementation((key, rule) =>
        key.startsWith('sign-up-send:')
          ? Promise.resolve({ allowed: true, retryAfter: null })
          : consume(key, rule),
      );
    try {
      for (let i = 0; i < SENDS_PER_DAY; i++) {
        expect((await startSignUp(t, 'daily@example.com')).res.status).toBe(200);
      }
      const over = await startSignUp(t, 'daily@example.com');
      expect(over.res.status).toBe(429);
      expect(await over.res.json()).toMatchObject({ code: 'TOO_MANY_CODES' });
    } finally {
      spy.mockRestore();
    }
  });

  // About 70 sign-up requests: slow on a busy machine.
  it('limits sign-ups and tries per IP', async () => {
    const app = await managedApp(emailTo(mail));
    try {
      const fromIp = (ip: string, path: string, body: unknown, cookie?: string) =>
        app.app.request(
          path,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost:3000',
              ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify(body),
          },
          { incoming: { socket: { remoteAddress: ip } } },
        );
      for (let i = 0; i < STARTS_PER_IP; i++) {
        const res = await fromIp('203.0.113.7', '/api/auth/sign-up/start', {
          email: `ip${i}@example.com`,
        });
        expect(res.status).toBe(200);
      }
      const over = await fromIp('203.0.113.7', '/api/auth/sign-up/start', {
        email: 'one-more@example.com',
      });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('x-retry-after'))).toBeGreaterThan(0);
      const other = await fromIp('203.0.113.8', '/api/auth/sign-up/start', {
        email: 'elsewhere@example.com',
      });
      expect(other.status).toBe(200);

      // Tries, across requests.
      let statuses: number[] = [];
      for (let i = 0; i < TRIES_PER_IP + 1; i++) {
        const start = await fromIp(`10.1.${i}.1`, '/api/auth/sign-up/start', {
          email: `try${i}@example.com`,
        });
        const request = cookieOf(start, 'openbots_sign_up');
        const res = await fromIp(
          '198.51.100.1',
          '/api/auth/sign-up/verify',
          { code: '000000' },
          request,
        );
        statuses = [...statuses, res.status];
      }
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.slice(0, TRIES_PER_IP).every((s) => s === 400)).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("serves none of better-auth's own email sign-up or verification links", async () => {
    for (const [path, body] of [
      ['/api/auth/sign-up/email', { name: 'X', email: 'x@example.com', password: PASSWORD }],
      ['/api/auth/send-verification-email', { email: 'x@example.com' }],
    ] as const) {
      expect((await post(t, path, body)).status, path).toBe(404);
    }
    const link = await t.app.request('/api/auth/verify-email?token=x');
    expect(link.status).toBe(404);
    expect(await userRows(t, 'x@example.com')).toEqual([]);
  });
});

// These tests build their apps in the test, not in a hook, so each gets the
// hooks' 30 seconds (vitest.config.ts): a test app is a fresh database, and two
// of them outlast the default 5 seconds on a busy runner.
describe('sign-up codes in the logs', () => {
  it('logs a code only on a development server that asked for it', async () => {
    for (const logLinks of [false, true]) {
      const app = await managedApp(logLinks ? { logLinks } : {});
      try {
        const info = vi.spyOn(app.deps.logger, 'info');
        await startSignUp(app, 'quiet@example.com');
        const logged = info.mock.calls.find(([, message]) => message === 'email verification code');
        expect(Boolean(logged), String(logLinks)).toBe(logLinks);
        if (logged) expect((logged[0] as { code: string }).code).toMatch(/^\d{6}$/);
      } finally {
        await app.close();
      }
    }
    expect(() =>
      emailFromEnv({ OPENBOTS_DEV_LOG_EMAIL_LINKS: '1', NODE_ENV: 'production' }),
    ).toThrow(/OPENBOTS_DEV_LOG_EMAIL_LINKS/);
  }, 30_000);

  it('logs no code or invitation id when sending fails', async () => {
    const sentBodies: string[] = [];
    const failing = vi.fn<typeof fetch>(async (_url, init) => {
      sentBodies.push(String(init?.body));
      return new Response('down', { status: 503 });
    });
    const app = await managedApp({
      apiKey: 're_test',
      from: 'OpenBots <hi@example.com>',
      fetch: failing,
    });
    const calls: unknown[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(app.deps.logger, level).mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);
    }
    try {
      await startSignUp(app, 'lost@example.com');
      const code = sentBodies.join('').match(/\b(\d{6})\b/)?.[1];
      expect(code).toBeDefined();
      await createAccount(app, 'owner@example.com');
      await app.db
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.email, 'owner@example.com'));
      const session = sessionOf(await signIn(app, 'owner@example.com'))!;
      await post(app, '/api/v1/organizations', { name: 'Quiet Co' }, session);
      const invite = (await (
        await post(app, '/api/v1/organization/invitations', { email: 'guest@example.com' }, session)
      ).json()) as { id: string; emailed: boolean };
      expect(invite.emailed).toBe(false);
      await app.app.request(`/api/v1/invitations/${invite.id}`, { headers: { cookie: session } });
      const logged = JSON.stringify(calls);
      expect(logged).toContain('verification email failed');
      expect(logged).toContain('invite email failed');
      expect(logged).not.toContain(code!);
      expect(logged).not.toContain(invite.id);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe('a GitHub sign-up from an invite link', () => {
  let t: TestApp;
  let ownerCookie: string;
  let workspaceId: string;
  const realFetch = globalThis.fetch;
  let github: { email: string; verified: boolean } = { email: '', verified: true };

  beforeAll(async () => {
    t = await createTestApp(
      {
        OPENBOTS_DEPLOYMENT: 'managed',
        OPENBOTS_SIGNUP_MODE: 'invite',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
      },
      { extensions: managedExtensions() },
    );
    // GitHub, as better-auth calls it.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({
          access_token: 'gh-token',
          token_type: 'bearer',
          scope: 'user:email',
        });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 4242,
          login: 'gina',
          name: 'Gina',
          email: github.email,
          avatar_url: null,
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([{ email: github.email, primary: true, verified: github.verified }]);
      }
      return realFetch(input, init);
    });
    await createAccount(t, 'owner@example.com');
    await t.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, 'owner@example.com'));
    ownerCookie = sessionOf(await signIn(t, 'owner@example.com'))!;
    const org = (await (
      await post(t, '/api/v1/organizations', { name: 'Invited Co' }, ownerCookie)
    ).json()) as { id: string };
    workspaceId = org.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  /** Starts a GitHub sign-up, with the invite cookie when given, and finishes the callback. */
  async function githubSignUp(inviteCookie?: string) {
    const start = await post(t, '/api/auth/sign-in/social', {
      provider: 'github',
      callbackURL: '/',
    });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const cookies = start.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .concat(inviteCookie ? [inviteCookie] : []);
    return t.app.request(`/api/auth/callback/github?code=gh-code&state=${state}`, {
      headers: { cookie: cookies.join('; ') },
    });
  }

  const invite = async (email: string) =>
    (
      (await (
        await post(t, '/api/v1/organization/invitations', { email }, ownerCookie)
      ).json()) as { id: string }
    ).id;

  /** The cookie POST /invitations/{id}/oauth sets. */
  async function inviteCookieFor(id: string) {
    const res = await post(t, `/api/v1/invitations/${id}/oauth`, {});
    expect(res.status).toBe(204);
    const header = res.headers.getSetCookie().find((c) => c.startsWith('openbots_oauth_invite='))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Max-Age=600/);
    return header.split(';')[0]!;
  }

  it('joins the invited organization once, when the verified address is the invited one', async () => {
    github = { email: 'gina@example.com', verified: true };
    const id = await invite('gina@example.com');
    const cookie = await inviteCookieFor(id);
    const done = await githubSignUp(cookie);
    expect(done.status).toBe(302);
    // The invite never rides in the OAuth state.
    expect(done.headers.get('location') ?? '').not.toContain(id);
    const [user] = await t.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'gina@example.com'));
    const members = await t.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user!.id));
    expect(members.map((m) => [m.workspaceId, m.role])).toEqual([[workspaceId, 'member']]);
    const [row] = await t.db.select().from(schema.invites).where(eq(schema.invites.id, id));
    expect(row!.status).toBe('accepted');
    // The session works there now.
    const me = await t.app.request('/api/v1/me', { headers: { cookie: sessionOf(done)! } });
    expect(await me.json()).toMatchObject({ workspace: { id: workspaceId } });
    // The cookie is cleared.
    expect(
      done.headers.getSetCookie().some((c) => /^openbots_oauth_invite=;|Max-Age=0/.test(c)),
    ).toBe(true);
  });

  it('refuses a sign-up whose provider address is another, unverified, or has no invite', async () => {
    const id = await invite('hal@example.com');
    const cookie = await inviteCookieFor(id);
    for (const account of [
      { email: 'mallory@example.com', verified: true },
      { email: 'hal@example.com', verified: false },
    ]) {
      github = account;
      await githubSignUp(cookie);
      const users = await t.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, account.email));
      expect(users, account.email).toEqual([]);
    }
    github = { email: 'hal@example.com', verified: true };
    await githubSignUp();
    expect(
      await t.db.select().from(schema.users).where(eq(schema.users.email, 'hal@example.com')),
    ).toEqual([]);
    const [row] = await t.db.select().from(schema.invites).where(eq(schema.invites.id, id));
    expect(row!.status).toBe('pending');
  });

  it('counts only sign-ups that pass the policy against the address', async () => {
    for (let i = 0; i < SENDS_PER_HOUR + 2; i++) {
      const refused = await startSignUp(t, 'outsider@example.com');
      expect(refused.res.status).toBe(400);
      expect(await refused.res.json()).toMatchObject({ code: 'INVITE_REQUIRED' });
    }
    const id = await invite('outsider@example.com');
    expect((await startSignUp(t, 'outsider@example.com', id)).res.status).toBe(200);
  });

  it('signs its cookie and keeps it for 10 minutes', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const value = signInviteCookie(t.deps.config, id, 1_000);
    expect(readInviteCookie(t.deps.config, value, 2_000)).toBe(id);
    expect(readInviteCookie(t.deps.config, value, 1_000 + 601_000)).toBeNull();
    const other = '00000000-0000-4000-8000-000000000002';
    expect(readInviteCookie(t.deps.config, value.replace(id, other), 2_000)).toBeNull();
    expect(readInviteCookie(t.deps.config, 'garbage', 2_000)).toBeNull();
  });

  it('sets no cookie for an invitation that is not pending', async () => {
    const res = await post(t, '/api/v1/invitations/00000000-0000-4000-8000-000000000009/oauth', {});
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
