import { createHmac } from 'node:crypto';
import { GITHUB_APP_MANIFEST_EVENTS, GITHUB_APP_WEBHOOK_PATH } from '@openbots/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  fakeRepo,
  jwtValid,
  startFakeGithub,
  type FakeGithub,
} from './__fixtures__/fake-github.js';
import {
  appJwt,
  consumeGithubState,
  createGithubAppService,
  GITHUB_STATE_TTL_MS,
  signGithubState,
  verifyGithubState,
  type GithubApp,
} from './github-app.js';
import { clearGithubApp, loadGithubApp } from './github-app-store.js';

// The GitHub App service (I17) against a fake GitHub: the manifest flow that
// makes and stores a self-hoster's App, installation tokens signed with its
// key and cached per scope, repository listings in pages, and webhooks.

describe('GitHub App service', () => {
  let t: TestApp;
  let github: FakeGithub;
  let service: GithubApp;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_PUBLIC_URL: 'https://bots.example.com' });
    github = await startFakeGithub();
    t.deps.net = { allowPrivateNetwork: true };
    service = createGithubAppService(t.ownerDeps, { apiBase: github.url });
    github.manifests.set('code-1', {
      id: Number(github.appId),
      slug: 'openbots-bots-example',
      pem: github.privateKey,
      client_id: 'Iv1.client',
      client_secret: 'client-secret-value',
      webhook_secret: 'webhook-secret-value',
    });
    github.installations.set('77', {
      login: 'acme',
      type: 'Organization',
      repos: Array.from({ length: 130 }, (_, i) => fakeRepo(`acme/repo-${i}`, 1000 + i)),
    });
  });
  afterAll(async () => {
    await github.close();
    await t.close();
  });

  it('builds the manifest for an https public URL', async () => {
    const { url, manifest } = await service.manifestUrl('state-1');
    expect(url).toBe('https://github.com/settings/apps/new?state=state-1');
    expect(manifest).toMatchObject({
      name: 'OpenBots (bots.example.com)',
      url: 'https://bots.example.com',
      hook_attributes: { url: `https://bots.example.com${GITHUB_APP_WEBHOOK_PATH}` },
      redirect_url: 'https://bots.example.com/api/v1/git-connections/github-app/manifest/callback',
      setup_url: 'https://bots.example.com/api/v1/git-connections/github-app/callback',
      public: false,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
        checks: 'read',
      },
      default_events: [...GITHUB_APP_MANIFEST_EVENTS],
    });
    // GitHub sends installation events to every App; the manifest does not list them.
    expect(manifest.default_events).not.toContain('installation');
    expect(manifest.default_events).not.toContain('installation_repositories');
    // The install asks for the user's authorization, which lands on the install callback.
    expect(manifest.request_oauth_on_install).toBe(true);
    expect((manifest.callback_urls as string[])[0]).toBe(
      'https://bots.example.com/api/v1/git-connections/github-app/callback',
    );
  });

  it('makes the App under an organization when one is named, and refuses a bad name', async () => {
    const { url, manifest } = await service.manifestUrl('state-2', { organization: 'acme-corp' });
    expect(url).toBe('https://github.com/organizations/acme-corp/settings/apps/new?state=state-2');
    expect(manifest.public).toBe(false);
    for (const organization of ['-acme', 'a/b', 'a'.repeat(40), 'acme--corp', '']) {
      await expect(service.manifestUrl('s', { organization })).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_ORGANIZATION',
      });
    }
  });

  it('refuses the manifest without https, on managed, or with a configured App', async () => {
    const withConfig = (over: Partial<TestApp['deps']['config']>) =>
      createGithubAppService({ ...t.ownerDeps, config: { ...t.deps.config, ...over } });
    await expect(
      withConfig({ publicUrl: 'http://localhost:3000' }).manifestUrl('s'),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('OPENBOTS_PUBLIC_URL'),
    });
    await expect(withConfig({ deployment: 'managed' }).manifestUrl('s')).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      withConfig({
        githubApp: { appId: '1', slug: 's', privateKey: 'k', webhookSecret: 'w'.repeat(16) },
      }).manifestUrl('s'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('exchanges the manifest code and stores the App sealed', async () => {
    const app = await service.completeManifest('code-1');
    expect(app).toMatchObject({ appId: github.appId, slug: 'openbots-bots-example' });
    const loaded = await loadGithubApp(t.ownerDeps);
    expect(loaded).toMatchObject({
      source: 'instance',
      app: { appId: github.appId, clientId: 'Iv1.client', webhookSecret: 'webhook-secret-value' },
    });
    // Sealed: the private key is not in the row as text.
    const [row] = await t.db.select().from(schema.instanceSettings);
    expect(row!.value.toString('utf8')).not.toContain('PRIVATE KEY');
    // And now there is one, so the manifest is refused, and so is a second conversion.
    await expect(service.manifestUrl('s')).rejects.toMatchObject({ status: 409 });
    const conversions = github.requests.filter((r) => r.path.startsWith('/app-manifests/')).length;
    await expect(service.completeManifest('code-1')).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_APP_EXISTS',
    });
    expect(github.requests.filter((r) => r.path.startsWith('/app-manifests/')).length).toBe(
      conversions,
    );
    expect(await service.installUrl('st')).toBe(
      'https://github.com/apps/openbots-bots-example/installations/new?state=st',
    );
  });

  it('signs the App JWT with RS256 under the App key', () => {
    const jwt = appJwt({ appId: github.appId, privateKey: github.privateKey }, Date.now());
    expect(jwtValid(jwt, github.publicKey, github.appId)).toBe(true);
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as {
      iat: number;
      exp: number;
    };
    expect(claims.exp - claims.iat).toBe(600);
  });

  it('mints installation tokens per scope and caches them', async () => {
    const before = github.minted.length;
    const read = await service.installationToken('77', {
      repositories: ['acme/repo-1'],
      permissions: { contents: 'read' },
    });
    expect(read.token).toMatch(/^ghs_fake_/);
    expect(read.repositories).toEqual(['acme/repo-1']);
    const sent = github.requests.findLast((r) => r.path === '/app/installations/77/access_tokens');
    expect(sent!.body).toEqual({ repositories: ['repo-1'], permissions: { contents: 'read' } });
    expect(jwtValid(sent!.authorization!.slice(7), github.publicKey, github.appId)).toBe(true);
    // The same scope, in any order or case, comes from the cache.
    const again = await service.installationToken('77', {
      repositories: ['ACME/repo-1'],
      permissions: { contents: 'read' },
    });
    expect(again.token).toBe(read.token);
    expect(github.minted.length).toBe(before + 1);
    // Another scope is another token.
    const write = await service.installationToken('77', {
      repositories: ['acme/repo-1'],
      permissions: { pull_requests: 'write', contents: 'write' },
    });
    expect(write.token).not.toBe(read.token);
    expect(github.minted.length).toBe(before + 2);
  });

  it('mints again once a token is within five minutes of expiring', async () => {
    let clock = Date.now();
    const timed = createGithubAppService(t.ownerDeps, { apiBase: github.url, now: () => clock });
    const scope = { permissions: { contents: 'read' as const } };
    const first = await timed.installationToken('77', scope);
    clock += 50 * 60_000;
    expect((await timed.installationToken('77', scope)).token).toBe(first.token);
    clock += 6 * 60_000;
    expect((await timed.installationToken('77', scope)).token).not.toBe(first.token);
    // Expired tokens of other scopes leave the cache on the next mint.
    clock = Date.now();
    const evicting = createGithubAppService(t.ownerDeps, { apiBase: github.url, now: () => clock });
    await evicting.installationToken('77', { repositories: ['acme/repo-2'], ...scope });
    await evicting.installationToken('77', { repositories: ['acme/repo-3'], ...scope });
    expect(evicting.cachedTokenCount()).toBe(2);
    clock += 56 * 60_000;
    await evicting.installationToken('77', { repositories: ['acme/repo-4'], ...scope });
    expect(evicting.cachedTokenCount()).toBe(1);
  });

  it("reads a user's reach in an installation, revokes the token, and builds the authorize URL", async () => {
    github.userInstallations.set('ghu_reach', ['77']);
    github.userRepos.set('ghu_reach:77', [
      { full_name: 'acme/repo-1', push: true },
      { full_name: 'acme/repo-2', push: false, admin: false },
    ]);
    expect(await service.userInstallationRepos('ghu_reach', '77')).toEqual([
      { fullName: 'acme/repo-1', push: true, admin: false },
      { fullName: 'acme/repo-2', push: false, admin: false },
    ]);
    await service.revokeUserToken('ghu_reach');
    expect(github.revoked).toContain('ghu_reach');
    const revoke = github.requests.findLast((r) => r.method === 'DELETE')!;
    expect(revoke.path).toBe('/applications/Iv1.client/token');
    expect(revoke.authorization).toBe(
      `Basic ${Buffer.from('Iv1.client:client-secret-value').toString('base64')}`,
    );
    const url = new URL(await service.authorizeUrl('st-r', 'https://bots.example.com/cb'));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1.client',
      state: 'st-r',
      redirect_uri: 'https://bots.example.com/cb',
    });
  });

  it('lists every repository of the installation, page by page', async () => {
    const repos = await service.listInstallationRepos('77');
    expect(repos).toHaveLength(130);
    expect(repos[0]).toEqual({
      id: '1000',
      fullName: 'acme/repo-0',
      private: true,
      defaultBranch: 'main',
      description: null,
      pushedAt: '2026-10-01T12:00:00.000Z',
      remembered: false,
    });
    const listed = github.requests.filter((r) => r.path === '/installation/repositories');
    expect(listed.length).toBeGreaterThanOrEqual(2);
    // Listed with a token scoped to metadata only.
    const token = listed.at(-1)!.authorization!.slice(7);
    expect(github.minted.find((m) => m.token === token)!.permissions).toEqual({
      metadata: 'read',
    });
  });

  it('answers a missing installation with a 404 from GitHub', async () => {
    await expect(
      service.installationToken('999', { permissions: { contents: 'read' } }),
    ).rejects.toMatchObject({ githubStatus: 404 });
    expect(await service.installation('77')).toEqual({
      id: '77',
      accountLogin: 'acme',
      accountType: 'organization',
    });
  });

  it('verifies webhook signatures in constant time', async () => {
    const body = Buffer.from('{"action":"created"}');
    const good = `sha256=${createHmac('sha256', 'webhook-secret-value').update(body).digest('hex')}`;
    expect(await service.verifyWebhook(body, good)).toBe(true);
    expect(await service.verifyWebhook(Buffer.from('{"action":"deleted"}'), good)).toBe(false);
    expect(await service.verifyWebhook(body, `sha256=${'0'.repeat(64)}`)).toBe(false);
    expect(await service.verifyWebhook(body, 'sha256=short')).toBe(false);
    expect(await service.verifyWebhook(body, undefined)).toBe(false);
  });

  it('signs flow state bound to the owner, for one purpose, for 10 minutes', () => {
    const owner = { userId: 'u-1', workspaceId: 'w-1' };
    const now = Date.now();
    const state = signGithubState(t.deps.config, 'install', owner, now);
    expect(verifyGithubState(t.deps.config, 'install', state, now)).toMatchObject({
      ...owner,
      purpose: 'install',
      nonce: expect.any(String),
    });
    expect(verifyGithubState(t.deps.config, 'manifest', state, now)).toBe(null);
    expect(verifyGithubState(t.deps.config, ['reauth', 'install'], state, now)).toMatchObject({
      purpose: 'install',
    });
    const reauth = signGithubState(t.deps.config, 'reauth', { ...owner, connectionId: 'c-1' }, now);
    expect(verifyGithubState(t.deps.config, ['install', 'reauth'], reauth, now)).toMatchObject({
      purpose: 'reauth',
      connectionId: 'c-1',
    });
    expect(verifyGithubState(t.deps.config, 'install', state, now + GITHUB_STATE_TTL_MS + 1)).toBe(
      null,
    );
    const [payload, mac] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), u: 'u-2' }),
    ).toString('base64url');
    expect(verifyGithubState(t.deps.config, 'install', `${forged}.${mac}`, now)).toBe(null);
  });

  it('spends a state once, and forgets used nonces once they expire', async () => {
    const now = Date.now();
    const verified = verifyGithubState(
      t.deps.config,
      'install',
      signGithubState(t.deps.config, 'install', { userId: 'u-1', workspaceId: 'w-1' }, now),
      now,
    )!;
    expect(await consumeGithubState(t.ownerDeps, verified, now)).toBe(true);
    expect(await consumeGithubState(t.ownerDeps, verified, now)).toBe(false);
    // Past its expiry the row is swept (the state itself no longer verifies by then).
    await consumeGithubState(
      t.ownerDeps,
      { nonce: 'other', expiresAt: now + 2 * GITHUB_STATE_TTL_MS },
      now + GITHUB_STATE_TTL_MS + 1,
    );
    const left = await t.db.select().from(schema.githubStateNonces);
    expect(left.map((r) => r.nonce)).toEqual(['other']);
  });

  it('forgets a stored App', async () => {
    await clearGithubApp(t.ownerDeps);
    expect(await service.credentials()).toBe(null);
    await expect(service.installUrl('s')).rejects.toMatchObject({ status: 409 });
  });
});
