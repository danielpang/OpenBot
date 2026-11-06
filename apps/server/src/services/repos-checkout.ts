import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { ComputerAgentClient } from '@openbots/computer';
import { REPOS_DIR } from '@openbots/computer';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { SYSTEM_ACTOR } from './audit.js';
import { agentFor, startComputer } from './computer.js';
import {
  FETCH_USERNAME,
  PUSH_USERNAME,
  resolveGitCredential,
  runnerSessionIds,
  type RunnerGit,
} from './git-credentials.js';

// A repository's checkout on a computer (GH4, I18's ensureCheckout): cloned
// under /home/bot/repos/<owner>/<name> as the `runner` user, with the group
// writable so `coder` and `bot` share it, and fetched before each session. Its
// `repo_checkouts` row says what is on disk: `cloning` while git works, then
// `ready`, `behind` (the default branch is behind origin) or `dirty` (the
// main worktree has changes), or `error` with git's message. Sessions work
// in worktrees of their own under the checkout's `.worktrees/`.
//
// Every git command runs through `runGit`: a `/coder` process of its own as
// the `runner` user (uid 1801, group `coders`), whose environment a coding
// session cannot read, and whose credential requests the runner answers
// itself (git-credentials.ts, `runnerSessionIds`). One fetch per checkout runs at a time in this
// process; two worker processes fetching the same repository at once is
// left to git's own locks.

type CheckoutDeps = AppDeps;
export type RepoRow = typeof schema.repos.$inferSelect;
export type CheckoutRow = typeof schema.repoCheckouts.$inferSelect;

/** How long one git command may run: a first clone of a large repository takes a while. */
export const GIT_TIMEOUT_MS = 15 * 60_000;
/** The most of a command's output kept. */
const OUTPUT_MAX = 256 * 1024;

export interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never ran, or the connection to it dropped. */
  error?: string;
  /** With `headChars`: stdout went past it and was cut. */
  truncated?: boolean;
}

export interface GitContext {
  deps: CheckoutDeps;
  agent: ComputerAgentClient;
  owner: { id: string; workspaceId: string };
  /** The repository the commands work on: git's credentials are served for it only. */
  repoFullName?: string | null;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly run: GitRun,
  ) {
    const said = (run.error ?? run.stderr).trim().split('\n').filter(Boolean).pop();
    super(
      `git ${args[0] === '-C' ? (args[2] ?? '') : (args[0] ?? '')} failed: ${said ?? `exit ${run.code}`}`,
    );
  }
}

/**
 * Config every runner git command starts with. The runner runs git in
 * checkouts a coding agent (the `coder` user, in the same group) can write,
 * so a repository's own `.git/config` is untrusted: a planted
 * `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.askPass` or
 * `gpg.program` would run a script inside a git process whose environment
 * holds the runner's credential secret, an odd transport (`ext::`,
 * `file://`) could reach past the credential helper, and a proxy, a CA or
 * an extra header would hand the credential to someone else. Command line
 * `-c` wins over the repository's config and its includes for a plain key;
 * a `http.<url>.*` key is matched by how much of the url it names, so one
 * naming more than `https://github.com/` still wins, and `assertRunnable`
 * refuses those. Each entry is one git 2.43 (Ubuntu 24.04) takes as `-c`:
 * an empty `http.proxy` turns the proxy off (the environment's too), an
 * empty `http.extraHeader` clears the list. `core.gitProxy` is left out
 * (its first value wins, and `git://` is never allowed), and so is
 * `http.sslBackend` (Ubuntu's git has GnuTLS only and dies on another). The
 * agent's own GIT_CONFIG_* env entries (the credential helper,
 * safe.directory) are kept.
 */
export const RUNNER_GIT_CONFIG: readonly string[] = [
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
  'core.alternateRefsCommand=',
  'http.proxy=',
  'http.sslVerify=true',
  'http.sslCAInfo=/etc/ssl/certs/ca-certificates.crt',
  'http.extraHeader=',
  'http.https://github.com/.proxy=',
  'http.https://github.com/.sslVerify=true',
  'http.https://github.com/.extraHeader=',
].flatMap((entry) => ['-c', entry]);

