import { describe, expect, it } from 'vitest';
import {
  OWN_REPOSITORY_ONLY,
  PUSH_NEEDS_APPROVAL,
  resolveGitCredential,
  runnerSessionIds,
  type CredentialAsk,
} from './git-credentials.js';

// The repository scope of the credential helper's answers fails closed: a
// session's git is served only for its own repository, and only when git
// says which (credential.useHttpPath). The owner has no GitHub token and no
// git connection here, so a request that passes the scope check answers
// "Add a GitHub token", or, for a session's fetch, that fetching needs the
// GitHub App.

const NO_ROWS = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
};
const deps = { db: NO_ROWS, config: {}, logger: { warn() {} } } as unknown as Parameters<
  typeof resolveGitCredential
>[0];

const PASSED = /Add a GitHub token|needs a GitHub App connection/;

const ask = (over: Partial<CredentialAsk> = {}): CredentialAsk => ({
  ownerId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  host: 'github.com',
  path: 'acme/app.git',
  username: 'fetch',
  sessionId: 'session-0001',
  session: { pushAllowed: false, repoFullName: 'Acme/App' },
  ...over,
});

const denied = async (over: Partial<CredentialAsk>) =>
  ((await resolveGitCredential(deps, ask(over))) as { denied?: string }).denied;

describe('git credential scope', () => {
  it('serves the session its own repository, with or without .git, in any case', async () => {
    expect(await denied({})).toMatch(PASSED);
    expect(await denied({ path: 'ACME/app' })).toMatch(PASSED);
    expect(await denied({ path: '/acme/app.git/' })).toMatch(PASSED);
  });

  it('denies a request without a path', async () => {
    expect(await denied({ path: undefined })).toBe(OWN_REPOSITORY_ONLY);
  });

  it('denies another repository', async () => {
    expect(await denied({ path: 'acme/other.git' })).toBe(OWN_REPOSITORY_ONLY);
  });

  it('denies a process that is not a session of a repository', async () => {
    expect(await denied({ session: null })).toBe(OWN_REPOSITORY_ONLY);
    expect(await denied({ session: { pushAllowed: true, repoFullName: null } })).toBe(
      OWN_REPOSITORY_ONLY,
    );
  });

  it('denies hosts other than github.com, the API host included', async () => {
    expect(await denied({ host: 'api.github.com' })).toMatch(/no credential/);
    expect(await denied({ host: 'gitlab.com' })).toMatch(/no credential/);
  });

  it('still gates the push', async () => {
    expect(await denied({ username: 'push' })).toBe(PUSH_NEEDS_APPROVAL);
  });

  it("serves the runner's own git for its repository only, while it runs", async () => {
    const id = 'runner-test-0001';
    const runner = { sessionId: id, session: null };
    runnerSessionIds.set(id, { repoFullName: 'acme/app', push: false });
    try {
      expect(await denied(runner)).toMatch(PASSED);
      // The runner gets the same host and path check as a session.
      expect(await denied({ ...runner, path: undefined })).toBe(OWN_REPOSITORY_ONLY);
      expect(await denied({ ...runner, path: 'acme/other.git' })).toBe(OWN_REPOSITORY_ONLY);
      expect(await denied({ ...runner, host: 'gitlab.com' })).toMatch(/no credential/);
      // A clone or fetch gets fetch only.
      expect(await denied({ ...runner, username: 'push' })).toBe(PUSH_NEEDS_APPROVAL);
    } finally {
      runnerSessionIds.delete(id);
    }
    expect(await denied({ ...runner, username: 'fetch' })).toBe(OWN_REPOSITORY_ONLY);
  });

  it("serves the runner's approved push, and a runner without a repository nothing", async () => {
    runnerSessionIds.set('runner-push', { repoFullName: 'acme/app', push: true });
    runnerSessionIds.set('runner-none', { repoFullName: null, push: true });
    try {
      expect(await denied({ sessionId: 'runner-push', session: null, username: 'push' })).toMatch(
        PASSED,
      );
      expect(await denied({ sessionId: 'runner-none', session: null })).toBe(OWN_REPOSITORY_ONLY);
    } finally {
      runnerSessionIds.delete('runner-push');
      runnerSessionIds.delete('runner-none');
    }
  });
});
