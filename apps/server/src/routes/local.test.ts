import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../app.js';
import { createAuth, LOCAL_OWNER_EMAIL } from '../auth.js';
import { schema } from '../db/client.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { sameToken } from './local.js';

const TOKEN = 'x9'.repeat(22);

let address = 0;
/** A fresh client address per call, so the rate limit only bites where a test means it to. */
const from = (ip = `192.0.2.${++address}`) => ({ incoming: { socket: { remoteAddress: ip } } });

function localSession(
  t: TestApp,
  {
    token = TOKEN,
    body,
    headers = {},
    ip,
  }: {
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
) {
  return t.app.request(
    '/api/v1/local/session',
    {
      method: 'POST',
      headers: {
        ...(token == null ? {} : { 'x-openbots-local-token': token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    from(ip),
  );
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.includes('session_token='));

async function me(t: TestApp, cookie: string) {
  const res = await t.app.request('/api/v1/me', { headers: { cookie } });
  return {
    status: res.status,
    body: (await res.json()) as { user: { id: string; name: string; email: string }; role: string },
  };
}

describe('sameToken', () => {
  it('matches only the same token, whatever the lengths', () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(sameToken('', TOKEN)).toBe(false);
    expect(sameToken(undefined, TOKEN)).toBe(false);
  });
});

describe('POST /api/v1/local/session without a local token', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('does not exist', async () => {
    const res = await localSession(t);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await t.testDb.db.select().from(schema.users)).toEqual([]);
  });

  it('reports password sign-in in the capabilities', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(((await res.json()) as { auth: string }).auth).toBe('password');
  });
});

describe('POST /api/v1/local/session on a new install', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_LOCAL_TOKEN: TOKEN });
  });
  afterAll(() => t.close());

  it('reports local sign-in in the capabilities', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(((await res.json()) as { auth: string }).auth).toBe('local');
  });

  it('refuses a missing or wrong token without creating anyone', async () => {
    for (const token of [null, '', 'wrong', `${TOKEN}x`, TOKEN.slice(1)]) {
      const res = await localSession(t, { token });
      expect(res.status, String(token)).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('LOCAL_TOKEN_INVALID');
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await t.testDb.db.select().from(schema.users)).toEqual([]);
  });

  it('does not take the token in the query string', async () => {
    const res = await t.app.request(
      `/api/v1/local/session?token=${TOKEN}&x-openbots-local-token=${TOKEN}`,
      { method: 'POST' },
      from(),
    );
    expect(res.status).toBe(401);
  });

  it('refuses browsers, even from its own origin and with the right token', async () => {
    const browsers: Record<string, string>[] = [
      { origin: ORIGIN },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of browsers) {
      const res = await localSession(t, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('sends no CORS headers, not even to a preflight', async () => {
    const preflight = await t.app.request(
      '/api/v1/local/session',
      {
        method: 'OPTIONS',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-openbots-local-token',
        },
      },
      from(),
    );
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    // Other API routes keep theirs.
    const other = await t.app.request('/api/v1/capabilities', { headers: { origin: ORIGIN } });
    expect(other.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('refuses every other way to make the owner, so nobody can take a new install first', async () => {
    const admin = await t.app.request(
      '/api/v1/setup/admin',
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: 'correct horse battery',
        }),
      },
      from(),
    );
    expect(admin.status).toBe(403);
    expect(((await admin.json()) as { code: string }).code).toBe('LOCAL_ONLY');

    const { res: signUp, cookie: signUpCookie } = await t.signUp('mallory@example.com');
    expect(signUp.status).toBe(403);
    expect(((await signUp.json()) as { code: string }).code).toBe('LOCAL_ONLY');
    expect(signUpCookie).toBeUndefined();

    for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-in/social']) {
      const res = await t.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          email: 'mallory@example.com',
          password: 'correct horse battery',
          provider: 'github',
          callbackURL: '/',
        }),
      });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('LOCAL_ONLY');
    }
    expect(await t.testDb.db.select().from(schema.users)).toEqual([]);
  });

  let ownerId: string;
  let cookie: string;

  it('creates the owner, with no password, and signs them in', async () => {
    const res = await localSession(t, { body: { name: 'Ada Lovelace' } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const { user } = (await res.json()) as { user: { id: string; name: string } };
    expect(user).toEqual({ id: expect.any(String), name: 'Ada Lovelace' });
    ownerId = user.id;
    cookie = cookieOf(res)!;
    expect(cookie).toBeDefined();
    const caller = await me(t, cookie);
    expect(caller.status).toBe(200);
    expect(caller.body.user).toMatchObject({ id: ownerId, name: 'Ada Lovelace' });
    expect(caller.body.role).toBe('owner');
    expect(caller.body.user.email).toBe(LOCAL_OWNER_EMAIL);
    // No credential to sign in with.
    const accounts = await t.testDb.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, ownerId));
    expect(accounts).toEqual([]);
    const signIn = await t.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: LOCAL_OWNER_EMAIL, password: 'correct horse battery' }),
    });
    expect(signIn.status).toBe(403);
  });

  it('audits the session as auth.local_session', async () => {
    const rows = await t.testDb.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorId, ownerId));
    expect(rows.map((row) => row.action)).toEqual(['auth.local_session']);
  });

  it('reuses the owner on later calls, ignoring the name', async () => {
    const res = await localSession(t, { body: { name: 'Someone Else' } });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string; name: string } };
    expect(user).toEqual({ id: ownerId, name: 'Ada Lovelace' });
    const again = cookieOf(res)!;
    expect(again).not.toBe(cookie);
    expect((await me(t, again)).body.user.id).toBe(ownerId);
    expect(await t.testDb.db.select().from(schema.users)).toHaveLength(1);
  });

  it('names the owner Me when the app sends no name', async () => {
    const other = await createTestApp({ OPENBOTS_LOCAL_TOKEN: TOKEN });
    try {
      const res = await localSession(other);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { user: { name: string } }).user.name).toBe('Me');
    } finally {
      await other.close();
    }
  });

  it('keeps sign-up closed once the owner exists', async () => {
    const { res } = await t.signUp('mallory@example.com');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('LOCAL_ONLY');
    expect(await t.testDb.db.select().from(schema.users)).toHaveLength(1);
  });

  it('shows the wizard, without its account step, until the first Bot exists', async () => {
    const setup = async () =>
      ((await (await t.app.request('/api/v1/setup')).json()) as { setupRequired: boolean })
        .setupRequired;
    expect(await setup()).toBe(true);
    const providerId = await t.providerId();
    const created = await t.app.request('/api/v1/bots', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Assistant',
        modelConfig: { provider_id: providerId, model_id: 'scripted' },
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await setup()).toBe(false);
  });

  it('rate-limits each address like sign-in', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await localSession(t, { token: 'wrong', ip: '198.51.100.7' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe('POST /api/v1/local/session on an install from before local mode', () => {
  let t: TestApp;
  let local: App;
  beforeAll(async () => {
    // The install as it was: password sign-in, an owner who signed up with an email.
    t = await createTestApp();
    // The same database after the Mac app wrote a local token and restarted the stack.
    const config = { ...t.deps.config, localToken: TOKEN };
    const auth = createAuth({
      config,
      db: t.db,
      logger: t.deps.logger,
      limiter: t.deps.infra.limiter,
      rateLimit: false,
    });
    local = createApp({ ...t.deps, config, auth }, { webDist: '' });
  });
  afterAll(() => t.close());

  it('signs in the owner who signed up with an email, whose password no longer works', async () => {
    const { res: signedUp } = await t.signUp('ada@example.com');
    expect(signedUp.status).toBe(200);
    const { user: existing } = (await signedUp.json()) as { user: { id: string } };
    const localT = { ...t, app: local };

    // An older install is set up already; the wizard stays away.
    const setup = (await (await local.request('/api/v1/setup')).json()) as {
      setupRequired: boolean;
    };
    expect(setup.setupRequired).toBe(false);

    const res = await localSession(localT, { body: { name: 'Me' } });
    expect(res.status, await res.clone().text()).toBe(200);
    const { user } = (await res.json()) as { user: { id: string; name: string } };
    expect(user).toEqual({ id: existing.id, name: 'ada' });
    const caller = await me(localT, cookieOf(res)!);
    expect(caller.status).toBe(200);
    expect(caller.body.user.email).toBe('ada@example.com');
    expect(await t.testDb.db.select().from(schema.users)).toHaveLength(1);

    const signIn = await local.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' }),
    });
    expect(signIn.status).toBe(403);
    expect(((await signIn.json()) as { code: string }).code).toBe('LOCAL_ONLY');
  });
});