/**
 * Runs git as `runner` in the computer and waits for it to end: its exit
 * code and output. Credentials it asks for are served as the runner's own,
 * for `ctx.repoFullName` only, and a push credential only with `push` (the
 * push the owner approved).
 */
export function runGit(ctx: GitContext, args: string[], options: RunnerOptions = {}) {
  return runAsRunner(ctx, 'git', [...RUNNER_GIT_CONFIG, ...args], options);
}

export interface RunnerOptions {
  cwd?: string;
  timeoutMs?: number;
  /** The push the owner approved (or a rescue): git gets a push credential. */
  push?: boolean;
  /** The credential asked for may write to the repository (a rescue push, GH5). */
  write?: boolean;
  /**
   * Keep the first `headChars` characters of stdout instead of the last
   * OUTPUT_MAX (a session's diff); `truncated` says when more came.
   */
  headChars?: number;
}

/**
 * Runs `command` as `runner` in the computer and waits for it to end, as
 * `runGit` does for git: the scan's `find`, a deleted checkout's `rm`.
 */
export async function runAsRunner(
  ctx: GitContext,
  command: string,
  args: string[],
  { cwd, timeoutMs = GIT_TIMEOUT_MS, push = false, write = false, headChars }: RunnerOptions = {},
): Promise<GitRun> {
  const sessionId = `runner-${randomUUID()}`;
  // `write` is the credentials' own flag (git-credentials.ts), set only when asked.
  runnerSessionIds.set(sessionId, {
    repoFullName: ctx.repoFullName ?? null,
    push,
    ...(write ? { write: true } : {}),
  } as RunnerGit);
  let stdout = '';
  let stderr = '';
  let truncated = false;
  const keep = (sofar: string, data: string) => (sofar + data).slice(-OUTPUT_MAX);
  const keepHead = (sofar: string, data: string) => {
    if (sofar.length + data.length <= headChars!) return sofar + data;
    truncated = true;
    return (sofar + data).slice(0, headChars);
  };
  try {
    return await new Promise<GitRun>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void proc?.close();
        resolve({ code: null, stdout, stderr, error: `${command} took too long` });
      }, timeoutMs);
      let proc: Awaited<ReturnType<ComputerAgentClient['coder']>> | undefined;
      ctx.agent
        .coder(
          {
            session_id: sessionId,
            user: 'runner',
            command,
            args,
            ...(cwd ? { cwd } : {}),
            // git never waits on a terminal prompt for a username, reads no system
            // gitattributes, and takes no optional lock (`--no-optional-locks`), so a
            // `status` or `worktree list` never rewrites the index a session works on.
            env: { GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
            git_credentials: true,
          },
          {
            stdout: (data) =>
              (stdout = headChars === undefined ? keep(stdout, data) : keepHead(stdout, data)),
            stderr: (data) => (stderr = keep(stderr, data)),
            permissionRequest: () => {},
            credentialRequest: (request) => {
              resolveGitCredential(ctx.deps, {
                ownerId: ctx.owner.id,
                workspaceId: ctx.owner.workspaceId,
                host: request.host,
                path: request.path,
                username: request.username,
                sessionId,
              })
                .then((answer) => proc?.credential({ request_id: request.request_id, ...answer }))
                .catch((error: unknown) => {
                  ctx.deps.logger.warn({ err: error }, 'git credential not answered');
                  proc?.credential({ request_id: request.request_id, denied: 'No credential' });
                });
            },
            exit: (info) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({
                code: info.code,
                stdout,
                stderr,
                ...(info.error ? { error: info.error } : {}),
                ...(truncated ? { truncated } : {}),
              });
            },
          },
        )
        .then((opened) => {
          proc = opened;
          if (settled) void opened.close();
          // git reads nothing from stdin; EOF once it runs, so nothing waits on it.
          opened.started
            .then(() => {
              if (!settled) opened.end();
            })
            .catch(() => {});
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } finally {
    runnerSessionIds.delete(sessionId);
  }
}

