import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { encryptSecret, keyringFromConfig } from '../secrets.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { fakeRepo, startFakeGithub, type FakeGithub } from './__fixtures__/fake-github.js';
import {
  FETCH_NEEDS_APP,
  PUSH_NEEDS_APPROVAL,
  pullRequestToken,
  resolveGitCredential,
  runnerSessionIds,
  type CredentialAsk,
} from './git-credentials.js';
import { connectionAllows, tokenForConnection } from './git-connections.js';
import { createGithubAppService, useGithubAppService } from './github-app.js';
import { credentialAsk } from './__fixtures__/credential-ask.js';

// Git credentials through a git connection (GH7, I17). A GitHub App
// connection mints a token narrowed to the session's repository: contents
// read for a fetch, contents and pull requests write only once the push is
// allowed. A token connection, which GitHub cannot narrow, is denied to a
// session until its push is allowed. The runner's rescue push registers
// `write: true`.

describe('git credentials through a connection', () => {
  let t: TestApp;
  let github: FakeGithub;
  let ownerId: string;
  let workspaceId: string;
  let appConnectionId: string;

  beforeAll(async () => {
    github = await startFakeGithub();
    t = await createTestApp({
      OPENBOTS_SIGNUP_MODE: 'open',
      GITHUB_APP_ID: github.appId,
      GITHUB_APP_SLUG: 'openbots-test',
      GITHUB_APP_PRIVATE_KEY: github.privateKey,
      GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret-value',
    });
    t.deps.net = { allowPrivateNetwork: true };
    useGithubAppService(t.deps, createGithubAppService(t.ownerDeps, { apiBase: github.url }));
    github.installations.set('501', {
      login: 'acme',
      type: 'Organization',
      repos: [fakeRepo('acme/relay', 1), fakeRepo('acme/docs', 2), fakeRepo('acme/secret', 3)],
    });
    await t.signUp('gitapp@example.com');
    ownerId = await t.userId('gitapp@example.com');
    workspaceId = await t.defaultOrganization();
    const [app] = await t.db
      .insert(schema.gitConnections)
      .values({
        workspaceId,
        ownerId,
        kind: 'app',
        installationId: '501',
        accountLogin: 'acme',
        accountType: 'organization',
        // The owner's own reach (H1): relay with push, docs read only.
        repositories: [
          { fullName: 'acme/relay', push: true, admin: false },
          { fullName: 'acme/docs', push: false, admin: false },
        ],
      })
      .returning();
    appConnectionId = app!.id;
    const [tokenConnection] = await t.db
      .insert(schema.gitConnections)
      .values({
        workspaceId,
        ownerId,
        kind: 'token',
        accountLogin: 'solo',
        secrets: encryptSecret(
          JSON.stringify({ token: 'github_pat_pasted' }),
          keyringFromConfig(t.deps.config),
        ),
      })
      .returning();
    await t.db.insert(schema.repos).values([
      {
        workspaceId,
        ownerId,
        connectionId: app!.id,
        fullName: 'acme/relay',
        remoteUrl: 'https://github.com/acme/relay.git',
      },
      {
        workspaceId,
        ownerId,
        connectionId: tokenConnection!.id,
        fullName: 'solo/tool',
        remoteUrl: 'https://github.com/solo/tool.git',
      },
    ]);
  });
  afterAll(async () => {
    await github.close();
    await t.close();
  });

  const ask = credentialAsk(() => ({ ownerId, workspaceId }), {
    sessionId: '0d9c3b2a-1e4f-4a5b-8c7d-6e5f4a3b2c1d',
  });
  const mintedFor = (password: string) => github.minted.find((m) => m.token === password);

  it("serves a session's fetch an App token with contents read, for its repository only", async () => {
    const answer = await resolveGitCredential(t.ownerDeps, ask());
    expect(answer).toMatchObject({ username: 'x-access-token' });
    const minted = mintedFor((answer as { password: string }).password)!;
    expect(minted.permissions).toEqual({ contents: 'read' });
    expect(minted.repositories).toEqual(['relay']);
    expect(minted.installationId).toBe('501');
  });

  it('denies the push before approval, and mints a write token after', async () => {
    expect(await resolveGitCredential(t.ownerDeps, ask({ username: 'push' }))).toEqual({
      denied: PUSH_NEEDS_APPROVAL,
    });
    const answer = await resolveGitCredential(
      t.ownerDeps,
      ask({ username: 'push', session: { pushAllowed: true, repoFullName: 'acme/relay' } }),
    );
    const minted = mintedFor((answer as { password: string }).password)!;
    expect(minted.permissions).toEqual({ contents: 'write', pull_requests: 'write' });
    expect(minted.repositories).toEqual(['relay']);
  });

  it('denies a token connection to a session until its push is allowed', async () => {
    const tool = {
      path: 'solo/tool.git',
      session: { pushAllowed: false, repoFullName: 'solo/tool' },
    };
    expect(await resolveGitCredential(t.ownerDeps, ask(tool))).toEqual({ denied: FETCH_NEEDS_APP });
    expect(await resolveGitCredential(t.ownerDeps, ask({ ...tool, username: 'push' }))).toEqual({
      denied: PUSH_NEEDS_APPROVAL,
    });
    expect(
      await resolveGitCredential(
        t.ownerDeps,
        ask({
          ...tool,
          username: 'push',
          session: { pushAllowed: true, repoFullName: 'solo/tool' },
        }),
      ),
    ).toEqual({ username: 'x-access-token', password: 'github_pat_pasted' });
  });

  it("serves the runner's rescue push, registered with write, a write token", async () => {
    runnerSessionIds.set('rescue-1', { repoFullName: 'acme/relay', push: false, write: true });
    runnerSessionIds.set('fetch-1', { repoFullName: 'acme/relay', push: false });
    try {
      const rescue = await resolveGitCredential(
        t.ownerDeps,
        ask({ sessionId: 'rescue-1', session: null, username: 'push' }),
      );
      expect(mintedFor((rescue as { password: string }).password)!.permissions).toEqual({
        contents: 'write',
        pull_requests: 'write',
      });
      const fetched = await resolveGitCredential(
        t.ownerDeps,
        ask({ sessionId: 'fetch-1', session: null }),
      );
      expect(mintedFor((fetched as { password: string }).password)!.permissions).toEqual({
        contents: 'read',
      });
      expect(
        await resolveGitCredential(
          t.ownerDeps,
          ask({ sessionId: 'fetch-1', session: null, username: 'push' }),
        ),
      ).toEqual({ denied: PUSH_NEEDS_APPROVAL });
    } finally {
      runnerSessionIds.delete('rescue-1');
      runnerSessionIds.delete('fetch-1');
    }
  });

  it("holds an App connection to the owner's own reach in the installation (H1)", async () => {
    const at = (repoFullName: string, over: Partial<CredentialAsk> = {}) =>
      ask({ path: `${repoFullName}.git`, session: { pushAllowed: false, repoFullName }, ...over });
    // In the installation, but not in the owner's list: no token at all.
    await t.db.insert(schema.repos).values({
      workspaceId,
      ownerId,
      connectionId: appConnectionId,
      fullName: 'acme/secret',
      remoteUrl: 'https://github.com/acme/secret.git',
    });
    const minted = github.minted.length;
    expect(await resolveGitCredential(t.ownerDeps, at('acme/secret'))).toEqual({
      denied: expect.stringContaining('does not include acme/secret'),
    });
    // Read only for the owner: a fetch is read, a push is refused.
    const docs = await resolveGitCredential(t.ownerDeps, at('acme/docs'));
    expect(mintedFor((docs as { password: string }).password)!.permissions).toEqual({
      contents: 'read',
    });
    const pushAllowed = { pushAllowed: true, repoFullName: 'acme/docs' };
    expect(
      await resolveGitCredential(
        t.ownerDeps,
        at('acme/docs', { username: 'push', session: pushAllowed }),
      ),
    ).toEqual({ denied: 'You can read acme/docs on GitHub but not push to it' });
    // A fetch in a session allowed to push still gets read.
    const fetched = await resolveGitCredential(
      t.ownerDeps,
      at('acme/docs', { session: pushAllowed }),
    );
    expect(mintedFor((fetched as { password: string }).password)!.permissions).toEqual({
      contents: 'read',
    });
    // One read token for docs (the second came from the cache); none for secret.
    expect(github.minted.length).toBe(minted + 1);
    await expect(
      pullRequestToken(t.ownerDeps, { id: ownerId, workspaceId }, 'acme/docs'),
    ).rejects.toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
  });

  it("refuses an App token for another account's repository, or before the owner's reach is read", async () => {
    const [row] = await t.db
      .select()
      .from(schema.gitConnections)
      .where(eq(schema.gitConnections.id, appConnectionId));
    await expect(
      tokenForConnection(t.ownerDeps, row!, { repoFullName: 'evil/relay', write: false }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_NO_ACCESS',
      message: expect.stringContaining('acme'),
    });
    await expect(
      tokenForConnection(
        t.ownerDeps,
        { ...row!, repositories: null },
        {
          repoFullName: 'acme/relay',
          write: false,
        },
      ),
    ).rejects.toMatchObject({
      code: 'CONNECTION_NO_ACCESS',
      message: expect.stringContaining('Authorize'),
    });
    expect(await connectionAllows(t.ownerDeps, appConnectionId, 'acme/relay')).toEqual({
      read: true,
      write: true,
    });
    expect(await connectionAllows(t.ownerDeps, appConnectionId, 'ACME/docs')).toEqual({
      read: true,
      write: false,
    });
    expect(await connectionAllows(t.ownerDeps, appConnectionId, 'acme/secret')).toEqual({
      read: false,
      write: false,
    });
    expect(await connectionAllows(t.ownerDeps, appConnectionId, 'other/relay')).toEqual({
      read: false,
      write: false,
    });
    expect(
      await connectionAllows(
        t.ownerDeps,
        appConnectionId,
        'acme/relay',
        '0d9c3b2a-1e4f-4a5b-8c7d-6e5f4a3b2c1d',
      ),
    ).toBeNull();
  });

  it('opens pull requests as the App, or as the owner when the owner has no OAuth token yet', async () => {
    const owner = { id: ownerId, workspaceId };
    const asApp = await pullRequestToken(t.ownerDeps, owner, 'acme/relay');
    expect(mintedFor(asApp!)!.permissions).toEqual({ pull_requests: 'write' });
    await t.db.update(schema.gitConnections).set({ actAs: 'owner' });
    // No OAuth connector: the App opens it still.
    const fallback = await pullRequestToken(t.ownerDeps, owner, 'acme/relay');
    expect(mintedFor(fallback!)).toBeDefined();
    expect(await pullRequestToken(t.ownerDeps, owner, 'solo/tool')).toBe('github_pat_pasted');
    expect(appConnectionId).toBeTruthy();
  });
});
