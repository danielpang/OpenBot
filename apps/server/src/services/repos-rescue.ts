import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  RepoRescueResultSchema,
  rescueBranchName,
  type EventBus,
  type RepoRescueResult,
} from '@openbots/shared';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { notFound } from '../errors.js';
import { SYSTEM_ACTOR } from './audit.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { agentFor, startComputer } from './computer.js';
import {
  assertRunnable,
  branchSlug,
  dirtyLines,
  git,
  gitContextOn,
  onDisk,
  runGit,
  withCheckoutLock,
  worktreesOf,
  type CheckoutRow,
  type GitContext,
  type RepoRow,
  type RunningComputer,
} from './repos-checkout.js';

// Rescue before loss (docs/TECHNICAL_PLAN.md 22.12; GH5): the `rescue` job
// saves what would be lost with the computer's home to rescue branches and
// pushes them as `runner`; the route asks, the job answers, and the results
// reach every process over the bus. Unlike the other repository jobs it
// starts the computer, since it needs it up to save anything.

type Owner = { id: string; workspaceId: string };

/** How long a rescue's results stay readable. */
export const RESCUE_TTL_MS = 10 * 60_000;
/** Session statuses whose worktree rescue leaves alone: the agent is working there. */
const LIVE_SESSION = ['starting', 'running', 'waiting'];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
  const on: RunningComputer = { computer: up, owner, agent: agentFor(deps, up) };
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
        rescueOne(gitContextOn(deps, on, repo), repo, checkout, prefix, busy),
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
    if (!(await onDisk(ctx, main))) return [result(null, false, NOT_ON_COMPUTER)];
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
  return out.length ? out : [result(null, false, NOTHING_TO_SAVE)];
}

const NOT_ON_COMPUTER = 'Not on the computer';
const NOTHING_TO_SAVE = 'Nothing to save: everything is pushed';

/**
 * The results whose work a lost home would take with it: everything not
 * pushed, except a checkout that was not there and one with nothing to save.
 */
export function unsavedWork(results: RepoRescueResult[]): RepoRescueResult[] {
  return results.filter(
    (r) => !r.pushed && !(r.branch === null && [NOT_ON_COMPUTER, NOTHING_TO_SAVE].includes(r.note)),
  );
}

// Rescue requests: the route asks, the job answers. The results reach every
// process over the bus, so the API process that took the request can read them.

/** Where a finished rescue's `RescueMessage` goes; the computer reset reads it too. */
export const RESCUE_CHANNEL = 'openbots:repos:rescue';

interface RescueRecord {
  ownerId: string;
  workspaceId: string;
  status: 'running' | 'done';
  results: RepoRescueResult[];
  error?: string;
  at: number;
}

export interface RescueMessage {
  requestId: string;
  ownerId: string;
  workspaceId: string;
  results: RepoRescueResult[];
  error?: string;
}

const rescues = new Map<string, RescueRecord>();
const listening = new WeakMap<EventBus, Promise<unknown>>();

/** For tests: forgets every rescue this process knows of. */
export function resetRescues(): void {
  rescues.clear();
}

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