/** `runGit` that throws a `GitError` unless git exits 0; returns its stdout. */
export async function git(ctx: GitContext, args: string[], options?: RunnerOptions) {
  const run = await runGit(ctx, args, options);
  if (run.code !== 0) throw new GitError(args, run);
  return run.stdout;
}

/**
 * A repository by its full name on its host: `owner/name`, as the policy
 * spells it. Neither part is dots only, so a path made from it (`~/repos/..`)
 * stays where it says.
 */
export const REPO_FULL_NAME = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/** `owner/name` and the host, from the full name or the remote url. */
export function remoteOf(repo: Pick<RepoRow, 'fullName' | 'remoteUrl'>): {
  host: string;
  fullName: string;
} {
  const url = repo.remoteUrl.trim();
  let host = 'github.com';
  let path = '';
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      // Not a url: the full name has to say which repository it is.
    }
  }
  const fromUrl = path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  const fullName = repo.fullName?.trim() || fromUrl;
  if (!REPO_FULL_NAME.test(fullName)) {
    throw new Error(`Cannot tell the repository from ${url}`);
  }
  return { host: host.toLowerCase(), fullName };
}

/**
 * The fetch and push urls the runner gives `origin`: the username says which
 * one git uses. A GitHub remote is spelled from its full name; any other
 * host's is the stored remote as it is (its path may be deeper than
 * `owner/name`), with the username put in when it is an https url.
 */
export function remoteUrls(repo: Pick<RepoRow, 'fullName' | 'remoteUrl'>) {
  const { host, fullName } = remoteOf(repo);
  if (host === 'github.com') {
    return {
      fetch: `https://${FETCH_USERNAME}@${host}/${fullName}.git`,
      push: `https://${PUSH_USERNAME}@${host}/${fullName}.git`,
    };
  }
  const as = (username: string) => {
    try {
      const url = new URL(repo.remoteUrl.trim());
      if (url.protocol !== 'https:') return repo.remoteUrl.trim();
      url.username = username;
      url.password = '';
      return url.toString();
    } catch {
      return repo.remoteUrl.trim();
    }
  };
  return { fetch: as(FETCH_USERNAME), push: as(PUSH_USERNAME) };
}

/** What `assertRunnable` refuses with, before the keys it found. */
export const CONFIG_REFUSED =
  "The repository's git configuration was changed in a way OpenBots does not run; remove it or forget and clone the repository again";

/**
 * Keys of a checkout's own config (`git config --list` spells the section
 * and the name in lower case) that could reach past `RUNNER_GIT_CONFIG`:
 * another transport, proxy or credential, a command git runs, or more
 * config read from elsewhere.
 */
const REFUSED_KEYS: readonly RegExp[] = [
  /^http\./i,
  /^url\./i,
  /^core\.sshcommand$/i,
  /^core\.hookspath$/i,
  /^core\.fsmonitor$/i,
  /^core\.gitproxy$/i,
  /^core\.pager$/i,
  /^core\.editor$/i,
  /^core\.attributesfile$/i,
  /^core\.excludesfile$/i,
  /^core\.alternaterefscommand$/i,
  /^core\.alternaterefsprefixes$/i,
  /^sequence\.editor$/i,
  /^pager\./i,
  /^credential\./i,
  /^include/i,
  /^alias\./i,
  /^diff\.external$/i,
  /^diff\..+\.textconv$/i,
  /^filter\./i,
  /^uploadpack\./i,
  /^receive\./i,
  /^remote\.[^.]+\.proxy/i,
  // Any command or driver git may run: `diff.<x>.command`, `merge.<x>.driver`, gc's and others.
  /\.command$/i,
  /\.driver$/i,
];

