import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test-app.js';
import {
  FETCH_NEEDS_APP,
  githubTokenFor,
  OWN_REPOSITORY_ONLY,
  PUSH_NEEDS_APPROVAL,
  resolveGitCredential,
  runnerSessionIds,
} from './git-credentials.js';
import { credentialAsk } from './__fixtures__/credential-ask.js';

// Git credentials (I5, GH7): with no git connection, the owner's GitHub
// connector token, served to the runner's own git, and to a session only for
// its approved push, and only for the session's own repository. The GitHub
// App's narrowed tokens are in git-credentials-app.test.ts.

describe('git credentials', () => {
  let t: TestApp;
  let ownerId: string;
  let workspaceId: string;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_SIGNUP_MODE: 'open' });
    cookie = (await t.signUp('git@example.com')).cookie!;
    ownerId = await t.userId('git@example.com');
    workspaceId = await t.defaultOrganization();
  });
  afterAll(() => t.close());

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const ask = credentialAsk(() => ({ ownerId, workspaceId }), {
    sessionId: '7a1e3c3a-9b0e-4a8e-8d7c-1b2c3d4e5f60',
  });

  it('says so when the owner has no GitHub token', async () => {
    expect(await t.inOrganization(() => githubTokenFor(t.deps, { id: ownerId, workspaceId }))).toBe(
      null,
    );
    const answer = await resolveGitCredential(
      t.ownerDeps,
      ask({ username: 'push', session: { pushAllowed: true, repoFullName: 'acme/relay' } }),
    );
    expect(answer).toMatchObject({ denied: expect.stringContaining('Connectors') });
  });

  it("serves fetch, gates push on the session's approval, and serves the runner", async () => {
    const res = await call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-secret-token' },
    });
    expect(res.status).toBe(201);
    const token = { username: 'x-access-token', password: 'ghp-secret-token' };

    // The connector token cannot be narrowed: a session gets it for its allowed push only.
    expect(await resolveGitCredential(t.ownerDeps, ask())).toEqual({ denied: FETCH_NEEDS_APP });
    expect(await resolveGitCredential(t.ownerDeps, ask({ username: 'push' }))).toEqual({
      denied: PUSH_NEEDS_APPROVAL,
    });
    expect(await resolveGitCredential(t.ownerDeps, ask({ username: undefined }))).toMatchObject({
      denied: expect.any(String),
    });
    expect(
      await resolveGitCredential(
        t.ownerDeps,
        ask({ username: 'push', session: { pushAllowed: true, repoFullName: 'acme/relay' } }),
      ),
    ).toEqual(token);
    expect(
      await resolveGitCredential(
        t.ownerDeps,
        ask({ session: { pushAllowed: true, repoFullName: 'acme/relay' } }),
      ),
    ).toMatchObject({ denied: expect.stringContaining('push url') });
    // The runner's own fetch is served.
    runnerSessionIds.set('runner-0', { repoFullName: 'acme/relay', push: false });
    try {
      expect(
        await resolveGitCredential(t.ownerDeps, ask({ sessionId: 'runner-0', session: null })),
      ).toEqual(token);
    } finally {
      runnerSessionIds.delete('runner-0');
    }
    // Another repository, or no path at all, is refused to a session.
    expect(await resolveGitCredential(t.ownerDeps, ask({ path: 'acme/other.git' }))).toEqual({
      denied: OWN_REPOSITORY_ONLY,
    });
    // Another host has no credential.
    expect(await resolveGitCredential(t.ownerDeps, ask({ host: 'gitlab.com' }))).toMatchObject({
      denied: expect.stringContaining('gitlab.com'),
    });
    // The runner's own push, once approved, is served for its repository.
    runnerSessionIds.set('runner-1', { repoFullName: 'acme/relay', push: true });
    try {
      expect(
        await resolveGitCredential(
          t.ownerDeps,
          ask({ sessionId: 'runner-1', username: 'push', session: null }),
        ),
      ).toEqual(token);
    } finally {
      runnerSessionIds.delete('runner-1');
    }
  });
});
