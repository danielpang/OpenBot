import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { STASH, WORKTREE, WORKTREES, useRepoJobsWorld } from './__fixtures__/coders/repo-jobs.js';
import { gitArgs, REPO_PATH, defaultGit } from './__fixtures__/coders/setup.js';
import { rescueRepos } from './repos-rescue.js';
import { runnerSessionIds } from './git-credentials.js';

// Rescue before loss (GH5), against a scripted `/coder` (repo-jobs.ts).

describe('repository rescue', () => {
  const j = useRepoJobsWorld('repo-rescue@example.com');

  it('rescues unpushed work to new branches, pushing with a write credential', async () => {
    await j.readyCheckout();
    const pushes: { args: string[]; session: unknown }[] = [];
    j.gitBy((args, at) => {
      if (args.includes('worktree')) return { code: 0, stdout: WORKTREES };
      if (args.includes('symbolic-ref') && args.includes('--short')) {
        return { code: 0, stdout: 'main\n' };
      }
      if (args.includes('--remotes')) {
        return { code: 0, stdout: at === WORKTREE ? 'def1234 Try a fix\n' : '' };
      }
      if (args.includes('status')) {
        return { code: 0, stdout: at === REPO_PATH ? ' M src/a.ts\n?? .worktrees/\n' : '' };
      }
      if (args.includes('stash')) return { code: 0, stdout: `${STASH}\n` };
      if (args.includes('push')) {
        const sessionId = j.w.coder.calls.at(-1)!.launch.session_id;
        pushes.push({ args, session: runnerSessionIds.get(sessionId) });
        return {
          code: 0,
          credential: { host: 'github.com', path: 'acme/relay.git', username: 'push' },
        };
      }
      return undefined;
    });
    const before = j.w.coder.calls.length;
    const results = await j.inOrg(() =>
      rescueRepos(j.w.t.deps, j.w.ownerId, j.computerId, new Date('2026-11-05T10:30:00Z')),
    );
    const main = 'openbots/rescue/2026-11-05T10-30/relay/main';
    const session = 'openbots/rescue/2026-11-05T10-30/relay/bot-x';
    expect(results).toEqual([
      {
        repoId: j.w.repoId,
        fullName: 'acme/relay',
        branch: main,
        pushed: true,
        note: `Saved uncommitted changes on main to ${main}`,
      },
      {
        repoId: j.w.repoId,
        fullName: 'acme/relay',
        branch: session,
        pushed: true,
        note: `Saved 1 unpushed commit on bot/x to ${session}`,
      },
    ]);
    const args = j.w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(args).toContainEqual([
      '-c',
      'user.name=OpenBots',
      '-c',
      'user.email=rescue@openbots.local',
      '-C',
      REPO_PATH,
      'stash',
      'create',
      'Rescue uncommitted work',
    ]);
    expect(args).toContainEqual(['-C', REPO_PATH, 'update-ref', `refs/heads/${main}`, STASH]);
    expect(args).toContainEqual(['-C', WORKTREE, 'branch', session, 'HEAD']);
    // HEAD, the index and the files are never touched: no checkout, add, commit or reset.
    for (const word of ['checkout', 'add', 'commit', 'reset', 'switch', 'main:main']) {
      expect(args.some((a) => a.includes(word))).toBe(false);
    }
    expect(pushes.map((p) => p.args)).toEqual([
      ['-C', REPO_PATH, 'push', 'origin', `refs/heads/${main}:refs/heads/${main}`],
      ['-C', WORKTREE, 'push', 'origin', `refs/heads/${session}:refs/heads/${session}`],
    ]);
    for (const push of pushes) {
      expect(push.session).toEqual({ repoFullName: 'acme/relay', push: true, write: true });
    }
    const pushCalls = j.w.coder.calls.slice(before).filter((c) => c.launch.args?.includes('push'));
    expect(pushCalls[0]!.credentials).toEqual([
      expect.objectContaining({ username: 'x-access-token', password: 'ghp-jobs-token' }),
    ]);

    // Everything pushed: one result that says so, and nothing written.
    j.w.coder.git = (a) =>
      a.includes('status') ? { code: 0, stdout: '?? .worktrees/\n' } : defaultGit(a);
    j.gitBy((a) =>
      a.includes('--remotes') || a.includes('status') ? { code: 0, stdout: '' } : undefined,
    );
    const clean = await j.inOrg(() => rescueRepos(j.w.t.deps, j.w.ownerId, j.computerId));
    expect(clean).toEqual([
      expect.objectContaining({
        branch: null,
        pushed: false,
        note: 'Nothing to save: everything is pushed',
      }),
    ]);
  });

  it('leaves the worktree of a live session alone', async () => {
    await j.readyCheckout();
    const { sessionId } = await j.w.newSession({ status: 'running', worktreePath: WORKTREE });
    j.gitBy((args, at) => {
      if (args.includes('worktree')) return { code: 0, stdout: WORKTREES };
      if (args.includes('--remotes')) return { code: 0, stdout: 'def1234 Try a fix\n' };
      if (args.includes('status')) return { code: 0, stdout: at === WORKTREE ? ' M a.ts\n' : '' };
      return undefined;
    });
    const before = j.w.coder.calls.length;
    const results = await j.inOrg(() => rescueRepos(j.w.t.deps, j.w.ownerId, j.computerId));
    expect(results.map((r) => r.note)).toContain(
      'Left alone on bot/x: a coding session is working there',
    );
    const args = j.w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(args.some((a) => a.includes(WORKTREE))).toBe(false);
    await j.w.t.db.delete(schema.codingSessions).where(eq(schema.codingSessions.id, sessionId));
  });
});
