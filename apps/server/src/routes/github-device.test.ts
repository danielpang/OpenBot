import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from '../builtins/net.js';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { oauthAccessToken, openSecrets } from '../services/connectors.js';
import { createTestApp, type TestApp } from '../test-app.js';

const DEVICE_CODE = 'private-device-code';
const TOKEN = 'gho_private-access-token';

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
    expect(JSON.parse(text)).toMatchObject({ device: { userCode: 'ABCD-EFGH', interval: 5 } });
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
    });
    cookie = (await t.signUp('owner@example.com')).cookie!;
    other = (await t.signUp('other@example.com')).cookie!;
  });
  afterAll(() => t.close());
  afterEach(() => {
    vi.restoreAllMocks();
    request.mockReset();
  });
  const mockNetwork = () => vi.spyOn(net, 'netFetch').mockReturnValue(request);

  it('advertises shared device flow and stores the device code and token encrypted', async () => {
    mockNetwork();
    const catalog = (await (await call('GET', '/connectors/catalog')).json()) as {
      items: { id: string; oauth: { deviceFlow?: boolean } | null }[];
    };
    expect(catalog.items.find((e) => e.id === 'github')?.oauth?.deviceFlow).toBe(true);
    const c = await newConnector();
    expect(c.oauth.clientConfigured).toBe(true);
    await start(c.id);
    expect(request.mock.calls[0]![0]).toBe('https://github.com/login/device/code');
    expect(request.mock.calls[0]![1]!.body).toContain('client_id=public-client-id');
    expect(request.mock.calls[0]![1]!.body).not.toContain('client_secret');
    expect(Buffer.from((await row(c.id)).secrets!).toString()).not.toContain(DEVICE_CODE);
    // Polling early does not call GitHub.
    expect(await (await call('POST', `/connectors/${c.id}/oauth/device`)).json()).toEqual({
      status: 'pending',
      interval: 5,
    });
    expect(request).toHaveBeenCalledTimes(1);
    await ready(c.id);
    request.mockResolvedValueOnce(
      Response.json({ access_token: TOKEN, token_type: 'bearer', scope: 'repo' }),
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
    const c = await newConnector({ oauthClient: { clientId: 'own-public-id' } });
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
    await call('PUT', '/connector-policy', { catalogIds: ['github'], urlPatterns: [] });
    expect((await call('POST', `/connectors/${c.id}/oauth/device`)).status).toBe(403);
    expect((await call('GET', `/connectors/${c.id}/oauth/start`)).status).toBe(403);
    await call('PUT', '/connector-policy', { catalogIds: [], urlPatterns: [] });
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
