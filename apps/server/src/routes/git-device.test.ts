import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from '../builtins/net.js';
import { schema } from '../db/client.js';
import {
  openConnectionSecrets,
  sealConnectionSecrets,
} from '../services/git-connection-secrets.js';
import { tokenForConnection } from '../services/git-connections.js';
import {
  pullRequestToken,
  resolveGitCredential,
  runnerSessionIds,
} from '../services/git-credentials.js';
import { createTestApp, type TestApp } from '../test-app.js';

const ACCESS = 'ghu_private-user-token';
const REFRESH = 'ghr_private-refresh-token';
const DEVICE = 'private-device-code';

describe('coding repositories through GitHub App device authorization (GH1, GH2, GH7, GH8)', () => {
  let t: TestApp;
  let cookie: string;
  let other: string;
  let owner: { id: string; workspaceId: string };
  let otherOrg: string;
  let appSlug = 'openbots-github';
  let installations: unknown[];
  let repos: unknown[];
  let tokenError: string | null;
  let apiStatus: number;
  const request = vi.fn<typeof fetch>();
  const call = (method: string, path: string, body?: unknown, session = cookie) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie: session, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const row = async (id: string) =>
    (await t.db.select().from(schema.gitConnections).where(eq(schema.gitConnections.id, id)))[0]!;
  const ready = async (id: string, expire = false) => {
    const current = await row(id);
    const secrets = openConnectionSecrets(t.deps, current);
    secrets.githubDevice!.pending!.device.nextPollAt = 0;
    if (expire) secrets.githubDevice!.pending!.device.expiresAt = 0;
    await t.db
      .update(schema.gitConnections)
      .set({ secrets: sealConnectionSecrets(t.deps, secrets) })
      .where(eq(schema.gitConnections.id, id));
  };
  const tokenCalls = () =>
    request.mock.calls.filter(([url]) => String(url).endsWith('/login/oauth/access_token'));
  const start = async (extra: object = {}) => {
    const response = await call('POST', '/git-connections/github-app/device', extra);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain(DEVICE);
    return JSON.parse(text) as {
      connectionId: string;
      device: { userCode: string; installationUrl: string };
    };
  };
  const connected = async () => {
    const flow = await start();
    await ready(flow.connectionId);
    const response = await call('POST', `/git-connections/${flow.connectionId}/device`);
    expect(response.status, await response.clone().text()).toBe(200);
    const answer = (await response.json()) as { status: string; connection: { id: string } };
    expect(answer.status).toBe('connected');
    return answer.connection.id;
  };

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_STDIO_RUNNER: 'computer' });
    cookie = (await t.signUp('device-owner@example.com')).cookie!;
    other = (await t.signUp('device-other@example.com')).cookie!;
    owner = {
      id: await t.userId('device-owner@example.com'),
      workspaceId: await t.defaultOrganization(),
    };
    otherOrg = await t.createOrganization('Other organization');
    await t.addMember(owner.id, otherOrg);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.switchOrganization(cookie, owner.workspaceId);
    await t.db.delete(schema.repos);
    await t.db.delete(schema.gitConnections);
    appSlug = 'openbots-github';
    tokenError = null;
    apiStatus = 200;
    installations = [
      { id: 900, app_slug: appSlug, suspended_at: null, permissions: { contents: 'write' } },
      {
        id: 901,
        app_slug: 'different-app',
        suspended_at: null,
        permissions: { contents: 'write' },
      },
      {
        id: 902,
        app_slug: appSlug,
        suspended_at: '2026-01-01T00:00:00Z',
        permissions: { contents: 'write' },
      },
    ];
    repos = [
      {
        id: 1,
        full_name: 'acme/relay',
        private: true,
        default_branch: 'main',
        permissions: { push: true, admin: false },
      },
      {
        id: 2,
        full_name: 'acme/read-only',
        private: true,
        default_branch: 'trunk',
        permissions: { push: false },
      },
    ];
    request.mockReset().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/login/device/code')
        return Response.json({
          device_code: DEVICE,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      if (path === '/login/oauth/access_token') {
        const body = new URLSearchParams(String(init?.body));
        expect(body.has('client_secret')).toBe(false);
        expect(body.has('scope')).toBe(false);
        if (tokenError) return Response.json({ error: tokenError });
        if (body.get('grant_type') === 'refresh_token')
          return Response.json({
            access_token: 'ghu_refreshed',
            refresh_token: 'ghr_rotated',
            token_type: 'bearer',
            expires_in: 3600,
          });
        return Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          token_type: 'bearer',
          expires_in: 3600,
        });
      }
      if (apiStatus !== 200)
        return Response.json({ message: 'not accepted' }, { status: apiStatus });
      if (path === '/user') return Response.json({ id: 123, login: 'alice' });
      if (path === '/user/installations') return Response.json({ installations });
      if (path === '/user/installations/900/repositories')
        return Response.json({ repositories: repos });
      throw new Error(`Unexpected GitHub request: ${path}`);
    });
    vi.spyOn(net, 'netFetch').mockReturnValue(request);
  });
  afterEach(() => {
    runnerSessionIds.clear();
    vi.restoreAllMocks();
  });

  it('offers the shared App on localhost with no App secrets or public HTTPS URL', async () => {
    expect(t.deps.config.githubApp).toBeUndefined();
    const status = await (await call('GET', '/git-connections/github-app')).json();
    expect(status).toMatchObject({
      configured: false,
      publicUrlOk: false,
      deviceFlowAvailable: true,
      deviceAppSlug: 'openbots-github',
      deviceInstallationUrl: 'https://github.com/apps/openbots-github/installations/new',
    });
    const flow = await start();
    expect(flow.device.userCode).toBe('ABCD-EFGH');
    expect(request.mock.calls[0]![1]?.body).toContain('client_id=Iv23liyL74CRKUWIUXhq');
    const saved = await row(flow.connectionId);
    expect(Buffer.from(saved.secrets!).toString()).not.toContain(DEVICE);
    expect(saved.status).toBe('pending');
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toEqual({ status: 'pending', stage: 'authorization', interval: 5 });
    expect(tokenCalls()).toHaveLength(0);
  });

  it('creates a real coding-repository connection, keeps tokens sealed, and is idempotent', async () => {
    const id = await connected();
    const response = await call('POST', `/git-connections/${id}/device`);
    const text = await response.text();
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(DEVICE);
    expect(JSON.parse(text)).toMatchObject({
      status: 'connected',
      connection: {
        id,
        kind: 'device',
        appSlug: 'openbots-github',
        accountLogin: 'alice',
        actAs: 'owner',
        status: 'connected',
        installationId: null,
      },
    });
    const saved = await row(id);
    expect(Buffer.from(saved.secrets!).toString()).not.toContain(ACCESS);
    expect(openConnectionSecrets(t.deps, saved).githubDevice).toMatchObject({
      userId: '123',
      tokens: { access_token: ACCESS, refresh_token: REFRESH },
    });
    expect(openConnectionSecrets(t.deps, saved).githubDevice?.pending).toBeUndefined();
    expect(tokenCalls()).toHaveLength(1);
  });

  it('lists only the authorizing user’s selected active App installations, across accounts, and remembers org repositories', async () => {
    const id = await connected();
    const response = await call('GET', `/git-connections/${id}/repositories`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositories: [{ fullName: 'acme/relay' }, { fullName: 'acme/read-only' }],
    });
    expect(
      request.mock.calls.some(
        ([url]) =>
          String(url).includes('/901/repositories') ||
          String(url).includes('/902/repositories') ||
          String(url).includes('/user/repos'),
      ),
    ).toBe(false);
    const remember = await call('POST', '/repos/remember', {
      connectionId: id,
      fullNames: ['acme/relay'],
    });
    expect(remember.status, await remember.clone().text()).toBe(200);
    expect((await t.db.select().from(schema.repos))[0]?.connectionId).toBe(id);
    const forbidden = await call('POST', '/repos/remember', {
      connectionId: id,
      fullNames: ['acme/hidden'],
    });
    expect(forbidden.status).toBe(403);
    expect(
      (
        await call(
          'POST',
          '/repos/remember',
          { connectionId: id, fullNames: ['acme/relay'] },
          other,
        )
      ).status,
    ).toBe(404);
  });

  it('waits for installation/organization approval without exchanging the device code twice', async () => {
    installations = [];
    const flow = await start();
    await ready(flow.connectionId);
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'pending', stage: 'installation' });
    installations = [
      { id: 900, app_slug: appSlug, suspended_at: null, permissions: { contents: 'write' } },
    ];
    await ready(flow.connectionId);
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'connected' });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('retains an exchanged token across transient GitHub API failures', async () => {
    const flow = await start();
    await ready(flow.connectionId);
    apiStatus = 503;
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'pending' });
    apiStatus = 200;
    await ready(flow.connectionId);
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'connected' });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('holds polling limits and slow_down across concurrent requests', async () => {
    const flow = await start();
    await ready(flow.connectionId);
    tokenError = 'slow_down';
    const results = await Promise.all([
      call('POST', `/git-connections/${flow.connectionId}/device`),
      call('POST', `/git-connections/${flow.connectionId}/device`),
    ]);
    expect(await results[0]!.json()).toMatchObject({ status: 'pending', interval: 10 });
    expect(await results[1]!.json()).toMatchObject({ status: 'pending', interval: 10 });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('handles denial and expiry without leaking codes or making an expired token request', async () => {
    const flow = await start();
    await ready(flow.connectionId);
    tokenError = 'access_denied';
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'error', message: expect.stringContaining('cancelled') });
    expect(
      openConnectionSecrets(t.deps, await row(flow.connectionId)).githubDevice?.pending,
    ).toBeUndefined();
    const expired = await start();
    await ready(expired.connectionId, true);
    expect(
      await (await call('POST', `/git-connections/${expired.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'error', message: expect.stringContaining('expired') });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('rejects a non-App OAuth token instead of silently accepting the wrong integration', async () => {
    const flow = await start();
    await ready(flow.connectionId);
    request.mockResolvedValueOnce(
      Response.json({ access_token: 'gho_not-an-app', token_type: 'bearer' }),
    );
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'error', message: expect.stringContaining('GitHub App') });
  });

  it('keeps poll/reconnect/list/sync/disconnect private to the owner and organization', async () => {
    const flow = await start();
    const before = request.mock.calls.length;
    expect(
      (await call('POST', `/git-connections/${flow.connectionId}/device`, undefined, other)).status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          '/git-connections/github-app/device',
          { connectionId: flow.connectionId },
          other,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `/git-connections/${flow.connectionId}/repositories`, undefined, other))
        .status,
    ).toBe(404);
    expect(
      (await call('DELETE', `/git-connections/${flow.connectionId}`, undefined, other)).status,
    ).toBe(404);
    await t.switchOrganization(cookie, otherOrg);
    expect((await call('POST', `/git-connections/${flow.connectionId}/device`)).status).toBe(404);
    expect(request.mock.calls).toHaveLength(before);
  });

  it('supports public custom App identifiers, validates pairs, and remembers them for reauthorization', async () => {
    expect(
      (await call('POST', '/git-connections/github-app/device', { clientId: 'Iv.custom' })).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/git-connections/github-app/device', {
          clientId: 'Iv.custom',
          appSlug: '../bad',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/git-connections/github-app/device', {
          clientId: 'Iv.custom',
          appSlug: 'custom-app',
          clientSecret: 'not-allowed',
        })
      ).status,
    ).toBe(400);
    installations = [
      { id: 900, app_slug: 'custom-app', suspended_at: null, permissions: { contents: 'write' } },
    ];
    const flow = await start({ clientId: 'Iv.custom', appSlug: 'custom-app' });
    expect(flow.device.installationUrl).toBe(
      'https://github.com/apps/custom-app/installations/new',
    );
    await ready(flow.connectionId);
    expect(
      await (await call('POST', `/git-connections/${flow.connectionId}/device`)).json(),
    ).toMatchObject({ status: 'connected' });
    await start({ connectionId: flow.connectionId });
    expect(request.mock.calls.at(-1)![1]!.body).toContain('client_id=Iv.custom');
  });

  it('retains a working authorization when a reconnect is cancelled', async () => {
    const id = await connected();
    await start({ connectionId: id });
    await ready(id);
    tokenError = 'access_denied';
    await call('POST', `/git-connections/${id}/device`);
    expect((await row(id)).status).toBe('connected');
    expect(openConnectionSecrets(t.deps, await row(id)).githubDevice?.tokens?.access_token).toBe(
      ACCESS,
    );
  });

  it('refreshes rotating tokens once across parallel callers, without a client secret', async () => {
    const id = await connected();
    const current = await row(id);
    const secrets = openConnectionSecrets(t.deps, current);
    secrets.githubDevice!.tokens!.expires_at = 0;
    await t.db
      .update(schema.gitConnections)
      .set({ secrets: sealConnectionSecrets(t.deps, secrets) })
      .where(eq(schema.gitConnections.id, id));
    const ask = () =>
      t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/relay', write: true }),
      );
    expect(await Promise.all([ask(), ask()])).toEqual([
      { username: 'x-access-token', password: 'ghu_refreshed' },
      { username: 'x-access-token', password: 'ghu_refreshed' },
    ]);
    expect(tokenCalls()).toHaveLength(2); // device exchange + one refresh
    expect(openConnectionSecrets(t.deps, await row(id)).githubDevice?.tokens?.refresh_token).toBe(
      'ghr_rotated',
    );
    const body = new URLSearchParams(String(tokenCalls().at(-1)![1]?.body));
    expect(body.get('refresh_token')).toBe(REFRESH);
    expect(body.has('client_secret')).toBe(false);
  });

  it('uses the device connection for runner clone/fetch and PRs, but never gives a sandbox an unapproved token', async () => {
    await connected();
    const runnerId = crypto.randomUUID();
    runnerSessionIds.set(runnerId, { repoFullName: 'acme/relay', push: false });
    const ask = {
      ownerId: owner.id,
      workspaceId: owner.workspaceId,
      host: 'github.com',
      path: 'acme/relay.git',
      username: 'fetch',
      sessionId: runnerId,
    };
    expect(await t.inOrganization(() => resolveGitCredential(t.deps, ask))).toMatchObject({
      password: ACCESS,
    });
    const session = {
      ...ask,
      sessionId: crypto.randomUUID(),
      session: { repoFullName: 'acme/relay', pushAllowed: false },
    };
    expect(await t.inOrganization(() => resolveGitCredential(t.deps, session))).toHaveProperty(
      'denied',
    );
    expect(
      await t.inOrganization(() => resolveGitCredential(t.deps, { ...session, username: 'push' })),
    ).toHaveProperty('denied');
    expect(
      await t.inOrganization(() =>
        resolveGitCredential(t.deps, {
          ...session,
          username: 'push',
          session: { ...session.session, pushAllowed: true },
        }),
      ),
    ).toMatchObject({ password: ACCESS });
    expect(
      await t.inOrganization(() =>
        resolveGitCredential(t.deps, { ...ask, path: 'acme/other.git' }),
      ),
    ).toHaveProperty('denied');
    expect(await t.inOrganization(() => pullRequestToken(t.deps, owner, 'acme/relay'))).toBe(
      ACCESS,
    );
  });

  it('denies writes/PRs to read-only repositories and tokens for unselected repositories', async () => {
    const id = await connected();
    const current = await row(id);
    expect(
      await t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/read-only', write: false }),
      ),
    ).toMatchObject({ password: ACCESS });
    await expect(
      t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/read-only', write: true }),
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
    await expect(
      t.inOrganization(() => pullRequestToken(t.deps, owner, 'acme/read-only')),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
    await expect(
      t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/hidden', write: false }),
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
  });

  it('does not replace a working connection with a different GitHub account', async () => {
    const id = await connected();
    await start({ connectionId: id });
    await ready(id);
    const original = request.getMockImplementation()!;
    request.mockImplementation((url, init) =>
      new URL(String(url)).pathname === '/user'
        ? Promise.resolve(Response.json({ id: 999, login: 'someone-else' }))
        : original(url, init),
    );
    expect(await (await call('POST', `/git-connections/${id}/device`)).json()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('different GitHub account'),
    });
    expect((await row(id)).accountLogin).toBe('alice');
    expect(openConnectionSecrets(t.deps, await row(id)).githubDevice?.userId).toBe('123');
  });

  it('does not let user admin rights override read-only App installation permissions', async () => {
    installations = [
      { id: 900, app_slug: appSlug, suspended_at: null, permissions: { contents: 'read' } },
    ];
    repos = [
      { id: 1, full_name: 'acme/relay', private: true, permissions: { push: true, admin: true } },
    ];
    const id = await connected();
    const current = await row(id);
    expect(
      await t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/relay', write: false }),
      ),
    ).toMatchObject({ password: ACCESS });
    await expect(
      t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/relay', write: true }),
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
  });

  it('requires reconnect when refresh is rejected without exposing provider secrets', async () => {
    const id = await connected();
    const current = await row(id);
    const secrets = openConnectionSecrets(t.deps, current);
    secrets.githubDevice!.tokens!.expires_at = 0;
    await t.db
      .update(schema.gitConnections)
      .set({ secrets: sealConnectionSecrets(t.deps, secrets) })
      .where(eq(schema.gitConnections.id, id));
    tokenError = 'invalid_grant';
    const response = await call('GET', `/git-connections/${id}/repositories`);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain('GITHUB_DEVICE_REAUTHORIZE');
    expect(body).not.toContain(ACCESS);
    expect(body).not.toContain(REFRESH);
  });

  it('marks a revoked authorization without making up an installation token', async () => {
    const id = await connected();
    apiStatus = 401;
    const synced = await call('POST', `/git-connections/${id}/sync`);
    expect(await synced.json()).toMatchObject({ connection: { status: 'revoked' } });
    expect(tokenCalls()).toHaveLength(1);
  });

  it('syncs changed repository access, never auto-grants a repository the user cannot reach', async () => {
    const id = await connected();
    repos = [{ id: 2, full_name: 'acme/read-only', private: true, permissions: { push: false } }];
    const synced = await call('POST', `/git-connections/${id}/sync`);
    expect(await synced.json()).toMatchObject({
      needsReauthorize: false,
      connection: { status: 'connected' },
    });
    const current = await row(id);
    expect(current.repositories?.map((r) => r.fullName)).toEqual(['acme/read-only']);
    await expect(
      t.inOrganization(() =>
        tokenForConnection(t.deps, current, { repoFullName: 'acme/relay', write: true }),
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
  });
});