/** `git config --list -z`: each entry's key and value (null for a key alone). */
export function parseConfigList(stdout: string): { key: string; value: string | null }[] {
  return stdout
    .split('\0')
    .filter((entry) => entry.length)
    .map((entry) => {
      const nl = entry.indexOf('\n');
      return nl < 0
        ? { key: entry, value: null }
        : { key: entry.slice(0, nl), value: entry.slice(nl + 1) };
    });
}

/**
 * The keys in a checkout's config that `assertRunnable` refuses: any key
 * `REFUSED_KEYS` names, and an `origin` url or push url other than the
 * runner's own (or, for the url, the remote as stored, which a clone found
 * on the computer still has).
 */
export function refusedKeys(
  entries: { key: string; value: string | null }[],
  allowed: { urls: string[]; pushUrls: string[] },
): string[] {
  const out = new Set<string>();
  for (const { key, value } of entries) {
    const lower = key.toLowerCase();
    if (REFUSED_KEYS.some((re) => re.test(key))) out.add(key);
    else if (lower === 'remote.origin.url' && !allowed.urls.includes(value ?? '')) out.add(key);
    else if (lower === 'remote.origin.pushurl' && !allowed.pushUrls.includes(value ?? '')) {
      out.add(key);
    }
  }
  return [...out];
}

/** One short read of a checkout: a config file, a directory listing. */
const SHORT_MS = 60_000;

/** The computer's `runner` user (computer-agent): the one owner of a checkout's config. */
export const RUNNER_UID = 1801;

/**
 * Makes the parts of a checkout's `.git` only the runner writes its own
 * again: `.git/config` 0644, `.git/hooks` and `.git/info` without group or
 * other write. Objects, refs, the index and logs stay group writable, so a
 * session (`coder`, in the `coders` group) still commits. A chmod that
 * fails (a hooks directory that is not there) is not an error here; the
 * config's owner and mode are checked after (`assertRunnable`).
 */
export async function lockDown(ctx: GitContext, path: string): Promise<void> {
  const gitDir = posix.join(path, '.git');
  for (const args of [
    ['0644', '--', posix.join(gitDir, 'config')],
    ['-R', 'go-w', '--', posix.join(gitDir, 'hooks'), posix.join(gitDir, 'info')],
  ]) {
    const run = await runAsRunner(ctx, 'chmod', args, { timeoutMs: SHORT_MS });
    if (run.error) throw new Error(run.error);
  }
}

/**
 * Throws `CONFIG_REFUSED` unless every file is the runner's and nobody else
 * may write it: one a session could change is changed by the time git
 * reads it.
 */
async function assertRunnerOwned(ctx: GitContext, files: string[]): Promise<void> {
  const run = await runAsRunner(ctx, 'stat', ['-c', '%u %a %n', '--', ...files], {
    timeoutMs: SHORT_MS,
  });
  if (run.error) throw new Error(run.error);
  if (run.code !== 0) throw new Error(`${CONFIG_REFUSED} (${files.join(', ')} could not be read)`);
  const open: string[] = [];
  for (const line of run.stdout.split('\n').filter((l) => l.trim())) {
    const [uid, mode, ...name] = line.trim().split(' ');
    const bits = Number.parseInt(mode ?? '', 8);
    if (Number(uid) !== RUNNER_UID || !Number.isFinite(bits) || bits & 0o022) {
      open.push(name.join(' '));
    }
  }
  if (open.length) {
    throw new Error(`${CONFIG_REFUSED}: ${open.join(', ')} can be changed by a coding session`);
  }
}

/**
 * Reads the checkout's own config as files (no repository discovery, no
 * includes followed) before the runner runs git there: `.git/config`, and
 * every `config.worktree` when the repository turned them on, after
 * `lockDown` and a check that each is the runner's own and no one else's
 * to write. Throws `CONFIG_REFUSED` with the keys when any is one the
 * runner does not run with, or with the files a session could change.
 * Nothing else of the checkout is touched.
 */
