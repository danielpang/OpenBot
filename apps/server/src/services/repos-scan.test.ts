import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { WORKTREE, WORKTREES, useRepoJobsWorld } from './__fixtures__/coders/repo-jobs.js';
import { gitArgs, REPO_PATH, type CoderIo } from './__fixtures__/coders/setup.js';
import { parseFindOutput, queueRepoScans, readRemote, scanComputer } from './repos-scan.js';
import { queueRepoReconciles } from './repos-refresh.js';
import { parseWorktreeList } from './repos-checkout.js';
import { listFound } from './repos.js';

// The scan for clones nobody remembered (GH6), and the jobs queued per
// running computer, against a scripted `/coder` (repo-jobs.ts).

describe('repository scan', () => {
  const j = useRepoJobsWorld('repo-scan@example.com');

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
    await j.readyCheckout({ state: 'missing' });
    j.findOutput = [
      `${REPO_PATH}/.git`,
      '/home/bot/code/tool/.git',
      '/home/bot/notes/.git',
      `${WORKTREE}/.git`,
    ].join('\n');
    j.gitBy((args) => {
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
    const before = j.w.coder.calls.length;
    expect(await j.inOrg(() => scanComputer(j.w.t.deps, j.computerId))).toEqual({
      found: 1,
      matched: 1,
    });
    const calls = j.w.coder.calls.slice(before);
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
    expect(await j.checkout()).toMatchObject({ path: REPO_PATH, state: 'ready' });
    const [tool] = await j.w.t.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.fullName, 'acme/tool'));
    expect(tool).toMatchObject({
      remoteUrl: 'https://github.com/acme/tool.git',
      foundPath: '/home/bot/code/tool',
      keepCloned: false,
      connectionId: null,
    });
    const owner = { id: j.w.ownerId, workspaceId: j.w.workspaceId };
    expect(await j.inOrg(() => listFound(j.w.t.deps, owner))).toEqual([
      {
        path: '/home/bot/code/tool',
        remoteUrl: 'https://github.com/acme/tool.git',
        fullName: 'acme/tool',
      },
    ]);

    // Gone by the next scan: no longer listed.
    j.findOutput = `${REPO_PATH}/.git\n`;
    expect(await j.inOrg(() => scanComputer(j.w.t.deps, j.computerId))).toEqual({
      found: 0,
      matched: 1,
    });
    expect(await j.inOrg(() => listFound(j.w.t.deps, owner))).toEqual([]);
  });

  it('keeps found clones when find failed and printed nothing', async () => {
    await j.w.t.db.insert(schema.repos).values({
      workspaceId: j.w.workspaceId,
      ownerId: j.w.ownerId,
      fullName: 'acme/tool',
      remoteUrl: 'https://github.com/acme/tool.git',
      keepCloned: false,
      foundPath: '/home/bot/code/tool',
    });
    j.w.coder.agent = (io: CoderIo) => {
      io.stderr('find: /home/bot: Permission denied\n');
      io.exit(1);
    };
    expect(await j.inOrg(() => scanComputer(j.w.t.deps, j.computerId))).toEqual({
      found: 0,
      matched: 0,
    });
    const owner = { id: j.w.ownerId, workspaceId: j.w.workspaceId };
    expect(await j.inOrg(() => listFound(j.w.t.deps, owner))).toHaveLength(1);
  });

  it('queues a scan beside each refresh, and a reconcile per running computer at start', async () => {
    const queued: { kind: string }[] = [];
    const queue = j.w.t.deps.infra.queue('coders');
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (async (name: string, data: { kind: string }, options?: object) => {
      queued.push(data);
      return enqueue(name, data, options);
    }) as typeof queue.enqueue;
    try {
      expect(await j.inOrg(() => queueRepoScans(j.w.t.deps))).toBe(1);
      expect(await j.inOrg(() => queueRepoReconciles(j.w.t.deps))).toBe(1);
    } finally {
      queue.enqueue = enqueue;
    }
    expect(queued).toEqual([
      { kind: 'scan', computerId: j.computerId },
      { kind: 'reconcile', computerId: j.computerId },
    ]);
  });
});
