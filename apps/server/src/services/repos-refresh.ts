import {
  CODING_SESSION_ENDED,
  REPO_FETCH_INTERVAL_MS,
  REPOS_CLONE_FAILED,
  type CodingSessionStatus,
} from '@openbots/shared';
import { and, eq, inArray, lt, max, notInArray, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { mainBotOf } from './bots.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { postMessage } from './messages.js';
import {
  assertRunnable,
  dirtyLines,
  ensureCheckout,
  git,
  gitContextOn,
  onDisk,
  remoteDefaultBranch,
  runAsRunner,
  runGit,
  runningOn,
  SHORT_MS,
  withCheckoutLock,
  worktreesOf,
  type CheckoutRow,
  type GitContext,
  type RepoRow,
} from './repos-checkout.js';
import { runningComputerIds } from './repos-scan.js';

// Keeping the remembered repositories current (docs/TECHNICAL_PLAN.md 22.12;
// GH3, GH4): the periodic fetch that records each checkout's state, and the
// reconcile after every computer start that clones again what a new home
// volume lost. Both run git as `runner` through repos-checkout.ts, check a
// checkout's config before git runs in it (`assertRunnable`), and never
// start the computer.

type Owner = { id: string; workspaceId: string };

/** A refresh is not queued again sooner than this after the last one. */
export const REFRESH_MIN_GAP_MS = 10 * 60_000;
/** Checkout states a fetch can make current: not one a job is changing, nor one not on disk. */
const SETTLED = ['ready', 'behind', 'dirty', 'error'];
/** A checkout `cloning` or `updating` this long was left by a job that died: reconcile retries it. */
export const STUCK_MS = 30 * 60_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Computers with a refresh queued from this process, and when it was. */
const refreshQueued = new Map<string, number>();
/** When this process last ran a refresh per computer. */
const refreshRan = new Map<string, number>();

/** For tests: forgets which refreshes this process queued and ran. */
export function resetRefreshQueue(): void {
  refreshQueued.clear();
  refreshRan.clear();
}

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
  const on = await runningOn(deps, computerId);
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
      refreshOne(deps, gitContextOn(deps, on, repo), repo, checkout),
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
    await pruneWorktrees(deps, ctx, repo, path, branch);
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
      diskBytes: await diskUse(ctx, path),
      error: null,
    });
    return true;
  } catch (error) {
    await set({ state: 'error', error: errorText(error).slice(0, 2_000) });
    return false;
  }
}

/** The checkout's size on disk, its worktrees included (`du -sk`); null when du cannot say. */
async function diskUse(ctx: GitContext, path: string): Promise<number | null> {
  const run = await runAsRunner(ctx, 'du', ['-sk', '--', path], { timeoutMs: SHORT_MS });
  const kb = Number(/^(\d+)\s/.exec(run.stdout)?.[1]);
  return run.code === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * Removes the worktrees of ended sessions whose work is upstream or was let
 * go there: the branch is merged into origin's default branch, or the session
 * pushed it and origin no longer has it. Only a clean worktree goes (`git
 * worktree remove` without force refuses any other), then `git worktree
 * prune`, and the session forgets the path. A worktree no session names, or
 * one a live session works in, is left alone.
 */
async function pruneWorktrees(
  deps: AppDeps,
  ctx: GitContext,
  repo: RepoRow,
  path: string,
  defaultBranch: string,
): Promise<void> {
  let removed = 0;
  for (const worktree of await worktreesOf(ctx, path)) {
    if (!worktree.branch) continue;
    const sessions = await deps.db
      .select({
        id: schema.codingSessions.id,
        status: schema.codingSessions.status,
        pushAllowed: schema.codingSessions.pushAllowed,
      })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.ownerId, repo.ownerId),
          eq(schema.codingSessions.worktreePath, worktree.path),
        ),
      );
    if (!sessions.length) continue;
    if (sessions.some((s) => !CODING_SESSION_ENDED.includes(s.status as CodingSessionStatus))) {
      continue;
    }
    const status = await runGit(ctx, ['-C', worktree.path, 'status', '--porcelain']);
    if (status.code !== 0 || status.stdout.trim()) continue;
    const ref = `refs/heads/${worktree.branch}`;
    const merged =
      (
        await runGit(ctx, [
          '-C',
          path,
          'merge-base',
          '--is-ancestor',
          ref,
          `refs/remotes/origin/${defaultBranch}`,
        ])
      ).code === 0;
    const gone =
      sessions.some((s) => s.pushAllowed) &&
      (
        await runGit(ctx, [
          '-C',
          path,
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${worktree.branch}`,
        ])
      ).code !== 0;
    if (!merged && !gone) continue;
    const done = await runGit(ctx, ['-C', path, 'worktree', 'remove', worktree.path]);
    if (done.code !== 0) continue;
    removed++;
    await deps.db
      .update(schema.codingSessions)
      .set({ worktreePath: null, updatedAt: new Date() })
      .where(
        inArray(
          schema.codingSessions.id,
          sessions.map((s) => s.id),
        ),
      );
    deps.logger.info(
      { repoId: repo.id, branch: worktree.branch, why: merged ? 'merged' : 'gone upstream' },
      'removed a finished session worktree',
    );
  }
  if (removed) await runGit(ctx, ['-C', path, 'worktree', 'prune']);
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
 * At worker start: one `reconcile` job per running computer, so a computer
 * that started while no worker ran (or whose job was lost) still gets its
 * repositories back. Returns how many.
 */
export async function queueRepoReconciles(deps: AppDeps): Promise<number> {
  const rows = await runningComputerIds(deps);
  for (const { id } of rows) await enqueueCoderJob(deps, { kind: 'reconcile', computerId: id });
  return rows.length;
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
  const on = await runningOn(deps, computerId);
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
      if (await onDisk(gitContextOn(deps, on, repo), checkout.path)) return;
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
      // The Mac and the phone notify on it (REPOS_CLONE_FAILED, notices.ts).
      kind: REPOS_CLONE_FAILED,
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
  // The Bot it is under, so a notice about it opens there.
  const data = { ...part.data, botId: bot.id };
  await postMessage(deps, chat.id, { authorType: 'system', parts: [{ ...part, data }] });
}