export async function assertRunnable(
  ctx: GitContext,
  path: string,
  repo: Pick<RepoRow, 'fullName' | 'remoteUrl'>,
): Promise<void> {
  const urls = remoteUrls(repo);
  const allowed = { urls: [urls.fetch, repo.remoteUrl], pushUrls: [urls.push] };
  const read = async (file: string) => {
    const run = await runGit(ctx, ['config', '--file', file, '--list', '-z'], {
      timeoutMs: SHORT_MS,
    });
    if (run.error) throw new Error(run.error);
    if (run.code !== 0) throw new Error(`${CONFIG_REFUSED} (${file} could not be read)`);
    return parseConfigList(run.stdout);
  };
  const gitDir = posix.join(path, '.git');
  await lockDown(ctx, path);
  await assertRunnerOwned(ctx, [posix.join(gitDir, 'config')]);
  const main = await read(posix.join(gitDir, 'config'));
  const entries = [...main];
  const worktreeConfig = main.some(
    (e) =>
      e.key.toLowerCase() === 'extensions.worktreeconfig' &&
      !/^(false|no|off|0)$/i.test(e.value ?? 'true'),
  );
  if (worktreeConfig) {
    // git reads these only with the extension on: the main worktree's and each session's.
    const found = await runAsRunner(
      ctx,
      'find',
      [gitDir, '-maxdepth', '3', '-name', 'config.worktree', '-type', 'f'],
      { timeoutMs: SHORT_MS },
    );
    if (found.error) throw new Error(found.error);
    const files = found.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length) {
      await runAsRunner(ctx, 'chmod', ['0644', '--', ...files], { timeoutMs: SHORT_MS });
      await assertRunnerOwned(ctx, files);
    }
    for (const file of files) entries.push(...(await read(file)));
  }
  const keys = refusedKeys(entries, allowed);
  if (keys.length) throw new Error(`${CONFIG_REFUSED}: ${keys.join(', ')}`);
}

/**
 * What is at a checkout's path: the repository itself (git's top level is
 * the path, both read through `realpath`), nothing (missing or an empty
 * directory, so a clone may go there), a directory inside some other
 * repository, or a directory with files that is no repository.
 */
