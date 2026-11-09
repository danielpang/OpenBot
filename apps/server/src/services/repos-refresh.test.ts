import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { WORKTREE, WORKTREES, useRepoJobsWorld } from './__fixtures__/coders/repo-jobs.js';
import { gitArgs, REPO_PATH } from './__fixtures__/coders/setup.js';
import { queueRepoRefreshes, reconcileComputer, refreshStates } from './repos-refresh.js';
import { CONFIG_REFUSED, RUNNER_GIT_CONFIG } from './repos-checkout.js';

// The periodic fetch (GH3) and the reconcile after a computer start (GH4),
// against a scripted `/coder` (repo-jobs.ts).

describe('repository refresh and reconcile', () => {
  const j = useRepoJobsWorld('repo-refresh@example.com');

  it('refreshes states: behind, dirty in a session worktree, error, missing', async () => {
    await j.readyCheckout();
    const script = (worktreeStatus: string) =>
      j.gitBy((args, at) => {
        if (args.includes('rev-list')) return { code: 0, stdout: '1\t3\n' };
        if (args.includes('worktree')) return { code: 0, stdout: WORKTREES };
        if (args.includes('status') && at === WORKTREE) return { code: 0, stdout: worktreeStatus };
        if (args.includes('--format=%cI'))
          return { code: 0, stdout: '2026-11-01T10:00:00+00:00\n' };
        if (args.includes('fetch')) {
          return {
            code: 0,
            credential: { host: 'github.com', path: 'acme/relay.git', username: 'fetch' },
          };
        }
        return undefined;
      });
    script('');
    const before = j.w.coder.calls.length;
    expect(await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId))).toBe(1);
    expect(await j.checkout()).toMatchObject({ state: 'behind', ahead: 1, behind: 3, error: null });
    expect((await j.checkout())!.lastFetchAt).not.toBeNull();
    const fetch = j.w.coder.calls.slice(before).find((c) => c.launch.args?.includes('fetch'))!;
    expect(gitArgs(fetch.launch.args)).toEqual(['-C', REPO_PATH, 'fetch', '--prune', 'origin']);
    expect(fetch.credentials).toEqual([
      expect.objectContaining({ username: 'x-access-token', password: 'ghp-jobs-token' }),
    ]);
    const [repo] = await j.w.t.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, j.w.repoId));
    expect(repo!.lastRemotePushAt?.toISOString()).toBe('2026-11-01T10:00:00.000Z');

    script(' M src/link.ts\n');
    await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId));
    expect((await j.checkout())!.state).toBe('dirty');

    j.gitBy((args) =>
      args.includes('fetch') ? { code: 128, stderr: 'fatal: repository not found\n' } : undefined,
    );
    await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId));
    expect(await j.checkout()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('repository not found'),
    });

    j.onDisk = () => false;
    await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId));
    expect((await j.checkout())!.state).toBe('missing');
  });

  it('refuses to refresh a checkout whose config a session changed, before the fetch', async () => {
    await j.readyCheckout();
    j.gitBy((args) =>
      args.includes('--list')
        ? { code: 0, stdout: 'url.https://evil.example/.insteadof\nhttps://github.com/\0' }
        : undefined,
    );
    const before = j.w.coder.calls.length;
    expect(await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId))).toBe(0);
    expect(await j.checkout()).toMatchObject({
      state: 'error',
      error: `${CONFIG_REFUSED}: url.https://evil.example/.insteadof`,
    });
    const args = j.w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(args.some((a) => a.includes('fetch'))).toBe(false);
  });

  it('queues one refresh per running computer with checkouts, not again soon after', async () => {
    await j.readyCheckout();
    // An hour on: the refreshes of the tests above are long past.
    const later = Date.now() + 60 * 60_000;
    expect(await j.inOrg(() => queueRepoRefreshes(j.w.t.deps, later))).toBe(1);
    // Already queued.
    expect(await j.inOrg(() => queueRepoRefreshes(j.w.t.deps, later))).toBe(0);
    await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId));
    // Ran just now.
    expect(await j.inOrg(() => queueRepoRefreshes(j.w.t.deps))).toBe(0);
    expect(await j.inOrg(() => queueRepoRefreshes(j.w.t.deps, later))).toBe(1);
  });

  it('reconciles: marks a lost checkout missing, clones keep_cloned repositories, posts one row', async () => {
    await j.readyCheckout();
    const [broken] = await j.w.t.db
      .insert(schema.repos)
      .values({
        workspaceId: j.w.workspaceId,
        ownerId: j.w.ownerId,
        fullName: 'acme/broken',
        remoteUrl: 'https://github.com/acme/broken.git',
      })
      .returning();
    const [skipped] = await j.w.t.db
      .insert(schema.repos)
      .values({
        workspaceId: j.w.workspaceId,
        ownerId: j.w.ownerId,
        fullName: 'acme/skipped',
        remoteUrl: 'https://github.com/acme/skipped.git',
        keepCloned: false,
      })
      .returning();
    j.onDisk = () => false;
    j.gitBy((args) => {
      if (args.includes('--show-toplevel')) {
        return { code: 128, stderr: 'fatal: not a git repository' };
      }
      if (args[0] === 'clone' && args.some((a) => a.includes('acme/broken'))) {
        return { code: 128, stderr: 'fatal: repository not found\n' };
      }
      if (args.includes('rev-list')) return { code: 0, stdout: '0\t0\n' };
      if (args.includes('status')) return { code: 0, stdout: '' };
      return undefined;
    });
    const before = j.w.coder.calls.length;
    const result = await j.inOrg(() => reconcileComputer(j.w.t.deps, j.computerId));
    expect(result.cloned).toEqual(['acme/relay']);
    expect(result.failed).toEqual([
      { fullName: 'acme/broken', error: expect.stringContaining('repository not found') },
    ]);
    const clones = j.w.coder.calls
      .slice(before)
      .filter((c) => gitArgs(c.launch.args)[0] === 'clone')
      .map((c) => gitArgs(c.launch.args)[3]);
    expect(clones).not.toContain('https://fetch@github.com/acme/skipped.git');
    expect(await j.checkout()).toMatchObject({ state: 'ready', path: REPO_PATH });
    const events = (
      await j.w.t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, j.w.bot.chatId))
    )
      .flatMap((m) => m.parts as { type: string; kind?: string; text?: string }[])
      .filter((p) => p.type === 'event' && p.kind?.startsWith('repos_'));
    expect(events.map((e) => e.text)).toEqual([
      'Cloned 1 repository again',
      'Could not clone 1 repository: acme/broken',
    ]);
    await j.w.t.db.delete(schema.repos).where(eq(schema.repos.id, broken!.id));
    await j.w.t.db.delete(schema.repos).where(eq(schema.repos.id, skipped!.id));
  });

  it('reconciles a checkout stuck cloning, saying "Cloned" when none had gone missing', async () => {
    const now = new Date();
    await j.readyCheckout({ state: 'cloning', updatedAt: new Date(now.getTime() - 31 * 60_000) });
    j.gitBy((args) => {
      if (args.includes('--show-toplevel')) return { code: 128 };
      if (args.includes('rev-list')) return { code: 0, stdout: '0\t0\n' };
      if (args.includes('status')) return { code: 0, stdout: '' };
      return undefined;
    });
    const messagesBefore = (
      await j.w.t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, j.w.bot.chatId))
    ).length;
    expect((await j.inOrg(() => reconcileComputer(j.w.t.deps, j.computerId, now))).cloned).toEqual([
      'acme/relay',
    ]);
    expect((await j.checkout())!.state).toBe('ready');
    const texts = (
      await j.w.t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, j.w.bot.chatId))
    )
      .slice(messagesBefore)
      .flatMap((m) => m.parts as { type: string; text?: string }[])
      .map((p) => p.text);
    expect(texts).toContain('Cloned 1 repository');

    // One cloning for less than 30 minutes is that job's to finish.
    await j.w.t.db
      .update(schema.repoCheckouts)
      .set({ state: 'cloning', updatedAt: new Date(now.getTime() - 5 * 60_000) })
      .where(eq(schema.repoCheckouts.repoId, j.w.repoId));
    expect((await j.inOrg(() => reconcileComputer(j.w.t.deps, j.computerId, now))).cloned).toEqual(
      [],
    );
  });

  it('starts every runner git command with config the repository cannot override', () => {
    // The runner's git; the owner's git identity written at start is bot's and coder's.
    const git = j.w.coder.calls.filter(
      (c) => c.launch.command === 'git' && c.launch.user === 'runner',
    );
    expect(git.length).toBeGreaterThan(20);
    for (const call of git) {
      expect(call.launch.args!.slice(0, RUNNER_GIT_CONFIG.length)).toEqual([...RUNNER_GIT_CONFIG]);
    }
    expect(RUNNER_GIT_CONFIG).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'core.fsmonitor=false',
        'core.sshCommand=/bin/false',
        'core.askPass=',
        'protocol.allow=never',
        'protocol.https.allow=always',
        'protocol.file.allow=never',
        'uploadpack.allowFilter=false',
        'gpg.program=/bin/false',
        'commit.gpgsign=false',
      ]),
    );
  });

  it("measures the checkout on disk and removes ended sessions' merged or deleted worktrees", async () => {
    await j.readyCheckout();
    const OTHER = `${REPO_PATH}/.worktrees/bot-y`;
    const LIVE = `${REPO_PATH}/.worktrees/bot-z`;
    const list = `${WORKTREES}\nworktree ${OTHER}\nHEAD aaa\nbranch refs/heads/bot/y\n\nworktree ${LIVE}\nHEAD bbb\nbranch refs/heads/bot/z\n`;
    // bot/x is merged into main; bot/y was pushed and is gone from origin; bot/z still runs.
    const merged = await j.w.newSession({
      status: 'settled',
      worktreePath: WORKTREE,
      branch: 'bot/x',
    });
    const gone = await j.w.newSession({
      status: 'stopped',
      worktreePath: OTHER,
      branch: 'bot/y',
      pushAllowed: true,
    });
    const live = await j.w.newSession({ status: 'running', worktreePath: LIVE, branch: 'bot/z' });
    j.gitBy((args) => {
      if (args.includes('list')) return { code: 0, stdout: list };
      if (args.includes('--is-ancestor')) {
        return { code: args.includes('refs/heads/bot/x') ? 0 : 1 };
      }
      if (args.includes('refs/remotes/origin/bot/y')) return { code: 1 };
      return undefined;
    });
    const system = j.w.coder.system;
    j.w.coder.system = (command, args) =>
      command === 'du' ? { code: 0, stdout: `2048\t${REPO_PATH}\n` } : system(command, args);
    try {
      const before = j.w.coder.calls.length;
      await j.inOrg(() => refreshStates(j.w.t.deps, j.computerId));
      expect((await j.checkout())!.diskBytes).toBe(2048 * 1024);
      const git = j.w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
      expect(git).toContainEqual(['-C', REPO_PATH, 'worktree', 'remove', WORKTREE]);
      expect(git).toContainEqual(['-C', REPO_PATH, 'worktree', 'remove', OTHER]);
      expect(git).toContainEqual(['-C', REPO_PATH, 'worktree', 'prune']);
      expect(git.some((a) => a.includes('remove') && a.includes(LIVE))).toBe(false);
      expect((await j.w.session(merged.sessionId)).worktreePath).toBeNull();
      expect((await j.w.session(gone.sessionId)).worktreePath).toBeNull();
      expect((await j.w.session(live.sessionId)).worktreePath).toBe(LIVE);
    } finally {
      j.w.coder.system = system;
      await j.w.t.db.delete(schema.codingSessions);
    }
  });
});
