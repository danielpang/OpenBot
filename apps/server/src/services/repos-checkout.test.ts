import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import {
  coderWorld,
  defaultGit,
  defaultSystem,
  gitArgs,
  REPO_PATH,
  type CoderWorld,
} from './__fixtures__/coders/setup.js';
import { agentFor } from './computer.js';
import {
  checkoutPathFor,
  CONFIG_REFUSED,
  ensureCheckout,
  ensureWorktree,
  OTHER_REPOSITORY,
  remoteOf,
  remoteUrls,
  RUNNER_GIT_CONFIG,
  worktreePathFor,
} from './repos-checkout.js';

// A repository's checkout on the computer: cloned or fetched as `runner`
// through a scripted `/coder`, with its state recorded from git.

describe('repos checkout', () => {
  let w: CoderWorld;
  let computerId: string;

  beforeAll(async () => {
    w = await coderWorld('checkout@example.com');
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    const res = await w.call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-clone-token' },
    });
    expect(res.status).toBe(201);
  });
  afterEach(() => {
    w.coder.git = defaultGit;
    w.coder.system = defaultSystem;
    w.coder.agent = (io) => io.exit(0);
  });
  afterAll(() => w.close());

  const checkoutRow = async () =>
    (
      await w.t.db
        .select()
        .from(schema.repoCheckouts)
        .where(eq(schema.repoCheckouts.repoId, w.repoId))
    )[0]!;

  it('derives paths and urls from the full name or the remote', () => {
    const repo = { fullName: 'acme/relay', remoteUrl: 'https://github.com/acme/relay.git' };
    expect(checkoutPathFor(repo)).toBe(REPO_PATH);
    expect(checkoutPathFor({ fullName: '', remoteUrl: 'git@github.com:acme/app.git' })).toBe(
      '/home/bot/repos/acme/app',
    );
    expect(remoteUrls(repo)).toEqual({
      fetch: 'https://fetch@github.com/acme/relay.git',
      push: 'https://push@github.com/acme/relay.git',
    });
    expect(worktreePathFor(REPO_PATH, 'bot/fix reconnect!')).toBe(
      `${REPO_PATH}/.worktrees/bot-fix-reconnect`,
    );
    // Another host keeps its stored remote, deeper path and all, with the usernames put in.
    expect(
      remoteUrls({
        fullName: 'team/app',
        remoteUrl: 'https://gitlab.example.com/group/team/app.git',
      }),
    ).toEqual({
      fetch: 'https://fetch@gitlab.example.com/group/team/app.git',
      push: 'https://push@gitlab.example.com/group/team/app.git',
    });
    // A dot-only part never becomes a path.
    for (const fullName of ['acme/..', '../relay', './x', 'acme/.']) {
      expect(() => checkoutPathFor({ fullName, remoteUrl: '' })).toThrow(/Cannot tell/);
    }
    expect(remoteOf({ fullName: 'acme/.dotfiles', remoteUrl: '' }).fullName).toBe('acme/.dotfiles');
  });

  it('starts every git with the transport locked down', () => {
    const flags = RUNNER_GIT_CONFIG.filter((_, i) => i % 2 === 1);
    expect(RUNNER_GIT_CONFIG.filter((_, i) => i % 2 === 0).every((f) => f === '-c')).toBe(true);
    expect(flags).toEqual(
      expect.arrayContaining([
        'http.proxy=',
        'http.sslVerify=true',
        'http.sslCAInfo=/etc/ssl/certs/ca-certificates.crt',
        'http.extraHeader=',
        'http.https://github.com/.proxy=',
        'http.https://github.com/.sslVerify=true',
        'http.https://github.com/.extraHeader=',
        'core.alternateRefsCommand=',
      ]),
    );
    // Ubuntu's git has GnuTLS only, and core.gitProxy's first value wins: neither is set.
    expect(flags.some((f) => /sslBackend|gitProxy/i.test(f))).toBe(false);
  });

  it('clones a missing repository as runner, the token served as the runner', async () => {
    w.coder.git = (args) => {
      if (args.includes('--show-toplevel')) {
        return { code: 128, stderr: 'fatal: not a git repository' };
      }
      if (args[0] === 'clone') {
        return {
          code: 0,
          credential: { host: 'github.com', path: 'acme/relay.git', username: 'fetch' },
        };
      }
      if (args.includes('rev-list')) return { code: 0, stdout: '0\t0\n' };
      if (args.includes('status')) return { code: 0, stdout: '' };
      return defaultGit(args);
    };
    const before = w.coder.calls.length;
    const row = await w.t.inOrganization(() =>
      ensureCheckout(w.t.deps, w.repoId, computerId, 'clone'),
    );
    expect(row).toMatchObject({ path: REPO_PATH, state: 'ready', headSha: 'abc1234', error: null });
    expect(row.lastFetchAt).not.toBeNull();
    // The computer's start also writes the owner's git identity as bot and coder (git-identity.ts).
    const calls = w.coder.calls
      .slice(before)
      .filter((c) => !(c.launch.args?.[0] === 'config' && c.launch.args[1] === '--global'));
    const clone = calls.find((c) => gitArgs(c.launch.args)[0] === 'clone')!;
    expect(clone.launch).toMatchObject({ user: 'runner', command: 'git', git_credentials: true });
    expect(clone.launch.env).toMatchObject({ GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' });
    // Every process of it is the runner's, never the session's user.
    expect(calls.every((c) => c.launch.user === 'runner')).toBe(true);
    // After the clone, the config, hooks and info are the runner's alone.
    const chmods = calls
      .slice(calls.indexOf(clone))
      .filter((c) => c.launch.command === 'chmod')
      .map((c) => c.launch.args);
    expect(chmods).toEqual(
      expect.arrayContaining([
        ['0644', '--', `${REPO_PATH}/.git/config`],
        ['-R', 'go-w', '--', `${REPO_PATH}/.git/hooks`, `${REPO_PATH}/.git/info`],
      ]),
    );
    expect(gitArgs(clone.launch.args)).toEqual([
      'clone',
      '--config',
      'core.sharedRepository=group',
      'https://fetch@github.com/acme/relay.git',
      REPO_PATH,
    ]);
    expect(clone.launch.session_id).toMatch(/^runner-/);
    expect(clone.credentials).toEqual([
      expect.objectContaining({ username: 'x-access-token', password: 'ghp-clone-token' }),
    ]);
    expect(calls.map((c) => gitArgs(c.launch.args))).toContainEqual([
      '-C',
      REPO_PATH,
      'config',
      'remote.origin.pushurl',
      'https://push@github.com/acme/relay.git',
    ]);
  });

  it('refuses a checkout whose config was changed, before any fetch', async () => {
    w.coder.git = (args) => {
      if (args.includes('--list')) {
        return {
          code: 0,
          stdout: [
            'core.bare\nfalse',
            'remote.origin.url\nhttps://fetch@github.com/acme/relay.git',
            'http.https://github.com/acme/.proxy\nhttp://evil:8080',
            'remote.origin.pushurl\nhttps://push@evil.example/x.git',
            'core.hookspath\n/tmp/hooks',
            'diff.foo.textconv\nsh evil',
            'gc.foo.command\nsh evil',
            'branch.main.remote\norigin',
          ]
            .map((e) => `${e}\0`)
            .join(''),
        };
      }
      return defaultGit(args);
    };
    const before = w.coder.calls.length;
    await expect(
      w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId)),
    ).rejects.toThrow(CONFIG_REFUSED);
    const row = await checkoutRow();
    expect(row.state).toBe('error');
    expect(row.error).toBe(
      `${CONFIG_REFUSED}: http.https://github.com/acme/.proxy, remote.origin.pushurl, core.hookspath, diff.foo.textconv, gc.foo.command`,
    );
    const after = w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(after.some((a) => a.includes('fetch'))).toBe(false);
    expect(after.some((a) => a.includes('remote.origin.url'))).toBe(false);
  });

  it('refuses a config a session could write, before any fetch', async () => {
    w.coder.system = (command, args) =>
      command === 'stat'
        ? { code: 0, stdout: `1800 664 ${args[args.length - 1]}\n` }
        : defaultSystem(command, args);
    const before = w.coder.calls.length;
    await expect(
      w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId)),
    ).rejects.toThrow(/can be changed by a coding session/);
    const calls = w.coder.calls.slice(before);
    // The runner tried to take the file back first.
    expect(calls.find((c) => c.launch.command === 'chmod')?.launch.args).toEqual([
      '0644',
      '--',
      `${REPO_PATH}/.git/config`,
    ]);
    expect(calls.some((c) => gitArgs(c.launch.args).includes('fetch'))).toBe(false);
    expect((await checkoutRow()).error).toBe(
      `${CONFIG_REFUSED}: ${REPO_PATH}/.git/config can be changed by a coding session`,
    );
  });

  it('never takes a directory inside another repository for the checkout', async () => {
    w.coder.git = (args) =>
      args.includes('--show-toplevel') ? { code: 0, stdout: '/home/bot\n' } : defaultGit(args);
    w.coder.agent = (io) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'realpath') io.stdout(`${args[2]}\n${args[3]}\n`);
      if (command === 'find') io.stdout(`${REPO_PATH}/README.md\n`);
      io.exit(0);
    };
    const before = w.coder.calls.length;
    await expect(
      w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId)),
    ).rejects.toThrow(OTHER_REPOSITORY);
    expect((await checkoutRow()).error).toBe(OTHER_REPOSITORY);
    const gits = w.coder.calls.slice(before).map((c) => gitArgs(c.launch.args));
    expect(gits.some((a) => a.includes('fetch') || a[0] === 'clone')).toBe(false);

    // An empty directory there is cloned into.
    w.coder.agent = (io) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'realpath') io.stdout(`${args[2]}\n${args[3]}\n`);
      io.exit(0);
    };
    const again = w.coder.calls.length;
    await w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId));
    expect(w.coder.calls.slice(again).some((c) => gitArgs(c.launch.args)[0] === 'clone')).toBe(
      true,
    );
  });

  it('starts a stopped computer for a clone the owner asked for, not for an update', async () => {
    await w.t.db
      .update(schema.computers)
      .set({ status: 'stopped' })
      .where(eq(schema.computers.id, computerId));
    // Reconcile's own call: the computer stays as it is (the fake agent answers anyway).
    await w.t
      .inOrganization(() =>
        ensureCheckout(w.t.deps, w.repoId, computerId, 'clone', { startStopped: false }),
      )
      .catch(() => {});
    const [still] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, computerId));
    expect(still!.status).toBe('stopped');
    const row = await w.t.inOrganization(() =>
      ensureCheckout(w.t.deps, w.repoId, computerId, 'clone'),
    );
    expect(row.state).not.toBe('error');
    const [up] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, computerId));
    expect(up!.status).toBe('running');
  });

  it('marks a checkout with local changes dirty', async () => {
    w.coder.git = (args) =>
      args.includes('status')
        ? { code: 0, stdout: ' M src/a.ts\n?? .worktrees/\n' }
        : defaultGit(args);
    const row = await w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId));
    expect(row.state).toBe('dirty');
  });

  it("records git's error and throws", async () => {
    w.coder.git = (args) =>
      args.includes('fetch')
        ? { code: 128, stderr: "fatal: could not read Username for 'https://github.com'\n" }
        : defaultGit(args);
    await expect(
      w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId)),
    ).rejects.toThrow(/could not read Username/);
    expect(await checkoutRow()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('could not read Username'),
    });
  });

  it('adds a worktree from an existing branch, and keeps one already there', async () => {
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, computerId));
    const ctx = {
      deps: w.t.ownerDeps,
      agent: agentFor(w.t.ownerDeps, computer!),
      owner: { id: w.ownerId, workspaceId: w.workspaceId },
    };
    w.coder.git = (args) => (args.includes('--verify') ? { code: 0 } : defaultGit(args));
    const before = w.coder.calls.length;
    const path = await ensureWorktree(ctx, REPO_PATH, 'bot/old', 'main');
    expect(path).toBe(`${REPO_PATH}/.worktrees/bot-old`);
    const calls = w.coder.calls.slice(before);
    expect(calls.map((c) => gitArgs(c.launch.args))).toContainEqual([
      '-C',
      REPO_PATH,
      'worktree',
      'add',
      path,
      'bot/old',
    ]);
    // The new worktree leaves the checkout's config the runner's alone again.
    expect(calls.at(-2)?.launch).toMatchObject({
      command: 'chmod',
      args: ['0644', '--', `${REPO_PATH}/.git/config`],
    });
    w.coder.git = (args) =>
      args.includes('--is-inside-work-tree') ? { code: 0, stdout: 'true\n' } : defaultGit(args);
    const again = w.coder.calls.length;
    expect(await ensureWorktree(ctx, REPO_PATH, 'bot/old', 'main')).toBe(path);
    expect(w.coder.calls.slice(again).some((c) => c.launch.args?.includes('add'))).toBe(false);
  });
});
