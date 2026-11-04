import { startFakeOpenAI, type FakeOpenAI } from '@openbots/models/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { schema } from '../db/client.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { createPairing } from '../services/devices.js';
import { ensureWorkspace } from '../workspace.js';
import { setComputerProvider } from '../services/computer.js';
import { ORIGIN, createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer } from '../test-computer.js';

describe('/api/v1/setup with sign-in rate limits on (the default)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({}, { rateLimit: true });
  });
  afterAll(() => t.close());

  // better-auth refuses a sign-up without the client's address when it rate
  // limits, so the wizard's admin was refused on every real install.
  it("creates the admin, passing on the caller's address", async () => {
    const res = await t.app.request(
      '/api/v1/setup/admin',
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Ada',
          email: 'ada@example.com',
          password: 'correct horse battery',
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.40' } } },
    );
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe('/api/v1/setup when the owner is made by pairing only (the standalone image)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SETUP_PAIRING_ONLY: '1' });
  });
  afterAll(() => t.close());

  it('refuses the wizard and the sign-up, says so, and still pairs the owner in', async () => {
    expect(await (await t.app.request('/api/v1/setup')).json()).toEqual({
      setupRequired: true,
      pairingOnly: true,
    });
    expect(await (await t.app.request('/api/v1/capabilities')).json()).toMatchObject({
      setupPairingOnly: true,
    });
    const account = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' };
    const admin = await t.app.request('/api/v1/setup/admin', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(account),
    });
    expect(admin.status).toBe(403);
    expect(await admin.json()).toMatchObject({ code: 'SETUP_PAIRING_ONLY' });
    const signUp = await t.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(account),
    });
    expect(signUp.status).toBe(403);
    expect(await signUp.json()).toMatchObject({ code: 'SETUP_PAIRING_ONLY' });
    expect(await t.db.select().from(schema.users)).toEqual([]);

    // `openbots pair` makes a pairing that makes the owner.
    const workspaceId = (await ensureWorkspace(t.db)).id;
    const pairing = await createPairing({
      db: t.deps.db,
      config: t.deps.config,
      workspaceId,
      ownerId: null,
      createdBy: 'cli',
      actor: SYSTEM_ACTOR,
    });
    const paired = await t.app.request('/api/v1/devices/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairing.qr.code,
        name: 'Phone',
        platform: 'ios',
        publicKey: Buffer.alloc(32, 3).toString('base64url'),
        pushKey: Buffer.alloc(32, 4).toString('base64url'),
        ownerName: 'Ada',
      }),
    });
    expect(paired.status, await paired.clone().text()).toBe(200);
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });
});

describe('/api/v1/setup on the managed service', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
  });
  afterAll(() => t.close());

  it('offers no wizard: people sign up, and the account step and image pull are not there', async () => {
    const setup = await t.app.request('/api/v1/setup');
    expect(await setup.json()).toEqual({ setupRequired: false, pairingOnly: false });
    const admin = await t.app.request('/api/v1/setup/admin', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'correct horse' }),
    });
    expect(admin.status).toBe(404);
    const cookie = (await t.signUp('owner@example.com')).cookie!;
    for (const method of ['GET', 'POST']) {
      const res = await t.app.request('/api/v1/setup/sandbox-image', {
        method,
        headers: { origin: ORIGIN, cookie },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe('/api/v1/setup', () => {
  let t: TestApp;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

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

  const setupRequired = async () =>
    ((await (await call(undefined, 'GET', '/setup')).json()) as { setupRequired: boolean })
      .setupRequired;

  const account = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' };

  it('needs setup before any user exists, without a session', async () => {
    expect(await setupRequired()).toBe(true);
  });

  it('rejects an invalid admin before creating anything', async () => {
    const res = await call(undefined, 'POST', '/setup/admin', { ...account, password: 'short' });
    expect(res.status).toBe(400);
    expect(await setupRequired()).toBe(true);
  });

  it('refuses an admin created from another origin', async () => {
    const res = await t.app.request('/api/v1/setup/admin', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(account),
    });
    expect(res.status).toBe(403);
    expect(await setupRequired()).toBe(true);
  });

  it('creates the first user as the owner and signs them in', async () => {
    const res = await call(undefined, 'POST', '/setup/admin', account);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toEqual({
      user: { id: expect.any(String), email: account.email, name: 'Ada' },
    });
    admin = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.includes('session_token='))!;
    expect(admin).toBeDefined();
    const me = (await (await call(admin, 'GET', '/me')).json()) as { role: string };
    expect(me.role).toBe('owner');
    expect(await setupRequired()).toBe(false);
  });

  it('refuses once a user exists, and so does sign-up', async () => {
    const res = await call(undefined, 'POST', '/setup/admin', {
      ...account,
      email: 'mallory@example.com',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SETUP_COMPLETE');
    // A self-hosted install has one account.
    const { res: signUp } = await t.signUp('member@example.com');
    expect(signUp.status).toBe(403);
    expect((await call(undefined, 'GET', '/setup/sandbox-image')).status).toBe(401);
  });

  describe('the provider key step (L1) through the providers API', () => {
    let fake: FakeOpenAI;

    beforeAll(async () => {
      fake = await startFakeOpenAI({ models: [{ id: 'qwen3' }] });
    });
    afterAll(() => fake.close());

    it('needs a key for a built-in provider', async () => {
      const res = await call(admin, 'POST', '/providers', { presetId: 'anthropic' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('API_KEY_REQUIRED');
    });

    it('reports a working key as ok and a failing one as error', async () => {
      const add = async (name: string, baseUrl: string) => {
        const res = await call(admin, 'POST', '/providers', {
          name,
          protocol: 'openai_compatible',
          baseUrl,
          // The fakes listen on 127.0.0.1 (S-12).
          local: true,
          apiKey: 'sk-test',
          models: [{ modelId: 'qwen3' }],
        });
        expect(res.status).toBe(201);
        const { id } = (await res.json()) as { id: string };
        const tested = await call(admin, 'POST', `/providers/${id}/test`);
        expect(tested.status).toBe(200);
        return ((await tested.json()) as { status: string }).status;
      };
      expect(await add('Works', fake.baseUrl)).toBe('ok');
      expect(await add('Down', 'http://127.0.0.1:9/v1')).toBe('error');
    });
  });

  describe('the sandbox image pull', () => {
    it('is not configured without Docker', async () => {
      setComputerProvider(t.ownerDeps, null);
      const res = await call(admin, 'POST', '/setup/sandbox-image');
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: 'not_configured',
        image: t.deps.config.sandboxImage,
        error: null,
      });
    });

    it('pulls in the background with Docker and reports when it is ready', async () => {
      const deps = { ...t.ownerDeps };
      const app = createApp(deps, { webDist: '' });
      const computer = await useTestComputer(deps);
      try {
        const request = (method: string) =>
          app.request('/api/v1/setup/sandbox-image', { method, headers: { cookie: admin } });
        expect(((await (await request('GET')).json()) as { status: string }).status).toBe('idle');
        const started = (await (await request('POST')).json()) as { status: string };
        expect(started.status).toBe('pulling');
        await expect
          .poll(async () => ((await (await request('GET')).json()) as { status: string }).status)
          .toBe('ready');
        expect(computer.docker.calls.map((c) => c.op)).toContain('pull');
      } finally {
        await computer.close();
      }
    });
  });
});
