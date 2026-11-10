import { createAgentClient } from '@openbots/computer';
import { startFakeAgent, type FakeAgent } from '@openbots/computer/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { writeGitIdentity, type GitIdentity } from '../services/git-identity.js';
import { sessionIdentity } from '../services/session-git.js';
import { createTestApp, type TestApp } from '../test-app.js';

// The owner's git identity (GH8): what GET and PUT /git-identity say and
// refuse, who a session's commits are by in each mode, and the git config
// written on the computer.

describe('git identity routes', () => {
  let t: TestApp;
  let alice: string;
  let aliceId: string;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp();
    alice = (await t.signUp('alice@example.com')).cookie!;
    aliceId = await t.userId('alice@example.com');
    workspaceId = await t.defaultOrganization();
  });
  afterAll(() => t.close());

  const call = (method: string, body?: unknown) =>
    t.app.request('/api/v1/git-identity', {
      method,
      headers: { cookie: alice, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bot = { name: 'Software Engineer', handle: 'software-engineer' };
  const identityFor = () =>
    t.inOrganization(() => sessionIdentity(t.deps, bot, aliceId, workspaceId), workspaceId);

  it('starts as the Bot with nothing saved and the account as the fallback', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      commitAs: 'bot',
      name: null,
      email: null,
      account: { email: 'alice@example.com' },
    });
  });

  it('refuses an email that is not one, and treats blanks as not set', async () => {
    const bad = await call('PUT', { commitAs: 'bot', name: 'Alice', email: 'not an email' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'GIT_IDENTITY_EMAIL_INVALID' });

    const blank = await call('PUT', { commitAs: 'bot', name: '  ', email: '' });
    expect(blank.status).toBe(200);
    expect(await blank.json()).toMatchObject({ name: null, email: null, computer: 'off' });
  });

  it('credits the saved identity as co-author while the Bot commits', async () => {
    const res = await call('PUT', {
      commitAs: 'bot',
      name: 'Alice Smith',
      email: '1+alice@users.noreply.github.com',
    });
    expect(res.status).toBe(200);
    expect(await identityFor()).toEqual({
      gitIdentity: {
        name: 'Software Engineer (OpenBots)',
        email: 'software-engineer@openbots.local',
      },
      coAuthor: { name: 'Alice Smith', email: '1+alice@users.noreply.github.com' },
    });
  });

  it('makes the owner the author, with no co-author, when committing as the owner', async () => {
    const res = await call('PUT', {
      commitAs: 'owner',
      name: 'Alice Smith',
      email: '1+alice@users.noreply.github.com',
    });
    expect(res.status).toBe(200);
    expect(await identityFor()).toEqual({
      gitIdentity: { name: 'Alice Smith', email: '1+alice@users.noreply.github.com' },
    });
  });

  it('needs a real email to commit as the owner when the account has only the local one', async () => {
    await t.db
      .update(schema.users)
      .set({ email: 'owner@openbots.local' })
      .where(eq(schema.users.id, aliceId));
    const res = await call('PUT', { commitAs: 'owner', name: 'Alice', email: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'GIT_IDENTITY_EMAIL_REQUIRED' });
  });
});

describe('writing the git identity on the computer', () => {
  let agent: FakeAgent;
  beforeEach(async () => {
    agent = await startFakeAgent();
  });
  afterEach(() => agent.close());
  const logger = { warn: () => {} } as never;
  const identity = (over: Partial<GitIdentity> = {}): GitIdentity => ({
    commitAs: 'bot',
    name: 'Alice Smith',
    email: 'alice@example.com',
    account: { name: 'Alice', email: 'owner@openbots.local' },
    ...over,
  });

  it('sets user.name and user.email globally for bot and coder, one argument each', async () => {
    const client = createAgentClient({ url: agent.url, token: agent.token });
    expect(await writeGitIdentity({ logger }, client, identity())).toBe('applied');
    expect(agent.coderStarts.map((s) => [s.user, s.command, ...(s.args ?? [])])).toEqual([
      ['bot', 'git', 'config', '--global', 'user.name', 'Alice Smith'],
      ['bot', 'git', 'config', '--global', 'user.email', 'alice@example.com'],
      ['coder', 'git', 'config', '--global', 'user.name', 'Alice Smith'],
      ['coder', 'git', 'config', '--global', 'user.email', 'alice@example.com'],
    ]);
  });

  it('leaves out the local placeholder email and reports a failed write', async () => {
    const client = createAgentClient({ url: agent.url, token: agent.token });
    expect(await writeGitIdentity({ logger }, client, identity({ email: null }))).toBe('applied');
    expect(agent.coderStarts.every((s) => !(s.args ?? []).includes('user.email'))).toBe(true);

    agent.coderScript = [{ type: 'exit', code: 1, signal: null }];
    expect(await writeGitIdentity({ logger }, client, identity())).toBe('failed');
  });
});