export async function locateCheckout(
  ctx: GitContext,
  path: string,
): Promise<'repo' | 'empty' | 'other' | 'occupied'> {
  const top = await runGit(ctx, ['-C', path, 'rev-parse', '--show-toplevel'], {
    timeoutMs: SHORT_MS,
  });
  if (top.error) throw new Error(top.error);
  const shown = top.code === 0 ? top.stdout.trim() : '';
  if (shown) {
    if (shown === path) return 'repo';
    const real = await runAsRunner(ctx, 'realpath', ['-e', '--', path, shown], {
      timeoutMs: SHORT_MS,
    });
    const [a, b] = real.code === 0 ? real.stdout.trim().split('\n') : [];
    if (a && a === b) return 'repo';
  }
  const list = await runAsRunner(
    ctx,
    'find',
    [path, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'],
    { timeoutMs: SHORT_MS },
  );
  if (list.error) throw new Error(list.error);
  // find fails on a path that is not there: nothing is in the way of a clone.
  if (list.code !== 0 || !list.stdout.trim()) return 'empty';
  return shown ? 'other' : 'occupied';
}

/** What `ensureCheckout` refuses a path inside another repository with. */
export const OTHER_REPOSITORY = 'A different repository is at this path';

/** Where a repository is cloned on the computer: `~/repos/<owner>/<name>`. */
export function checkoutPathFor(repo: Pick<RepoRow, 'fullName' | 'remoteUrl'>): string {
  const { fullName } = remoteOf(repo);
  const path = posix.join(REPOS_DIR, fullName);
  // REPO_FULL_NAME has no dot-only part, so this holds; kept so a change there cannot escape.
  if (path !== `${REPOS_DIR}/${fullName}`) throw new Error(`Cannot clone ${fullName} there`);
  return path;
}

/** A branch name as a directory name: `bot/fix-loop` is `bot-fix-loop`. */
export function branchSlug(branch: string): string {
  return (
    branch
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'session'
  );
}

/** The worktree a session on `branch` works in. */
export function worktreePathFor(repoPath: string, branch: string): string {
  return posix.join(repoPath, '.worktrees', branchSlug(branch));
}

// One checkout operation at a time per (repository, computer) in this process.
const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` alone among this process's operations on the checkout. */
export function withCheckoutLock<T>(
  repoId: string,
  computerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return locked(`${repoId}:${computerId}`, fn);
}

function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const next = before.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

/** Status lines of the main worktree, less the sessions' own worktrees beneath it. */
export const dirtyLines = (porcelain: string) =>
  porcelain
    .split('\n')
    .filter((line) => line.trim() && !/^\?\? \.worktrees\/?$/.test(line.trim()))
    .filter((line) => !line.slice(3).startsWith('.worktrees/'));

/** A checkout as `ensureCheckout` leaves it, with the remote's default branch. */
export type Checkout = CheckoutRow & { defaultBranch: string };

/**
 * Makes the repository's checkout on the computer current: clones it when
 * it is not there, else fetches, then records its state. The remote's
 * default branch is read each time (`origin/HEAD`) and kept on the
 * repository's row when it changed. `action` says why it was asked for (a
 * clone or update job, or a session); either way the outcome is a current
 * checkout. A clone the owner asked for (`action` `clone`: the picker, Add
 * by URL, Clone) starts a stopped computer, as a session does; reconcile
 * passes `startStopped: false`, since it runs on a running one only.
 * Throws with git's message when it fails, after recording `error`.
 */
export async function ensureCheckout(
  deps: CheckoutDeps,
  repoId: string,
  computerId: string,
  action: 'clone' | 'update' = 'update',
  { startStopped = action === 'clone' }: { startStopped?: boolean } = {},
): Promise<Checkout> {
  const [repo] = await deps.db.select().from(schema.repos).where(eq(schema.repos.id, repoId));
  if (!repo) throw new Error('The repository is no longer remembered');
  let [computer] = await deps.db
    .select()
    .from(schema.computers)
    .where(eq(schema.computers.id, computerId));
  if (!computer) throw new Error('The computer is gone');
  if (startStopped && computer.status !== 'running') {
    computer = (
      await startComputer(
        deps,
        { id: computer.ownerId, workspaceId: computer.workspaceId },
        SYSTEM_ACTOR,
      )
    ).computer;
  }
  const ctx: GitContext = {
    deps,
    agent: agentFor(deps, computer),
    owner: { id: repo.ownerId, workspaceId: repo.workspaceId },
    repoFullName: remoteOf(repo).fullName,
  };
  return locked(`${repoId}:${computerId}`, () => checkout(ctx, repo, computerId));
}

/** A branch name git could have printed; anything else is not used. */
const BRANCH_NAME = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/**
 * The remote's default branch, from `origin/HEAD` after asking the remote
 * for it; null when git cannot say.
 */
export async function remoteDefaultBranch(ctx: GitContext, path: string): Promise<string | null> {
  await runGit(ctx, ['-C', path, 'remote', 'set-head', 'origin', '--auto']);
  const head = await runGit(ctx, ['-C', path, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (head.code !== 0) return null;
  const branch = /^refs\/remotes\/origin\/(.+)$/.exec(head.stdout.trim())?.[1];
  return branch && BRANCH_NAME.test(branch) && !branch.includes('..') ? branch : null;
}

async function checkout(ctx: GitContext, repo: RepoRow, computerId: string): Promise<Checkout> {
  const { deps } = ctx;
  const standard = checkoutPathFor(repo);
  const urls = remoteUrls(repo);
  // A row already there keeps its path: a clone remembered where it was found (GH6).
  const [row] = await deps.db
    .insert(schema.repoCheckouts)
    .values({
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      computerId,
      path: standard,
      state: 'cloning',
    })
    .onConflictDoUpdate({
      target: [schema.repoCheckouts.repoId, schema.repoCheckouts.computerId],
      set: { state: 'cloning', error: null, updatedAt: new Date() },
    })
    .returning();
  try {
    let path = row!.path;
    let at = await locateCheckout(ctx, path);
    if (at !== 'repo' && path !== standard) {
      // Gone from where it was found: cloned again at the usual place.
      path = standard;
      at = await locateCheckout(ctx, path);
    }
    if (path !== row!.path) {
      await deps.db
        .update(schema.repoCheckouts)
        .set({ path })
        .where(eq(schema.repoCheckouts.id, row!.id));
    }
    // A path inside some other repository is never taken for this one's checkout.
    if (at === 'other') throw new Error(OTHER_REPOSITORY);
    if (at === 'repo') {
      await assertRunnable(ctx, path, repo);
      // Set first, so a checkout made some other way fetches as `fetch` too.
      await git(ctx, ['-C', path, 'config', 'remote.origin.url', urls.fetch]);
      await git(ctx, ['-C', path, 'config', 'remote.origin.pushurl', urls.push]);
      // git config writes the file anew, group writable under umask 002.
      await lockDown(ctx, path);
      await git(ctx, ['-C', path, 'fetch', '--prune', 'origin']);
    } else {
      await git(ctx, ['clone', '--config', 'core.sharedRepository=group', urls.fetch, path]);
      await git(ctx, ['-C', path, 'config', 'remote.origin.pushurl', urls.push]);
      await lockDown(ctx, path);
    }
    const detected = await remoteDefaultBranch(ctx, path);
    const branch = detected ?? repo.defaultBranch;
    if (detected && detected !== repo.defaultBranch) {
      await deps.db
        .update(schema.repos)
        .set({ defaultBranch: detected, updatedAt: new Date() })
        .where(eq(schema.repos.id, repo.id));
    }
    const head = (await git(ctx, ['-C', path, 'rev-parse', 'HEAD'])).trim();
    const counts = await runGit(ctx, [
      '-C',
      path,
      'rev-list',
      '--left-right',
      '--count',
      `${branch}...origin/${branch}`,
    ]);
    const [ahead = 0, behind = 0] =
      counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    const dirty = dirtyLines(await git(ctx, ['-C', path, 'status', '--porcelain'])).length > 0;
    const [ready] = await deps.db
      .update(schema.repoCheckouts)
      .set({
        state: dirty ? 'dirty' : behind > 0 ? 'behind' : 'ready',
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
        headSha: head || null,
        lastFetchAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.repoCheckouts.id, row!.id))
      .returning();
    return { ...ready!, defaultBranch: branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.db
      .update(schema.repoCheckouts)
      .set({ state: 'error', error: message.slice(0, 2_000), updatedAt: new Date() })
      .where(eq(schema.repoCheckouts.id, row!.id));
    throw error;
  }
}

/**
 * The session's worktree on `branch`: kept when it is already there (a
 * continued session), else added from the branch when it exists, else made
 * as a new branch from `origin/<base>`.
 */
export async function ensureWorktree(
  ctx: GitContext,
  repoPath: string,
  branch: string,
  base: string,
): Promise<string> {
  const path = worktreePathFor(repoPath, branch);
  const there = await runGit(ctx, ['-C', path, 'rev-parse', '--is-inside-work-tree']);
  if (there.code === 0) return path;
  // A worktree removed by hand leaves its record; prune drops it.
  await runGit(ctx, ['-C', repoPath, 'worktree', 'prune']);
  const local = await runGit(ctx, [
    '-C',
    repoPath,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (local.code === 0) {
    await git(ctx, ['-C', repoPath, 'worktree', 'add', path, branch]);
  } else {
    await git(ctx, ['-C', repoPath, 'worktree', 'add', path, '-b', branch, `origin/${base}`]);
  }
  await lockDown(ctx, repoPath);
  return path;
}
