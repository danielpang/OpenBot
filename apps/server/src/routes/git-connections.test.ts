import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import {
  fakeRepo,
  startFakeGithub,
  type FakeGithub,
} from '../services/__fixtures__/fake-github.js';
import {
  createGithubAppService,
  signGithubState,
  useGithubAppService,
} from '../services/github-app.js';
import { createTestApp, type TestApp } from '../test-app.js';

// The git connection routes (GH1, GH2, GH8; I17) on a managed install with
// the shared App from GITHUB_APP_*: owner scoping, the install callback's
// state binding and its check that the user's own GitHub authorization lists
// the installation, and the admin-only App routes.

describe('git connection routes', () => {
  let t: TestApp;
  let github: FakeGithub;
  let alice: string; // the organization's owner
  let bob: string; // a member
  let aliceId: string;
  let bobId: string;
  let workspaceId: string;

  beforeAll(async () => {
    github = await startFakeGithub();
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_STDIO_RUNNER: 'computer',
      OPENBOTS_SIGNUP_MODE: 'open',
      GITHUB_APP_ID: github.appId,
      GITHUB_APP_SLUG: 'openbots-test',
      GITHUB_APP_PRIVATE_KEY: github.privateKey,
      GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret-value',
      GITHUB_APP_CLIENT_ID: 'Iv1.client',
      GITHUB_APP_CLIENT_SECRET: 'client-secret-value',
    });
    t.deps.net = { allowPrivateNetwork: true };
    useGithubAppService(
      t.deps,
      createGithubAppService(t.deps, { apiBase: github.url, webBase: github.url }),
    );
    alice = (await t.signUp('alice@example.com')).cookie!;
    bob = (await t.signUp('bob@example.com')).cookie!;
    aliceId = await t.userId('alice@example.com');
    bobId = await t.userId('bob@example.com');
    workspaceId = await t.defaultOrganization();
    github.installations.set('900', {
      login: 'acme',
      type: 'Organization',
      repos: [fakeRepo('acme/relay', 1), fakeRepo('acme/site', 2, { private: false })],
    });
    github.installations.set('901', { login: 'other', type: 'User', repos: [] });
    github.users.set('github_pat_bob', { login: 'bob', repos: [fakeRepo('bob/tool', 3)] });
    // Alice's GitHub authorization reaches installation 900 only; Bob's too.
    github.codes.set('code-alice', 'ghu_alice');
    github.codes.set('code-alice-2', 'ghu_alice');
    github.userInstallations.set('ghu_alice', ['900']);
    github.codes.set('code-bob', 'ghu_bob');
    github.userInstallations.set('ghu_bob', ['900']);
    // Bob reaches only acme/site there, and cannot push to it.
    github.userRepos.set('ghu_bob:900', [{ full_name: 'acme/site', push: false }]);
    github.codes.set('code-bob-again', 'ghu_bob_2');
    github.userInstallations.set('ghu_bob_2', ['900']);
  });
  afterAll(async () => {
    await github.close();
    await t.close();
  });

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const installState = (userId: string) =>
    signGithubState(t.deps.config, 'install', { userId, workspaceId });
  const callback = (cookie: string, query: Record<string, string>) =>
    call(cookie, 'GET', `/git-connections/github-app/callback?${new URLSearchParams(query)}`);

  it('says which App the install has', async () => {
    const res = await call(alice, 'GET', '/git-connections/github-app');
    expect(await res.json()).toEqual({
      deviceFlowAvailable: true,
      deviceAppSlug: 'openbots-github',
      deviceInstallationUrl: 'https://github.com/apps/openbots-github/installations/new',
      configured: true,
      source: 'config',
      slug: 'openbots-test',
      installUrlAvailable: true,
      manifestAvailable: false,
      publicUrlOk: t.deps.config.publicUrl.startsWith('https:'),
    });
  });

  it('keeps the App routes that change the install to admins', async () => {
    expect((await call(bob, 'POST', '/git-connections/github-app/manifest', {})).status).toBe(403);
    expect((await call(bob, 'DELETE', '/git-connections/github-app')).status).toBe(403);
    // An admin is refused too, here: the App comes from the configuration.
    expect((await call(alice, 'POST', '/git-connections/github-app/manifest', {})).status).toBe(
      409,
    );
    expect((await call(alice, 'DELETE', '/git-connections/github-app')).status).toBe(409);
    // The manifest callback re-checks that the state's user is an admin.
    const bobState = signGithubState(t.deps.config, 'manifest', { userId: bobId, workspaceId });
    const res = await call(
      bob,
      'GET',
      `/git-connections/github-app/manifest/callback?code=x&state=${encodeURIComponent(bobState)}`,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Only an admin');
  });

  it('redirects to the install page with a signed state', async () => {
    const res = await call(alice, 'GET', '/git-connections/github-app/install');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/apps/openbots-test/installations/new');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it("refuses a callback with another owner's state, a forged state, or no code", async () => {
    const res = await callback(bob, {
      installation_id: '900',
      code: 'code-bob',
      state: installState(aliceId),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('another account');
    expect(
      (await callback(alice, { installation_id: '900', code: 'code-alice', state: 'forged.state' }))
        .status,
    ).toBe(400);
    expect(
      (await callback(alice, { installation_id: '900', state: installState(aliceId) })).status,
    ).toBe(400);
    expect(await t.db.select().from(schema.gitConnections)).toEqual([]);
  });

  it("refuses an installation the user's GitHub authorization does not list", async () => {
    const res = await callback(alice, {
      installation_id: '901',
      code: 'code-alice',
      state: installState(aliceId),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('This installation is not yours');
    expect(await t.db.select().from(schema.gitConnections)).toEqual([]);
  });

  it('binds an installation the user can reach, and lists its repositories', async () => {
    const res = await callback(alice, {
      installation_id: '900',
      setup_action: 'install',
      code: 'code-alice-2',
      state: installState(aliceId),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/connectors');
    const id = location.searchParams.get('connection')!;
    const list = (await (await call(alice, 'GET', '/git-connections')).json()) as {
      connections: unknown[];
    };
    expect(list.connections).toEqual([
      expect.objectContaining({
        id,
        kind: 'app',
        installationId: '900',
        accountLogin: 'acme',
        accountType: 'organization',
        actAs: 'bot',
        status: 'connected',
        lastSyncedAt: expect.any(String),
        repoCount: 0,
      }),
    ]);
    await t.db.insert(schema.repos).values({
      workspaceId,
      ownerId: aliceId,
      connectionId: id,
      fullName: 'acme/relay',
      remoteUrl: 'https://github.com/acme/relay.git',
    });
    const repos = await call(alice, 'GET', `/git-connections/${id}/repositories?q=rel`);
    expect(await repos.json()).toEqual({
      repositories: [
        {
          fullName: 'acme/relay',
          private: true,
          defaultBranch: 'main',
          description: null,
          pushedAt: '2026-10-01T12:00:00.000Z',
          remembered: true,
        },
      ],
    });
    // Alice's user token was read once and revoked; her reach is stored.
    expect(github.revoked).toContain('ghu_alice');
    const [alices] = await t.db
      .select()
      .from(schema.gitConnections)
      .where(eq(schema.gitConnections.id, id));
    expect(alices!.repositories).toEqual([
      { fullName: 'acme/relay', push: true, admin: false },
      { fullName: 'acme/site', push: true, admin: false },
    ]);

    // Bob, whose GitHub reaches it too, connects it as well, held to his own reach.
    const bobs = await callback(bob, {
      installation_id: '900',
      code: 'code-bob',
      state: installState(bobId),
    });
    expect(bobs.status).toBe(302);
    const bobConnection = new URL(bobs.headers.get('location')!).searchParams.get('connection')!;
    expect(bobConnection).not.toBe(id);
    const bobRepos = (await (
      await call(bob, 'GET', `/git-connections/${bobConnection}/repositories`)
    ).json()) as { repositories: { fullName: string }[] };
    expect(bobRepos.repositories.map((r) => r.fullName)).toEqual(['acme/site']);
    expect(github.revoked).toContain('ghu_bob');
  });

  it('spends an install state once', async () => {
    const state = installState(bobId);
    github.codes.set('code-bob-replay', 'ghu_bob');
    const first = await callback(bob, { installation_id: '900', code: 'code-bob-replay', state });
    expect(first.status).toBe(302);
    const replayed = await callback(bob, {
      installation_id: '900',
      code: 'code-bob-replay',
      state,
    });
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain('used already');
  });

  it('reauthorizes an App connection to read its reach again, and says a sync needs it', async () => {
    const [row] = await t.db
      .select()
      .from(schema.gitConnections)
      .where(eq(schema.gitConnections.ownerId, bobId));
    const synced = await call(bob, 'POST', `/git-connections/${row!.id}/sync`);
    expect(await synced.json()).toMatchObject({
      connection: { id: row!.id, status: 'connected' },
      needsReauthorize: true,
    });
    // Another owner's connection: 404.
    expect((await call(alice, 'GET', `/git-connections/${row!.id}/reauthorize`)).status).toBe(404);
    const res = await call(bob, 'GET', `/git-connections/${row!.id}/reauthorize`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.client');
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${t.deps.config.publicUrl.replace(/\/+$/, '')}/api/v1/git-connections/github-app/callback`,
    );
    const state = location.searchParams.get('state')!;
    // Bob's access grew on GitHub; the reauthorization's callback reads it again.
    github.userRepos.set('ghu_bob_2:900', [
      { full_name: 'acme/site', push: true },
      { full_name: 'acme/relay', push: false },
    ]);
    const back = await callback(bob, { code: 'code-bob-again', state });
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get('location')!).searchParams.get('connection')).toBe(row!.id);
    const [after] = await t.db
      .select()
      .from(schema.gitConnections)
      .where(eq(schema.gitConnections.id, row!.id));
    expect(after!.repositories).toEqual([
      { fullName: 'acme/site', push: true, admin: false },
      { fullName: 'acme/relay', push: false, admin: false },
    ]);
    expect(github.revoked).toContain('ghu_bob_2');
    // The state was for Bob's connection and is spent.
    expect((await callback(bob, { code: 'code-bob-again', state })).status).toBe(400);
  });

  it("keeps each owner's connections to themselves", async () => {
    const made = await call(bob, 'POST', '/git-connections/token', { token: 'github_pat_bob' });
    expect(made.status).toBe(201);
    const { connection } = (await made.json()) as { connection: { id: string; kind: string } };
    expect(connection).toMatchObject({ kind: 'token', accountLogin: 'bob' });
    expect(JSON.stringify(connection)).not.toContain('github_pat_bob');
    expect(
      (await call(bob, 'POST', '/git-connections/token', { token: 'github_pat_wrong' })).status,
    ).toBe(400);

    const id = connection.id;
    expect((await call(alice, 'GET', `/git-connections/${id}/repositories`)).status).toBe(404);
    expect((await call(alice, 'PATCH', `/git-connections/${id}`, { actAs: 'owner' })).status).toBe(
      404,
    );
    expect((await call(alice, 'POST', `/git-connections/${id}/sync`)).status).toBe(404);
    expect((await call(alice, 'DELETE', `/git-connections/${id}`)).status).toBe(404);
    const bobs = (await (await call(bob, 'GET', '/git-connections')).json()) as {
      connections: { id: string; kind: string }[];
    };
    expect(bobs.connections.map((c) => c.id)).toContain(id);
    expect(bobs.connections.every((c) => c.kind === 'app' || c.id === id)).toBe(true);

    // Who opens pull requests is an App connection's choice only.
    expect((await call(bob, 'PATCH', `/git-connections/${id}`, { actAs: 'owner' })).status).toBe(
      400,
    );
    const bobApp = bobs.connections.find((c) => c.kind === 'app')!;
    const noSignIn = await call(bob, 'PATCH', `/git-connections/${bobApp.id}`, { actAs: 'owner' });
    expect(noSignIn.status).toBe(409);
    expect(await noSignIn.json()).toMatchObject({
      code: 'ACT_AS_NEEDS_SIGN_IN',
      title: 'Connect GitHub sign-in under Connectors to open pull requests as you',
    });
    const asBot = await call(bob, 'PATCH', `/git-connections/${bobApp.id}`, { actAs: 'bot' });
    expect(((await asBot.json()) as { connection: { actAs: string } }).connection.actAs).toBe(
      'bot',
    );
    const repos = await call(bob, 'GET', `/git-connections/${id}/repositories`);
    expect(((await repos.json()) as { repositories: unknown[] }).repositories).toHaveLength(1);
  });

  it('marks a removed installation as needing a reinstall, and forgets a connection', async () => {
    const [row] = await t.db
      .select()
      .from(schema.gitConnections)
      .where(eq(schema.gitConnections.ownerId, aliceId));
    github.installations.delete('900');
    // A fresh service, so no cached token stands in for the installation.
    useGithubAppService(
      t.deps,
      createGithubAppService(t.deps, { apiBase: github.url, webBase: github.url }),
    );
    const synced = await call(alice, 'POST', `/git-connections/${row!.id}/sync`);
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { connection: { status: string } }).connection.status).toBe(
      'needs_reinstall',
    );
    expect((await call(alice, 'DELETE', `/git-connections/${row!.id}`)).status).toBe(204);
    const [repo] = await t.db.select().from(schema.repos).where(eq(schema.repos.ownerId, aliceId));
    expect(repo).toMatchObject({ fullName: 'acme/relay', connectionId: null });
  });
});

// A self-hosted install making its own App (M1, M2): under an organization
// when one is named, never over an existing App, and each flow's state once.
describe('the manifest flow on a self-hosted install', () => {
  let t: TestApp;
  let github: FakeGithub;
  let admin: string;
  let adminId: string;
  let workspaceId: string;

  beforeAll(async () => {
    github = await startFakeGithub();
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'self_hosted',
      OPENBOTS_PUBLIC_URL: 'https://bots.example.com',
      OPENBOTS_SIGNUP_MODE: 'open',
    });
    t.deps.net = { allowPrivateNetwork: true };
    useGithubAppService(
      t.deps,
      createGithubAppService(t.ownerDeps, { apiBase: github.url, webBase: github.url }),
    );
    admin = (await t.signUp('root@example.com')).cookie!;
    adminId = await t.userId('root@example.com');
    workspaceId = await t.defaultOrganization();
    for (const code of ['m-1', 'm-2']) {
      github.manifests.set(code, {
        id: Number(github.appId),
        slug: `openbots-${code}`,
        pem: github.privateKey,
        client_id: 'Iv1.client',
        client_secret: 'client-secret-value',
        webhook_secret: 'webhook-secret-value',
      });
    }
  });
  afterAll(async () => {
    await github.close();
    await t.close();
  });

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie: admin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const manifestCallback = (code: string, state: string) =>
    call(
      'GET',
      `/git-connections/github-app/manifest/callback?${new URLSearchParams({ code, state })}`,
    );

  it('offers the manifest flow with an https public URL, under an organization when named', async () => {
    const status = (await (await call('GET', '/git-connections/github-app')).json()) as {
      manifestAvailable: boolean;
      publicUrlOk: boolean;
    };
    expect(status).toMatchObject({ manifestAvailable: true, publicUrlOk: true });
    const personal = (await (
      await call('POST', '/git-connections/github-app/manifest', {})
    ).json()) as {
      url: string;
      manifest: { public: boolean; default_events: string[] };
    };
    expect(new URL(personal.url).pathname).toBe('/settings/apps/new');
    expect(personal.manifest.public).toBe(false);
    expect(personal.manifest.default_events).not.toContain('installation');
    const org = (await (
      await call('POST', '/git-connections/github-app/manifest', { organization: 'acme' })
    ).json()) as { url: string };
    expect(new URL(org.url).pathname).toBe('/organizations/acme/settings/apps/new');
    expect(
      (await call('POST', '/git-connections/github-app/manifest', { organization: 'a/b' })).status,
    ).toBe(400);
  });

  it('stores the App once: a replayed state and a second App are refused', async () => {
    const state = signGithubState(t.deps.config, 'manifest', { userId: adminId, workspaceId });
    const made = await manifestCallback('m-1', state);
    expect(made.status).toBe(302);
    expect(new URL(made.headers.get('location')!).searchParams.get('github_app')).toBe('created');
    const replayed = await manifestCallback('m-1', state);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain('used already');
    const fresh = signGithubState(t.deps.config, 'manifest', { userId: adminId, workspaceId });
    const second = await manifestCallback('m-2', fresh);
    expect(second.status).toBe(409);
    const [row] = await t.db.select().from(schema.instanceSettings);
    expect(row).toBeDefined();
    const status = (await (await call('GET', '/git-connections/github-app')).json()) as {
      slug: string;
    };
    expect(status.slug).toBe('openbots-m-1');
  });
});
