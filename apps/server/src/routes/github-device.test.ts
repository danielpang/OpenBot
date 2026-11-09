import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from '../builtins/net.js';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { oauthAccessToken, openSecrets } from '../services/connectors.js';
import { createTestApp, type TestApp } from '../test-app.js';

const DEVICE_CODE = 'private-device-code';
const TOKEN = 'ghu_private-access-token';

describe('GitHub connector device authorization', () => {
  let t: TestApp;
  let cookie: string;
  let other: string;
  const request = vi.fn<typeof fetch>();
  const call = (method: string, path: string, body?: unknown, session = cookie) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie: session, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const row = async (id: string) =>
    (await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, id)))[0]!;
  const newConnector = async (extra: Record<string, unknown> = {}) => {
    const res = await call('POST', '/connectors', { catalogId: 'github', auth: 'oauth', ...extra });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; oauth: { clientConfigured: boolean } };
  };
  const start = async (id: string) => {
    request.mockResolvedValueOnce(
      Response.json({
        device_code: DEVICE_CODE,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    );
    const res = await call('GET', `/connectors/${id}/oauth/start?mode=external`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(DEVICE_CODE);
    expect(JSON.parse(text)).toMatchObject({
      device: {
        userCode: 'ABCD-EFGH',
        interval: 5,
        installationUrl: expect.stringMatching(/^https:\/\/github.com\/apps\//),
      },
    });
  };
  const ready = async (id: string, expired = false) => {
    const secrets = openSecrets(t.deps, await row(id));
    secrets.oauth!.device!.nextPollAt = 0;
    if (expired) secrets.oauth!.device!.expiresAt = 0;
    await t.db
      .update(schema.connectors)
      .set({ secrets: encryptSecret(JSON.stringify(secrets), keyringFromConfig(t.deps.config)) })
      .where(eq(schema.connectors.id, id));
  };
  beforeAll(async () => {
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_GITHUB_CLIENT_ID: 'public-client-id',
      OPENBOTS_GITHUB_APP_SLUG: 'openbots-test',
    });
    cookie = (await t.signUp('owner@example.com')).cookie!;
    other = (await t.signUp('other@example.com')).cookie!;
  });
  afterAll(() => t.close());
  afterEach(() => {
    vi.restoreAllMocks();
    request.mockReset();
  });
  const mockNetwork = () => {
    request.mockImplementation(async () =>
      Response.json({ installations: [{ app_slug: 'openbots-test', suspended_at: null }] }),
    );
    return vi.spyOn(net, 'netFetch').mockReturnValue(request);
  };

  it('advertises shared device flow and stores the device code and token encrypted', async () => {
    mockNetwork();
    const catalog = (await (await call('GET', '/connectors/catalog')).json()) as {
      items: { id: string; oauth: { deviceFlow?: boolean } | null }[];
    };
    expect(catalog.items.find((e) => e.id === 'github')?.oauth?.deviceFlow).toBe(true);
    // Exactly what the catalog button sends: do not force auth:'oauth'.
    const created = await call('POST', '/connectors', { catalogId: 'github' });
    expect(created.status).toBe(201);
    const c = (await created.json()) as { id: string; oauth: { clientConfigured: boolean } };
    expect(c.oauth.clientConfigured).toBe(true);
    await start(c.id);
    expect(request.mock.calls[0]![0]).toBe('https://github.com/login/device/code');
    expect(request.mock.calls[0]![1]!.body).toContain('client_id=public-client-id');
    expect(request.mock.calls[0]![1]!.body).not.toContain('client_secret');
    expect(request.mock.calls[0]![1]!.body).not.toContain('scope=');
    expect(Buffer.from((await row(c.id)).secrets!).toString()).not.toContain(DEVICE_CODE);
    // Polling early does not call GitHub.
    expect(await (await call('POST', `/connectors/${c.id}/oauth/device`)).json()).toEqual({
      status: 'pending',
      interval: 5,
    });
    expect(request).toHaveBeenCalledTimes(1);
    await ready(c.id);
    request.mockResolvedValueOnce(
      Response.json({ access_token: TOKEN, token_type: 'bearer', scope: '' }),
    );
    const res = await call('POST', `/connectors/${c.id}/oauth/device`);
    expect(await res.json()).toEqual({ status: 'connected' });
    const saved = await row(c.id);
    expect(Buffer.from(saved.secrets!).toString()).not.toContain(TOKEN);
    expect(openSecrets(t.deps, saved).oauth?.device).toBeUndefined();
    expect(await oauthAccessToken(t.ownerDeps, c.id)).toBe(TOKEN);
    expect((await call('POST', `/connectors/${c.id}/oauth/device`)).status).toBe(400);
  });

  it('supports a self-hoster public client ID without a secret', async () => {
    mockNetwork();
    const c = await newConnector({
      oauthClient: { clientId: 'own-public-id', githubAppSlug: 'own-app' },
    });
    await start(c.id);
    expect(request.mock.calls[0]![1]!.body).toContain('client_id=own-public-id');
  });

  it('honors pending and slow_down and reserves concurrent polls', async () => {
    mockNetwork();
    const c = await newConnector();
    await start(c.id);
    await ready(c.id);
    request.mockResolvedValueOnce(Response.json({ error: 'slow_down', interval: 10 }));
    const responses = await Promise.all([
      call('POST', `/connectors/${c.id}/oauth/device`),
      call('POST', `/connectors/${c.id}/oauth/device`),
    ]);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(openSecrets(t.deps, await row(c.id)).oauth?.device?.interval).toBe(10);
    await ready(c.id);
    request.mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }));
    expect(await (await call('POST', `/connectors/${c.id}/oauth/device`)).json()).toEqual({
      status: 'pending',
      interval: 10,
    });
  });

  it('clears denied and expired flows without returning provider details', async () => {
    mockNetwork();
    for (const expired of [false, true]) {
      const c = await newConnector();
      await start(c.id);
      await ready(c.id, expired);
      if (!expired)
        request.mockResolvedValueOnce(
          Response.json({ error: 'access_denied', error_description: DEVICE_CODE }),
        );
      const res = await call('POST', `/connectors/${c.id}/oauth/device`);
      const text = await res.text();
      expect(JSON.parse(text).status).toBe('error');
      expect(text).not.toContain(DEVICE_CODE);
      expect(openSecrets(t.deps, await row(c.id)).oauth?.device).toBeUndefined();
    }
  });

  it('does not overwrite a flow that was restarted during token exchange', async () => {
    mockNetwork();
    const c = await newConnector();
    await start(c.id);
    await ready(c.id);
    let release!: (response: Response) => void;
    let requested!: () => void;
    const began = new Promise<void>((resolve) => {
      requested = resolve;
    });
    request.mockImplementationOnce(() => {
      requested();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const pending = call('POST', `/connectors/${c.id}/oauth/device`);
    await began;
    await start(c.id);
    release(Response.json({ access_token: TOKEN }));
    expect((await pending).status).toBe(400);
    const secrets = openSecrets(t.deps, await row(c.id));
    expect(secrets.oauth?.tokens).toBeUndefined();
    expect(secrets.oauth?.device).toBeDefined();
  });

  it('keeps temporary failures private and retries no earlier than the reserved interval', async () => {
    mockNetwork();
    const c = await newConnector();
    await start(c.id);
    await ready(c.id);
    request.mockRejectedValueOnce(new Error(DEVICE_CODE));
    const res = await call('POST', `/connectors/${c.id}/oauth/device`);
    expect(await res.json()).toEqual({ status: 'pending', interval: 5 });
    await call('POST', `/connectors/${c.id}/oauth/device`);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('requires GitHub App identifiers and rejects a shared client secret', async () => {
    mockNetwork();
    for (const oauthClient of [
      { clientId: 'own-id' },
      { clientId: 'own-id', githubAppSlug: 'own-app', clientSecret: 'do-not-share' },
    ]) {
      const c = await newConnector({ oauthClient });
      const res = await call('GET', `/connectors/${c.id}/oauth/start`);
      expect(res.status).toBe(400);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('requires an installation of this app and rejects OAuth App tokens', async () => {
    mockNetwork();
    for (const installation of [
      [],
      [{ app_slug: 'different-app', suspended_at: null }],
      [{ app_slug: 'openbots-test', suspended_at: '2026-01-01T00:00:00Z' }],
    ]) {
      const c = await newConnector();
      await start(c.id);
      await ready(c.id);
      request.mockResolvedValueOnce(Response.json({ access_token: TOKEN }));
      request.mockResolvedValueOnce(Response.json({ installations: installation }));
      const res = await call('POST', `/connectors/${c.id}/oauth/device`);
      expect(await res.json()).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Install the GitHub App'),
      });
      expect(openSecrets(t.deps, await row(c.id)).oauth?.tokens).toBeUndefined();
    }
    const c = await newConnector();
    await start(c.id);
    await ready(c.id);
    request.mockResolvedValueOnce(Response.json({ access_token: 'gho_oauth-app-token' }));
    expect(await (await call('POST', `/connectors/${c.id}/oauth/device`)).json()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('not an OAuth App'),
    });
  });

  it('stores expiry and rotates expiring user and refresh tokens without a secret', async () => {
    mockNetwork();
    const c = await newConnector();
    await start(c.id);
    await ready(c.id);
    request.mockResolvedValueOnce(
      Response.json({
        access_token: TOKEN,
        expires_in: 1,
        refresh_token: 'ghr_private-original',
        refresh_token_expires_in: 1000,
      }),
    );
    expect(await (await call('POST', `/connectors/${c.id}/oauth/device`)).json()).toEqual({
      status: 'connected',
    });
    const initial = openSecrets(t.deps, await row(c.id)).oauth!;
    expect(initial.tokens?.expires_at).toBeGreaterThan(Date.now());
    expect(initial.tokens?.refresh_expires_at).toBeGreaterThan(Date.now());
    expect(initial.githubApp).toEqual({ clientId: 'public-client-id', appSlug: 'openbots-test' });
    const count = request.mock.calls.length;
    request.mockResolvedValueOnce(
      Response.json({
        access_token: 'ghu_rotated-token',
        expires_in: 28800,
        refresh_token: 'ghr_rotated-token',
        refresh_token_expires_in: 15897600,
      }),
    );
    expect(
      await Promise.all([oauthAccessToken(t.ownerDeps, c.id), oauthAccessToken(t.ownerDeps, c.id)]),
    ).toEqual(['ghu_rotated-token', 'ghu_rotated-token']);
    expect(request).toHaveBeenCalledTimes(count + 1);
    const [url, options] = request.mock.calls.at(-1)!;
    expect(url).toBe('https://github.com/login/oauth/access_token');
    const body = new URLSearchParams(String(options!.body));
    expect([...body.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('ghr_private-original');
    const saved = await row(c.id);
    expect(Buffer.from(saved.secrets!).toString()).not.toContain('ghr_rotated-token');
    expect(openSecrets(t.deps, saved).oauth?.tokens?.refresh_token).toBe('ghr_rotated-token');
  });

  it('asks to reconnect after refresh expiry or revocation without leaking tokens', async () => {
    mockNetwork();
    for (const expired of [false, true]) {
      const c = await newConnector();
      await start(c.id);
      await ready(c.id);
      request.mockResolvedValueOnce(
        Response.json({
          access_token: TOKEN,
          expires_in: 1,
          refresh_token: 'ghr_private-original',
          refresh_token_expires_in: 1000,
        }),
      );
      await call('POST', `/connectors/${c.id}/oauth/device`);
      if (expired) {
        const secrets = openSecrets(t.deps, await row(c.id));
        secrets.oauth!.tokens!.refresh_expires_at = 1;
        await t.db
          .update(schema.connectors)
          .set({
            secrets: encryptSecret(JSON.stringify(secrets), keyringFromConfig(t.deps.config)),
          })
          .where(eq(schema.connectors.id, c.id));
      } else {
        request.mockResolvedValueOnce(
          Response.json({ error: 'bad_refresh_token', error_description: 'ghr_private-original' }),
        );
      }
      await expect(oauthAccessToken(t.ownerDeps, c.id)).rejects.toThrow(
        'The GitHub App authorization expired or was revoked. Connect again.',
      );
    }
  });

  it('requires the connector owner and rejects changed URLs and policy blocks', async () => {
    mockNetwork();
    const c = await newConnector();
    await start(c.id);
    expect((await call('POST', `/connectors/${c.id}/oauth/device`, undefined, other)).status).toBe(
      404,
    );
    expect((await call('POST', `/connectors/${c.id}/oauth/device`, undefined, '')).status).toBe(
      401,
    );
    await call('PUT', '/connector-policy', { urlPatterns: ['https://api.githubcopilot.com/*'] });
    expect((await call('POST', `/connectors/${c.id}/oauth/device`)).status).toBe(403);
    expect((await call('GET', `/connectors/${c.id}/oauth/start`)).status).toBe(403);
    await call('PUT', '/connector-policy', { urlPatterns: [] });
    // Catalog URLs are pinned. Also defend against a legacy or corrupted row.
    expect(
      (await call('PATCH', `/connectors/${c.id}`, { url: 'https://example.com/mcp' })).status,
    ).toBe(400);
    const saved = await row(c.id);
    const config = saved.config as { transport: Record<string, unknown> };
    await t.db
      .update(schema.connectors)
      .set({
        config: { ...config, transport: { ...config.transport, url: 'https://example.com/mcp' } },
      })
      .where(eq(schema.connectors.id, c.id));
    expect((await call('POST', `/connectors/${c.id}/oauth/device`)).status).toBe(400);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
