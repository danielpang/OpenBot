import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { COMPUTER_HOME, REPOS_DIR, type ComputerAgentClient } from '@openbots/computer';
import {
  REPO_FETCH_INTERVAL_MS,
  REPO_SCAN_DEPTH,
  RepoRescueResultSchema,
  rescueBranchName,
  type EventBus,
  type RepoRescueResult,
} from '@openbots/shared';
import { and, eq, inArray, isNotNull, lt, max, notInArray, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { notFound } from '../errors.js';
import { SYSTEM_ACTOR } from './audit.js';
import { mainBotOf } from './bots.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { agentFor, startComputer } from './computer.js';
import { postMessage } from './messages.js';
import {
  assertRunnable,
  branchSlug,
  dirtyLines,
  ensureCheckout,
  git,
  remoteDefaultBranch,
  remoteOf,
  runAsRunner,
  runGit,
  withCheckoutLock,
  type CheckoutRow,
  type GitContext,
  type RepoRow,
} from './repos-checkout.js';
import { parseRepoUrl } from './repos.js';

// The remembered repositories' background jobs on the `coders` queue (GH4 to
// GH6; I18): the scan for clones nobody remembered, the periodic fetch that
// keeps each checkout's state current, the reconcile after every computer
// start that clones again what a new home volume lost, and rescue before
// loss. Each runs git as `runner` through repos-checkout.ts, and none starts
// the computer except rescue, which needs it up to save anything. Before git
// runs in a checkout, its config is checked (`assertRunnable`).

type Owner = { id: string; workspaceId: string };
type ComputerRow = typeof schema.computers.$inferSelect;

/** The most repositories one scan records; the rest are left for the owner to tidy. */
export const SCAN_MAX = 200;
/** A refresh is not queued again sooner than this after the last one. */
export const REFRESH_MIN_GAP_MS = 10 * 60_000;
/** How long a rescue's results stay readable. */
export const RESCUE_TTL_MS = 10 * 60_000;
/** One short git command (a config read, a status): not a clone. */
const SHORT_MS = 60_000;

/** Checkout states a fetch can make current: not one a job is changing, nor one not on disk. */
const SETTLED = ['ready', 'behind', 'dirty', 'error'];
/** A checkout `cloning` or `updating` this long was left by a job that died: reconcile retries it. */
export const STUCK_MS = 30 * 60_000;
/** Session statuses whose worktree rescue leaves alone: the agent is working there. */
const LIVE_SESSION = ['starting', 'running', 'waiting'];

interface Running {
  computer: ComputerRow;
  owner: Owner;
  agent: ComputerAgentClient;
}

/** The computer when it is running, never starting it. */
async function running(deps: AppDeps, computerId: string): Promise<Running | null> {
  const [computer] = await deps.db
    .select()
    .from(schema.computers)
    .where(eq(schema.computers.id, computerId));
  if (computer?.status !== 'running') return null;
  return {
    computer,
    owner: { id: computer.ownerId, workspaceId: computer.workspaceId },
    agent: agentFor(deps, computer),
  };
}

function contextFor(deps: AppDeps, on: Running, repo?: RepoRow): GitContext {
  let repoFullName: string | null = null;
  if (repo) {
    try {
      repoFullName = remoteOf(repo).fullName;
    } catch {
      // A remote git cannot name: no credential is served for it.
    }
  }
  return { deps, agent: on.agent, owner: on.owner, repoFullName };
}

/** Whether the checkout is on disk; throws when the computer could not be asked. */
async function onDisk(ctx: GitContext, path: string): Promise<boolean> {
  const run = await runAsRunner(ctx, 'test', ['-e', posix.join(path, '.git')], {
    timeoutMs: SHORT_MS,
  });
  if (run.error) throw new Error(run.error);
  return run.code === 0;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Scan (GH6)

/**
 * The repositories in `find`'s output: each `.git` line's directory, under
 * /home/bot, none inside a session's `.worktrees/` or a `node_modules`,
 * each once, at most `SCAN_MAX`.
 */
export function parseFindOutput(stdout: string): string[] {
  const dirs = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${COMPUTER_HOME}/`) || !line.endsWith('/.git')) continue;
    // A path with a `.` or `..` part is not one find prints; it is not used.
    if (line.split('/').some((part) => part === '.' || part === '..')) continue;
    const dir = posix.normalize(posix.dirname(line));
    if (dir.split('/').some((part) => part === '.worktrees' || part === 'node_modules')) continue;
    if (dir === COMPUTER_HOME || !dir.startsWith(`${COMPUTER_HOME}/`)) continue;
    dirs.add(dir);
    if (dirs.size >= SCAN_MAX) break;
  }
  return [...dirs];
}

/**
 * A remote as `origin` names it, read as remembered repositories store
 * theirs; null when it is not one OpenBots can clone again. A user name or
 * token in the URL (the runner's own `fetch@`, or one typed by hand) is
 * dropped first, so it is never stored.
 */
export function readRemote(
  raw: string,
): { fullName: string; remoteUrl: string; host: string } | null {
  let value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      value = url.toString();
    }
  } catch {
    // An scp-style remote (`git@host:owner/name.git`): parseRepoUrl reads it.
  }
  try {
    return parseRepoUrl(value);
  } catch {
    return null;
  }
}

export interface ScanResult {
  /** Clones nobody remembered, now listed as found. */
  found: number;
  /** Remembered repositories whose checkout the scan saw. */
  matched: number;
}

/**
 * Looks for `.git` under /home/bot, `REPO_SCAN_DEPTH` levels deep, as
 * `coder`, and reads each one's `origin`. A clone of a remembered
 * repository under ~/repos updates that checkout's row (a `missing` one is
 * there after all); any other becomes a found repository (`found_path`,
 * `keep_cloned` false). Found rows the scan no longer sees are dropped,
 * unless `find` failed and printed nothing: then nothing is known and
 * nothing changes. Never clones anything.
 */
export async function scanComputer(deps: AppDeps, computerId: string): Promise<ScanResult> {
  const on = await running(deps, computerId);
  if (!on) return { found: 0, matched: 0 };
  const ctx = contextFor(deps, on);
  const run = await runAsRunner(
    ctx,
    'find',
    [COMPUTER_HOME, '-maxdepth', String(REPO_SCAN_DEPTH + 1), '-name', '.git', '-prune'],
    { timeoutMs: SHORT_MS },
  );
  // find exits 1 for a directory `coder` may not read; what it printed still counts.
  if (run.error) throw new Error(`The scan did not run: ${run.error}`);
  if (run.code !== 0 && !run.stdout.trim()) return { found: 0, matched: 0 };
  const dirs = parseFindOutput(run.stdout);
  const ownedBy = and(
    eq(schema.repos.ownerId, on.owner.id),
    eq(schema.repos.workspaceId, on.owner.workspaceId),
  );
  const repos = await deps.db.select().from(schema.repos).where(ownedBy);
  const seen: string[] = [];
  let matched = 0;
  for (const dir of dirs) {
    // The file read as a file: no repository discovery, no hooks, nothing the repository configures.
    const origin = await runGit(
      ctx,
      ['config', '--file', posix.join(dir, '.git', 'config'), '--get', 'remote.origin.url'],
      { timeoutMs: SHORT_MS },
    );
    if (origin.code !== 0) continue;
    const remote = readRemote(origin.stdout);
    if (!remote) continue;
    const known = repos.find((r) => r.remoteUrl === remote.remoteUrl);
    if (known && known.foundPath === null) {
      // Remembered and cloned elsewhere than ~/repos: the checkout row stays as it is.
      if (!dir.startsWith(`${REPOS_DIR}/`)) continue;
      matched++;
      await deps.db
        .insert(schema.repoCheckouts)
        .values({
          workspaceId: known.workspaceId,
          repoId: known.id,
          computerId,
          path: dir,
          state: 'ready',
        })
        .onConflictDoUpdate({
          target: [schema.repoCheckouts.repoId, schema.repoCheckouts.computerId],
          set: {
            path: dir,
            state: sql`case when ${schema.repoCheckouts.state} = 'missing' then 'ready' else ${schema.repoCheckouts.state} end`,
            updatedAt: new Date(),
          },
        });
      continue;
    }
    seen.push(dir);
    await deps.db
      .insert(schema.repos)
      .values({
        workspaceId: on.owner.workspaceId,
        ownerId: on.owner.id,
        fullName: remote.fullName,
        remoteUrl: remote.remoteUrl,
        keepCloned: false,
        foundPath: dir,
      })
      .onConflictDoUpdate({
        target: [schema.repos.workspaceId, schema.repos.ownerId, schema.repos.remoteUrl],
        set: { foundPath: dir, updatedAt: new Date() },
        // A remembered repository is never turned back into a found one.
        setWhere: isNotNull(schema.repos.foundPath),
      });
  }
  await deps.db
    .delete(schema.repos)
    .where(
      and(
        ownedBy,
        isNotNull(schema.repos.foundPath),
        ...(seen.length ? [notInArray(schema.repos.foundPath, seen)] : []),
      ),
    );
  return { found: seen.length, matched };
}

// Refresh (GH3)

/** `git worktree list --porcelain`: each worktree's path and branch (null when detached). */
export function parseWorktreeList(stdout: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push({ path: line.slice(9).trim(), branch: null });
    else if (line.startsWith('branch ') && out.length) {
      out[out.length - 1]!.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
  }
  return out;
}

/** The sessions' worktrees of a checkout: every worktree but the main one. */
async function worktreesOf(ctx: GitContext, path: string) {
  const list = await runGit(ctx, ['-C', path, 'worktree', 'list', '--porcelain'], {
    timeoutMs: SHORT_MS,
  });
  if (list.code !== 0) return [];
  return parseWorktreeList(list.stdout).filter((w) => posix.normalize(w.path) !== path);
}

/** Computers with a refresh queued from this process, and when it was. */
const refreshQueued = new Map<string, number>();
/** When this process last ran a refresh per computer. */
const refreshRan = new Map<string, number>();

/**
 * Fetches every settled checkout on the computer (`git fetch --prune`, as
 * the runner, for that repository only), then records ahead and behind of
 * the default branch against origin, whether the main worktree or any
 * session worktree has changes, the head, and the remote's last commit time
 * on its default branch as the repository's `last_remote_push_at`. A
 * checkout gone from disk becomes `missing`; one git fails on, `error`.
 * Returns how many it fetched.
 */
export async function refreshStates(deps: AppDeps, computerId: string): Promise<number> {
  refreshQueued.delete(computerId);
  refreshRan.set(computerId, Date.now());
  const on = await running(deps, computerId);
  if (!on) return 0;
  const rows = await deps.db
    .select({ checkout: schema.repoCheckouts, repo: schema.repos })
    .from(schema.repoCheckouts)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
    .where(
      and(
        eq(schema.repoCheckouts.computerId, computerId),
        inArray(schema.repoCheckouts.state, SETTLED),
      ),
    );
  let fetched = 0;
  for (const { checkout, repo } of rows) {
    const ok = await withCheckoutLock(repo.id, computerId, () =>
      refreshOne(deps, contextFor(deps, on, repo), repo, checkout),
    );
    if (ok) fetched++;
  }
  return fetched;
}

async function refreshOne(
  deps: AppDeps,
  ctx: GitContext,
  repo: RepoRow,
  checkout: CheckoutRow,
): Promise<boolean> {
  const { path } = checkout;
  const set = (values: Partial<CheckoutRow>) =>
    deps.db
      .update(schema.repoCheckouts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.repoCheckouts.id, checkout.id));
  try {
    if (!(await onDisk(ctx, path))) {
      await set({ state: 'missing', error: null });
      return false;
    }
    await assertRunnable(ctx, path, repo);
    await git(ctx, ['-C', path, 'fetch', '--prune', 'origin']);
    const detected = await remoteDefaultBranch(ctx, path);
    const branch = detected ?? repo.defaultBranch;
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
    const head = await runGit(ctx, ['-C', path, 'rev-parse', 'HEAD']);
    let dirty = dirtyLines(await git(ctx, ['-C', path, 'status', '--porcelain'])).length > 0;
    for (const worktree of dirty ? [] : await worktreesOf(ctx, path)) {
      const status = await runGit(ctx, ['-C', worktree.path, 'status', '--porcelain']);
      if (status.code === 0 && status.stdout.trim()) {
        dirty = true;
        break;
      }
    }
    const pushed = await runGit(ctx, ['-C', path, 'log', '-1', '--format=%cI', `origin/${branch}`]);
    const pushedAt = pushed.code === 0 ? new Date(pushed.stdout.trim()) : null;
    const repoSet: Partial<RepoRow> = {};
    if (detected && detected !== repo.defaultBranch) repoSet.defaultBranch = detected;
    if (pushedAt && !Number.isNaN(pushedAt.getTime())) repoSet.lastRemotePushAt = pushedAt;
    if (Object.keys(repoSet).length) {
      await deps.db
        .update(schema.repos)
        .set({ ...repoSet, updatedAt: new Date() })
        .where(eq(schema.repos.id, repo.id));
    }
    await set({
      state: dirty ? 'dirty' : behind! > 0 ? 'behind' : 'ready',
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      headSha: head.code === 0 ? head.stdout.trim() || null : checkout.headSha,
      lastFetchAt: new Date(),
      error: null,
    });
    return true;
  } catch (error) {
    await set({ state: 'error', error: errorText(error).slice(0, 2_000) });
    return false;
  }
}

/**
 * The periodic fetch (every `REPO_FETCH_INTERVAL_MS`, workers.ts): one
 * `refresh` job per running computer with checkouts, unless one is queued
 * from here already or a refresh ran or fetched there in the last ten
 * minutes. Returns how many it queued.
 */
export async function queueRepoRefreshes(deps: AppDeps, now = Date.now()): Promise<number> {
  const rows = await deps.db
    .select({
      id: schema.computers.id,
      lastFetchAt: max(schema.repoCheckouts.lastFetchAt),
    })
    .from(schema.computers)
    .innerJoin(schema.repoCheckouts, eq(schema.repoCheckouts.computerId, schema.computers.id))
    .where(eq(schema.computers.status, 'running'))
    .groupBy(schema.computers.id);
  let queued = 0;
  for (const row of rows) {
    // A queued job another process took is forgotten after two intervals.
    const at = refreshQueued.get(row.id);
    if (at !== undefined && now - at < 2 * REPO_FETCH_INTERVAL_MS) continue;
    const ran = Math.max(refreshRan.get(row.id) ?? 0, row.lastFetchAt?.getTime() ?? 0);
    if (now - ran < REFRESH_MIN_GAP_MS) continue;
    refreshQueued.set(row.id, now);
    await enqueueCoderJob(deps, { kind: 'refresh', computerId: row.id });
    queued++;
  }
  return queued;
}

/**
 * The periodic scan (every `REPO_FETCH_INTERVAL_MS` beside the refresh,
 * workers.ts): one `scan` job per running computer. Returns how many.
 */
export async function queueRepoScans(deps: AppDeps): Promise<number> {
  const rows = await runningComputerIds(deps);
  for (const { id } of rows) await enqueueCoderJob(deps, { kind: 'scan', computerId: id });
  return rows.length;
}

/**
 * At worker start: one `reconcile` job per running computer, so a computer
 * that started while no worker ran (or whose job was lost) still gets its
 * repositories back. Returns how many.
 */
export async function queueRepoReconciles(deps: AppDeps): Promise<number> {
  const rows = await runningComputerIds(deps);
  for (const { id } of rows) await enqueueCoderJob(deps, { kind: 'reconcile', computerId: id });
  return rows.length;
}

function runningComputerIds(deps: AppDeps) {
  return deps.db
    .select({ id: schema.computers.id })
    .from(schema.computers)
    .where(eq(schema.computers.status, 'running'));
}

// Reconcile (GH4)

export interface ReconcileResult {
  cloned: string[];
  failed: { fullName: string; error: string }[];
}

/**
 * After a computer starts (and at worker start): checkouts no longer on
 * disk become `missing` (a new home volume has none), then every
 * `keep_cloned` repository with no checkout there, a missing one, or one
 * left `cloning` or `updating` for `STUCK_MS` is cloned, most recently used
 * first. The owner's main Bot transcript gets one event row for what was
 * cloned ("again" when one of them had gone missing), and one for what
 * could not be.
 */
export async function reconcileComputer(
  deps: AppDeps,
  computerId: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const result: ReconcileResult = { cloned: [], failed: [] };
  const on = await running(deps, computerId);
  if (!on) return result;
  const checkouts = await deps.db
    .select({ checkout: schema.repoCheckouts, repo: schema.repos })
    .from(schema.repoCheckouts)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
    .where(
      and(
        eq(schema.repoCheckouts.computerId, computerId),
        // A clone or update in flight is that job's to finish.
        notInArray(schema.repoCheckouts.state, ['cloning', 'updating', 'missing']),
      ),
    );
  for (const { checkout, repo } of checkouts) {
    await withCheckoutLock(repo.id, computerId, async () => {
      if (await onDisk(contextFor(deps, on, repo), checkout.path)) return;
      await deps.db
        .update(schema.repoCheckouts)
        .set({ state: 'missing', error: null, updatedAt: new Date() })
        .where(eq(schema.repoCheckouts.id, checkout.id));
    });
  }
  const targets = await deps.db
    .select({ repo: schema.repos, state: schema.repoCheckouts.state })
    .from(schema.repos)
    .leftJoin(
      schema.repoCheckouts,
      and(
        eq(schema.repoCheckouts.repoId, schema.repos.id),
        eq(schema.repoCheckouts.computerId, computerId),
      ),
    )
    .where(
      and(
        eq(schema.repos.ownerId, on.owner.id),
        eq(schema.repos.workspaceId, on.owner.workspaceId),
        eq(schema.repos.keepCloned, true),
        sql`${schema.repos.foundPath} is null`,
        or(
          sql`${schema.repoCheckouts.id} is null`,
          eq(schema.repoCheckouts.state, 'missing'),
          and(
            inArray(schema.repoCheckouts.state, ['cloning', 'updating']),
            lt(schema.repoCheckouts.updatedAt, new Date(now.getTime() - STUCK_MS)),
          ),
        ),
      ),
    )
    .orderBy(sql`${schema.repos.lastUsedAt} desc nulls last`, schema.repos.fullName);
  // A repository whose checkout here had gone missing is cloned again.
  let again = false;
  for (const { repo, state } of targets) {
    try {
      await ensureCheckout(deps, repo.id, computerId, 'clone', { startStopped: false });
      result.cloned.push(repo.fullName);
      if (state === 'missing') again = true;
    } catch (error) {
      result.failed.push({ fullName: repo.fullName, error: errorText(error) });
    }
  }
  if (result.cloned.length) {
    const n = result.cloned.length;
    await postEvent(deps, on.owner, {
      type: 'event',
      kind: 'repos_cloned',
      text: `Cloned ${plural(n, 'repository', 'repositories')}${again ? ' again' : ''}`,
      data: { computerId, repos: result.cloned, again },
    });
  }
  if (result.failed.length) {
    const names = result.failed.map((f) => f.fullName);
    await postEvent(deps, on.owner, {
      type: 'event',
      kind: 'repos_clone_failed',
      text: `Could not clone ${plural(names.length, 'repository', 'repositories')}: ${names.join(', ')}`,
      data: { computerId, failed: result.failed },
    });
  }
  return result;
}

/** A W3 event row in the owner's main Bot transcript; nothing when they have no main Bot. */
async function postEvent(
  deps: AppDeps,
  owner: Owner,
  part: { type: 'event'; kind: string; text: string; data: object },
) {
  const bot = await mainBotOf(deps.db, owner);
  if (!bot) return;
  const [chat] = await deps.db
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.botId, bot.id),
        eq(schema.chats.type, 'bot_dm'),
        eq(schema.chats.ownerId, owner.id),
      ),
    );
  if (!chat) return;
  await postMessage(deps, chat.id, { authorType: 'system', parts: [part] });
}

// Rescue (GH5)

const RESCUE_AUTHOR = ['-c', 'user.name=OpenBots', '-c', 'user.email=rescue@openbots.local'];

/**
 * Saves what would be lost with the computer's home: in each checkout's main
 * worktree and each session worktree, commits not on any remote branch and
 * uncommitted changes go to a new branch, `rescueBranchName(now)` then
 * `/<repository name>/<branch>`, pushed as the runner with a write
 * credential. HEAD, the original branch, the index and the working tree are
 * never touched: uncommitted changes to tracked files become a commit made
 * with `git stash create` (on top of HEAD, so unpushed commits come too),
 * which the rescue ref points at; commits alone get `git branch <rescue>
 * HEAD`. New files nobody added are not saved. The worktree of a session
 * that is starting, running or waiting is left alone. One result per
 * branch pushed or not or left alone, and one per repository with nothing
 * to save.
 */
export async function rescueRepos(
  deps: AppDeps,
  ownerId: string,
  computerId: string,
  now = new Date(),
): Promise<RepoRescueResult[]> {
  const [computer] = await deps.db
    .select()
    .from(schema.computers)
    .where(and(eq(schema.computers.id, computerId), eq(schema.computers.ownerId, ownerId)));
  if (!computer) return [];
  const owner = { id: computer.ownerId, workspaceId: computer.workspaceId };
  const up =
    computer.status === 'running'
      ? computer
      : (await startComputer(deps, owner, SYSTEM_ACTOR)).computer;
  const on: Running = { computer: up, owner, agent: agentFor(deps, up) };
  const rows = await deps.db
    .select({ checkout: schema.repoCheckouts, repo: schema.repos })
    .from(schema.repoCheckouts)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
    .where(
      and(
        eq(schema.repoCheckouts.computerId, computerId),
        eq(schema.repos.ownerId, ownerId),
        notInArray(schema.repoCheckouts.state, ['missing']),
      ),
    )
    .orderBy(schema.repos.fullName);
  const prefix = rescueBranchName(now);
  const live = await deps.db
    .select({ path: schema.codingSessions.worktreePath })
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, ownerId),
        inArray(schema.codingSessions.status, LIVE_SESSION),
        isNotNull(schema.codingSessions.worktreePath),
      ),
    );
  const busy = new Set(live.map((s) => posix.normalize(s.path!)));
  const results: RepoRescueResult[] = [];
  for (const { checkout, repo } of rows) {
    results.push(
      ...(await withCheckoutLock(repo.id, computerId, () =>
        rescueOne(contextFor(deps, on, repo), repo, checkout, prefix, busy),
      )),
    );
  }
  return results;
}

async function rescueOne(
  ctx: GitContext,
  repo: RepoRow,
  checkout: CheckoutRow,
  prefix: string,
  busy: Set<string>,
): Promise<RepoRescueResult[]> {
  const result = (branch: string | null, pushed: boolean, note: string): RepoRescueResult => ({
    repoId: repo.id,
    fullName: repo.fullName,
    branch,
    pushed,
    note,
  });
  const main = checkout.path;
  try {
    if (!(await onDisk(ctx, main))) return [result(null, false, 'Not on the computer')];
  } catch (error) {
    return [result(null, false, `Could not reach the computer: ${errorText(error)}`)];
  }
  try {
    await assertRunnable(ctx, main, repo);
  } catch (error) {
    return [result(null, false, errorText(error))];
  }
  // What the remote has now, so commits already pushed are not saved twice.
  await runGit(ctx, ['-C', main, 'fetch', '--prune', 'origin']);
  const short = repo.fullName.split('/').pop() ?? 'repo';
  const worktrees = [{ path: main, branch: null as string | null, isMain: true }].concat(
    (await worktreesOf(ctx, main)).map((w) => ({ ...w, isMain: false })),
  );
  const out: RepoRescueResult[] = [];
  for (const worktree of worktrees) {
    const at = ['-C', worktree.path];
    if (!worktree.isMain && busy.has(posix.normalize(worktree.path))) {
      const on = worktree.branch ? ` on ${worktree.branch}` : '';
      out.push(result(null, false, `Left alone${on}: a coding session is working there`));
      continue;
    }
    const head = await runGit(ctx, [...at, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = worktree.branch ?? (head.code === 0 ? head.stdout.trim() : null);
    const log = await runGit(ctx, [...at, 'log', 'HEAD', '--not', '--remotes', '--oneline']);
    const commits = log.code === 0 ? log.stdout.split('\n').filter((l) => l.trim()).length : 0;
    const status = await runGit(ctx, [...at, 'status', '--porcelain']);
    const lines = status.code === 0 ? status.stdout : '';
    const dirty =
      (worktree.isMain ? dirtyLines(lines) : lines.split('\n').filter((l) => l.trim())).length > 0;
    if (!commits && !dirty) continue;
    const name = `${prefix}/${branchSlug(short)}/${branchSlug(branch ?? 'detached')}`;
    const what = [
      dirty ? 'uncommitted changes' : null,
      commits ? plural(commits, 'unpushed commit', 'unpushed commits') : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const where = branch ? ` on ${branch}` : '';
    try {
      // A commit of the tracked changes on top of HEAD, made without touching HEAD,
      // the index or the files; empty when the only changes are new files.
      const stash = dirty
        ? (await git(ctx, [...RESCUE_AUTHOR, ...at, 'stash', 'create', 'Rescue uncommitted work']))
            .trim()
            .split('\n')
            .pop()
        : '';
      if (stash && /^[0-9a-f]{40,64}$/.test(stash)) {
        await git(ctx, [...at, 'update-ref', `refs/heads/${name}`, stash]);
      } else if (commits) {
        await git(ctx, [...at, 'branch', name, 'HEAD']);
      } else {
        out.push(
          result(null, false, `Not saved${where}: only new files, which rescue does not save`),
        );
        continue;
      }
      await git(ctx, [...at, 'push', 'origin', `refs/heads/${name}:refs/heads/${name}`], {
        push: true,
        write: true,
      });
      out.push(result(name, true, `Saved ${what}${where} to ${name}`));
    } catch (error) {
      out.push(result(name, false, `Could not save ${what}${where}: ${errorText(error)}`));
    }
  }
  return out.length ? out : [result(null, false, 'Nothing to save: everything is pushed')];
}

// Rescue requests: the route asks, the job answers. The results reach every
// process over the bus, so the API process that took the request can read them.

const RESCUE_CHANNEL = 'openbots:repos:rescue';

interface RescueRecord {
  ownerId: string;
  workspaceId: string;
  status: 'running' | 'done';
  results: RepoRescueResult[];
  error?: string;
  at: number;
}

interface RescueMessage {
  requestId: string;
  ownerId: string;
  workspaceId: string;
  results: RepoRescueResult[];
  error?: string;
}

const rescues = new Map<string, RescueRecord>();
const listening = new WeakMap<EventBus, Promise<unknown>>();

/** Drops finished rescues past `RESCUE_TTL_MS`; a running one stays until its results come. */
function prune(now = Date.now()) {
  for (const [id, record] of rescues) {
    if (record.status === 'done' && now - record.at > RESCUE_TTL_MS) rescues.delete(id);
  }
}

function settleRescue(msg: RescueMessage) {
  rescues.set(msg.requestId, {
    ownerId: msg.ownerId,
    workspaceId: msg.workspaceId,
    status: 'done',
    results: msg.results,
    ...(msg.error ? { error: msg.error } : {}),
    at: Date.now(),
  });
}

function listen(deps: Pick<AppDeps, 'infra'>) {
  const bus = deps.infra.bus;
  let ready = listening.get(bus);
  if (!ready) {
    ready = bus.subscribe<RescueMessage>(RESCUE_CHANNEL, (msg) => {
      const results = RepoRescueResultSchema.array().safeParse(msg?.results);
      if (typeof msg?.requestId !== 'string' || !results.success) return;
      settleRescue({ ...msg, results: results.data });
    });
    listening.set(bus, ready);
  }
  return ready;
}

/** Queues a rescue of the owner's computer; its results are read with `rescueStatus`. */
export async function startRescue(
  deps: Pick<AppDeps, 'infra'>,
  owner: Owner,
  computerId: string | null,
): Promise<string> {
  prune();
  await listen(deps);
  const requestId = randomUUID();
  const record: RescueRecord = {
    ownerId: owner.id,
    workspaceId: owner.workspaceId,
    status: computerId ? 'running' : 'done',
    results: [],
    at: Date.now(),
  };
  rescues.set(requestId, record);
  if (computerId) {
    await enqueueCoderJob(deps, { kind: 'rescue', ownerId: owner.id, computerId, requestId });
  }
  return requestId;
}

/** A rescue's progress, for its owner only; 404 once it is past `RESCUE_TTL_MS`. */
export function rescueStatus(owner: Owner, requestId: string) {
  prune();
  const record = rescues.get(requestId);
  if (!record || record.ownerId !== owner.id || record.workspaceId !== owner.workspaceId) {
    throw notFound('No such rescue');
  }
  return { status: record.status, results: record.results };
}

/** The `rescue` job: runs it and tells every process the results. */
export async function runRescueJob(
  deps: AppDeps,
  job: { ownerId: string; computerId: string; requestId: string },
): Promise<void> {
  let results: RepoRescueResult[] = [];
  let error: string | undefined;
  try {
    results = await rescueRepos(deps, job.ownerId, job.computerId);
  } catch (err) {
    error = errorText(err);
    deps.logger.warn({ err, computerId: job.computerId }, 'repository rescue failed');
  }
  const [computer] = await deps.db
    .select({ workspaceId: schema.computers.workspaceId })
    .from(schema.computers)
    .where(eq(schema.computers.id, job.computerId));
  const msg: RescueMessage = {
    requestId: job.requestId,
    ownerId: job.ownerId,
    workspaceId: computer?.workspaceId ?? rescues.get(job.requestId)?.workspaceId ?? '',
    results,
    ...(error ? { error } : {}),
  };
  settleRescue(msg);
  await deps.infra.bus.publish(RESCUE_CHANNEL, msg);
}
