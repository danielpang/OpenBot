import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import {
  coderWorld,
  defaultGit,
  gitArgs,
  REPO_PATH,
  type CoderIo,
  type CoderWorld,
  type GitAnswer,
} from './__fixtures__/coders/setup.js';
import { runnerSessionIds } from './git-credentials.js';
import { CONFIG_REFUSED, RUNNER_GIT_CONFIG } from './repos-checkout.js';
import {
  parseFindOutput,
  parseWorktreeList,
  queueRepoReconciles,
  queueRepoRefreshes,
  queueRepoScans,
  readRemote,
  reconcileComputer,
  refreshStates,
  rescueRepos,
  scanComputer,
} from './repos-jobs.js';
import { listFound } from './repos.js';

// The remembered repositories' jobs (GH3 to GH6): scan, refresh, reconcile
// and rescue, against a scripted `/coder` whose git and other commands
// (`find`, `test`) answer from the test.

const WORKTREE = `${REPO_PATH}/.worktrees/bot-x`;
const STASH = 'a'.repeat(40);
const WORKTREES = `worktree ${REPO_PATH}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def\nbranch refs/heads/bot/x\n`;

describe('repository jobs', () => {
  let w: CoderWorld;
  let computerId: string;
  /** What `test -e <path>/.git` answers, by path. */
  let onDisk: (path: string) => boolean;
  let findOutput: string;

  beforeAll(async () => {
    w = await coderWorld('repo-jobs@example.com');
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    const res = await w.call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-jobs-token' },
    });
    expect(res.status).toBe(201);
  });
  beforeEach(async () => {
    onDisk = () => true;
    findOutput = '';
    w.coder.agent = (io: CoderIo) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'find') io.stdout(findOutput);
      if (command === 'test') return io.exit(onDisk(args[1]!.replace(/\/\.git$/, '')) ? 0 : 1);
      io.exit(0);
    };
    await w.t.db.delete(schema.repoCheckouts);
    await w.t.db
      .delete(schema.repos)
      .where(and(eq(schema.repos.ownerId, w.ownerId), eq(schema.repos.fullName, 'acme/tool')));
  });
  afterEach(() => {
    w.coder.git = defaultGit;
  });
  afterAll(() => w.close());

  const inOrg = <T>(fn: () => Promise<T>) => w.t.inOrganization(fn);
  const checkout = async () =>
    (
      await w.t.db
        .select()
        .from(schema.repoCheckouts)
        .where(eq(schema.repoCheckouts.repoId, w.repoId))
    )[0];
  const readyCheckout = (over: Partial<typeof schema.repoCheckouts.$inferInsert> = {}) =>
    w.t.db.insert(schema.repoCheckouts).values({
      workspaceId: w.workspaceId,
      repoId: w.repoId,
      computerId,
      path: REPO_PATH,
      state: 'ready',
      ...over,
    });
  /** git answers by the path after `-C`, falling back to `defaultGit`. */
  const gitBy = (answer: (args: string[], at: string | undefined) => GitAnswer | undefined) => {
    w.coder.git = (args) => {
      const at = args[args.indexOf('-C') + 1];
      return answer(args, args.includes('-C') ? at : undefined) ?? defaultGit(args);
    };
  };

  it('reads find output, remotes and worktree lists', () => {
    expect(
      parseFindOutput(
        [
          '/home/bot/repos/acme/relay/.git',
          '/home/bot/repos/acme/relay/.worktrees/bot-x/.git',
          '/home/bot/code/node_modules/x/.git',
          '/home/bot/code/tool/.git',
          'find: /home/bot/private: Permission denied',
          '/home/bot/code/tool/.git',
          '/home/bot/code/../repos/x/.git',
          '/home/bot/./y/.git',
          '',
        ].join('\n'),
      ),
    ).toEqual(['/home/bot/repos/acme/relay', '/home/bot/code/tool']);
    expect(readRemote('https://fetch@github.com/acme/relay.git\n')).toMatchObject({
      fullName: 'acme/relay',
      remoteUrl: 'https://github.com/acme/relay.git',
    });
    expect(readRemote('https://x-access-token:ghp_secret@github.com/acme/a.git')?.remoteUrl).toBe(
      'https://github.com/acme/a.git',
    );
    expect(readRemote('git@github.com:acme/tool.git')?.remoteUrl).toBe(
      'https://github.com/acme/tool.git',
    );
    expect(readRemote('/srv/local.git')).toBeNull();
    expect(parseWorktreeList(WORKTREES)).toEqual([
      { path: REPO_PATH, branch: 'main' },
      { path: WORKTREE, branch: 'bot/x' },
    ]);
  });

  it('scans the home as runner: a remembered clone updates its checkout, others are found', async () => {
    await readyCheckout({ state: 'missing' });
    findOutput = [
      `${REPO_PATH}/.git`,
      '/home/bot/code/tool/.git',
      '/home/bot/notes/.git',
      `${WORKTREE}/.git`,
    ].join('\n');
    gitBy((args) => {
      if (!args.includes('remote.origin.url')) return undefined;
      const file = args[args.indexOf('--file') + 1];
      if (file === `${REPO_PATH}/.git/config`) {
        return { code: 0, stdout: 'https://fetch@github.com/acme/relay.git\n' };
      }
      if (file === '/home/bot/code/tool/.git/config') {
        return { code: 0, stdout: 'git@github.com:acme/tool.git\n' };
      }
      return { code: 1 };
    });
    const before = w.coder.calls.length;
    expect(await inOrg(() => scanComputer(w.t.deps, computerId))).toEqual({
      found: 1,
      matched: 1,
    });
    const calls = w.coder.calls.slice(before);
    expect(calls[0]!.launch).toMatchObject({
      user: 'runner',
      command: 'find',
      args: ['/home/bot', '-maxdepth', '4', '-name', '.git', '-prune'],
    });
    expect(calls.some((c) => gitArgs(c.launch.args)[0] === 'clone')).toBe(false);
    // The remote is read from the config file: no repository discovery, no hooks.
    expect(calls.map((c) => gitArgs(c.launch.args))).toContainEqual([
      'config',
      '--file',
      '/home/bot/code/tool/.git/config',
      '--get',
      'remote.origin.url',
    ]);
    expect(await checkout()).toMatchObject({ path: REPO_PATH, state: 'ready' });
    const [tool] = await w.t.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.fullName, 'acme/tool'));
    expect(tool).toMatchObject({
      remoteUrl: 'https://github.com/acme/tool.git',
      foundPath: '/home/bot/code/tool',
      keepCloned: false,
      connectionId: null,
    });
    const owner = { id: w.ownerId, workspaceId: w.workspaceId };
    expect(await inOrg(() => listFound(w.t.deps, owner))).toEqual([
      {
        path: '/home/bot/code/tool',
        remoteUrl: 'https://github.com/acme/tool.git',
        fullName: 'acme/tool',
      },
    ]);

    // Gone by the next scan: no longer listed.
    findOutput = `${REPO_PATH}/.git\n`;
    expect(await inOrg(() => scanComputer(w.t.deps, computerId))).toEqual({
      found: 0,
      matched: 1,
    });
    expect(await inOrg(() => listFound(w.t.deps, owner))).toEqual([]);
  });

  it('keeps found clones when find failed and printed nothing', async () => {
    await w.t.db.insert(schema.repos).values({
      workspaceId: w.workspaceId,
      ownerId: w.ownerId,
      fullName: 'acme/tool',
      remoteUrl: 'https://github.com/acme/tool.git',
      keepCloned: false,
      foundPath: '/home/bot/code/tool',
    });
    w.coder.agent = (io: CoderIo) => {
      io.stderr('find: /home/bot: Permission denied\n');
      io.exit(1);
    };
    expect(await inOrg(() => scanComputer(w.t.deps, computerId))).toEqual({
      found: 0,
      matched: 0,
    });
    const owner = { id: w.ownerId, workspaceId: w.workspaceId };
    expect(await inOrg(() => listFound(w.t.deps, owner))).toHaveLength(1);
  });

  it('queues a scan beside each refresh, and a reconcile per running computer at start', async () => {
    const queued: { kind: string }[] = [];
    const queue = w.t.deps.infra.queue('coders');
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (async (name: string, data: { kind: string }, options?: object) => {
      queued.push(data);
      return enqueue(name, data, options);
    }) as typeof queue.enqueue;
    try {
      expect(await inOrg(() => queueRepoScans(w.t.deps))).toBe(1);
      expect(await inOrg(() => queueRepoReconciles(w.t.deps))).toBe(1);
    } finally {
      queue.enqueue = enqueue;
    }
    expect(queued).toEqual([
      { kind: 'scan', computerId },
      { kind: 'reconcile', computerId },
    ]);
  });

  it('refreshes states: behind, dirty in a session worktree, error, missing', async () => {
    await readyCheckout();
    const script = (worktreeStatus: string) =>
      gitBy((args, at) => {
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
    const before = w.coder.calls.length;
    expect(await inOrg(() => refreshStates(w.t.deps, computerId))).toBe(1);
    expect(await checkout()).toMatchObject({ state: 'behind', ahead: 1, behind: 3, error: null });
    expect((await checkout())!.lastFetchAt).not.toBeNull();
    const fetch = w.coder.calls.slice(before).find((c) => c.launch.args?.includes('fetch'))!;
    expect(gitArgs(fetch.launch.args)).toEqual(['-C', REPO_PATH, 'fetch', '--prune', 'origin']);
    expect(fetch.credentials).toEqual([
      expect.objectContaining({ username: 'x-access-token', password: 'ghp-jobs-token' }),
    ]);
    const [repo] = await w.t.db.select().from(schema.repos).where(eq(schema.repos.id, w.repoId));
    expect(repo!.lastRemotePushAt?.toISOString()).toBe('2026-11-01T10:00:00.000Z');

    script(' M src/link.ts\n');
    await inOrg(() => refreshStates(w.t.deps, computerId));
    expect((await checkout())!.state).toBe('dirty');

    gitBy((args) =>
      args.includes('fetch') ? { code: 128, stderr: 'fatal: repository not found\n' } : undefined,
    );
    await inOrg(() => refreshStates(w.t.deps, computerId));
    expect(await checkout()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('repository not found'),
    });

    onDisk = () => false;
    await inOrg(() => refreshStates(w.t.deps, computerId));
    expect((await checkout())!.state).toBe('missing');
  });

  it('refuses to refresh a checkout whose config a session changed, before the fetch', async () => {
    await readyCheckout();
    gitBy((args) =>
      args.includes('--list')
        ? { code: 0, stdout: 'url.https://evil.example/.insteadof\nhttps://github.com/\0' }
        : undefined,
    );
    const before = w.coder.calls.length;
    expect(await inOrg(() => refreshStates(w.t.deps, computerId))).toBe(0);
    expect(await checkout()).toMatchObject({
      state: 'error',
      error: `${CONFIG_REFUSED}: url.https://evil.example/.insteadof`,
    });
    const args = w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(args.some((a) => a.includes('fetch'))).toBe(false);
  });

  it('queues one refresh per running computer with checkouts, not again soon after', async () => {
    await readyCheckout();
    // An hour on: the refreshes of the tests above are long past.
    const later = Date.now() + 60 * 60_000;
    expect(await inOrg(() => queueRepoRefreshes(w.t.deps, later))).toBe(1);
    // Already queued.
    expect(await inOrg(() => queueRepoRefreshes(w.t.deps, later))).toBe(0);
    await inOrg(() => refreshStates(w.t.deps, computerId));
    // Ran just now.
    expect(await inOrg(() => queueRepoRefreshes(w.t.deps))).toBe(0);
    expect(await inOrg(() => queueRepoRefreshes(w.t.deps, later))).toBe(1);
  });

  it('reconciles: marks a lost checkout missing, clones keep_cloned repositories, posts one row', async () => {
    await readyCheckout();
    const [broken] = await w.t.db
      .insert(schema.repos)
      .values({
        workspaceId: w.workspaceId,
        ownerId: w.ownerId,
        fullName: 'acme/broken',
        remoteUrl: 'https://github.com/acme/broken.git',
      })
      .returning();
    const [skipped] = await w.t.db
      .insert(schema.repos)
      .values({
        workspaceId: w.workspaceId,
        ownerId: w.ownerId,
        fullName: 'acme/skipped',
        remoteUrl: 'https://github.com/acme/skipped.git',
        keepCloned: false,
      })
      .returning();
    onDisk = () => false;
    gitBy((args) => {
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
    const before = w.coder.calls.length;
    const result = await inOrg(() => reconcileComputer(w.t.deps, computerId));
    expect(result.cloned).toEqual(['acme/relay']);
    expect(result.failed).toEqual([
      { fullName: 'acme/broken', error: expect.stringContaining('repository not found') },
    ]);
    const clones = w.coder.calls
      .slice(before)
      .filter((c) => gitArgs(c.launch.args)[0] === 'clone')
      .map((c) => gitArgs(c.launch.args)[3]);
    expect(clones).not.toContain('https://fetch@github.com/acme/skipped.git');
    expect(await checkout()).toMatchObject({ state: 'ready', path: REPO_PATH });
    const events = (
      await w.t.db.select().from(schema.messages).where(eq(schema.messages.chatId, w.bot.chatId))
    )
      .flatMap((m) => m.parts as { type: string; kind?: string; text?: string }[])
      .filter((p) => p.type === 'event' && p.kind?.startsWith('repos_'));
    expect(events.map((e) => e.text)).toEqual([
      'Cloned 1 repository again',
      'Could not clone 1 repository: acme/broken',
    ]);
    await w.t.db.delete(schema.repos).where(eq(schema.repos.id, broken!.id));
    await w.t.db.delete(schema.repos).where(eq(schema.repos.id, skipped!.id));
  });

  it('reconciles a checkout stuck cloning, saying "Cloned" when none had gone missing', async () => {
    const now = new Date();
    await readyCheckout({ state: 'cloning', updatedAt: new Date(now.getTime() - 31 * 60_000) });
    gitBy((args) => {
      if (args.includes('--show-toplevel')) return { code: 128 };
      if (args.includes('rev-list')) return { code: 0, stdout: '0\t0\n' };
      if (args.includes('status')) return { code: 0, stdout: '' };
      return undefined;
    });
    const messagesBefore = (
      await w.t.db.select().from(schema.messages).where(eq(schema.messages.chatId, w.bot.chatId))
    ).length;
    expect((await inOrg(() => reconcileComputer(w.t.deps, computerId, now))).cloned).toEqual([
      'acme/relay',
    ]);
    expect((await checkout())!.state).toBe('ready');
    const texts = (
      await w.t.db.select().from(schema.messages).where(eq(schema.messages.chatId, w.bot.chatId))
    )
      .slice(messagesBefore)
      .flatMap((m) => m.parts as { type: string; text?: string }[])
      .map((p) => p.text);
    expect(texts).toContain('Cloned 1 repository');

    // One cloning for less than 30 minutes is that job's to finish.
    await w.t.db
      .update(schema.repoCheckouts)
      .set({ state: 'cloning', updatedAt: new Date(now.getTime() - 5 * 60_000) })
      .where(eq(schema.repoCheckouts.repoId, w.repoId));
    expect((await inOrg(() => reconcileComputer(w.t.deps, computerId, now))).cloned).toEqual([]);
  });

  it('rescues unpushed work to new branches, pushing with a write credential', async () => {
    await readyCheckout();
    const pushes: { args: string[]; session: unknown }[] = [];
    gitBy((args, at) => {
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
        const sessionId = w.coder.calls.at(-1)!.launch.session_id;
        pushes.push({ args, session: runnerSessionIds.get(sessionId) });
        return {
          code: 0,
          credential: { host: 'github.com', path: 'acme/relay.git', username: 'push' },
        };
      }
      return undefined;
    });
    const before = w.coder.calls.length;
    const results = await inOrg(() =>
      rescueRepos(w.t.deps, w.ownerId, computerId, new Date('2026-11-05T10:30:00Z')),
    );
    const main = 'openbots/rescue/2026-11-05T10-30/relay/main';
    const session = 'openbots/rescue/2026-11-05T10-30/relay/bot-x';
    expect(results).toEqual([
      {
        repoId: w.repoId,
        fullName: 'acme/relay',
        branch: main,
        pushed: true,
        note: `Saved uncommitted changes on main to ${main}`,
      },
      {
        repoId: w.repoId,
        fullName: 'acme/relay',
        branch: session,
        pushed: true,
        note: `Saved 1 unpushed commit on bot/x to ${session}`,
      },
    ]);
    const args = w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
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
    const pushCalls = w.coder.calls.slice(before).filter((c) => c.launch.args?.includes('push'));
    expect(pushCalls[0]!.credentials).toEqual([
      expect.objectContaining({ username: 'x-access-token', password: 'ghp-jobs-token' }),
    ]);

    // Everything pushed: one result that says so, and nothing written.
    w.coder.git = (a) =>
      a.includes('status') ? { code: 0, stdout: '?? .worktrees/\n' } : defaultGit(a);
    gitBy((a) =>
      a.includes('--remotes') || a.includes('status') ? { code: 0, stdout: '' } : undefined,
    );
    const clean = await inOrg(() => rescueRepos(w.t.deps, w.ownerId, computerId));
    expect(clean).toEqual([
      expect.objectContaining({
        branch: null,
        pushed: false,
        note: 'Nothing to save: everything is pushed',
      }),
    ]);
  });

  it('leaves the worktree of a live session alone', async () => {
    await readyCheckout();
    const { sessionId } = await w.newSession({ status: 'running', worktreePath: WORKTREE });
    gitBy((args, at) => {
      if (args.includes('worktree')) return { code: 0, stdout: WORKTREES };
      if (args.includes('--remotes')) return { code: 0, stdout: 'def1234 Try a fix\n' };
      if (args.includes('status')) return { code: 0, stdout: at === WORKTREE ? ' M a.ts\n' : '' };
      return undefined;
    });
    const before = w.coder.calls.length;
    const results = await inOrg(() => rescueRepos(w.t.deps, w.ownerId, computerId));
    expect(results.map((r) => r.note)).toContain(
      'Left alone on bot/x: a coding session is working there',
    );
    const args = w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(args.some((a) => a.includes(WORKTREE))).toBe(false);
    await w.t.db.delete(schema.codingSessions).where(eq(schema.codingSessions.id, sessionId));
  });

  it('starts every runner git command with config the repository cannot override', () => {
    const git = w.coder.calls.filter((c) => c.launch.command === 'git');
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
});
