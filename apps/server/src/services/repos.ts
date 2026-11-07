import type { RepoRef } from '@openbots/agent';
import { posix } from 'node:path';
import { REPOS_DIR } from '@openbots/computer';
import {
  DEFAULT_MAX_REPOS,
  normalizeFullName,
  REPO_FULL_NAME,
  type FoundRepo,
} from '@openbots/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { recordAudit, userActor } from './audit.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { agentFor, getComputer, runningComputer } from './computer.js';
import { connectionAllows } from './git-connections.js';
import { checkoutPathFor, runAsRunner } from './repos-checkout.js';
import { startRescue } from './repos-rescue.js';

// The remembered repositories (GH2 to GH6; I18): added by URL, picked from a
// git connection, or remembered from a clone found on the computer. A
// repository is the owner's, not a Bot's; a Bot's `coder.allowedRepos`
// narrows which of them it may use. Its state on the owner's computer is a
// `repo_checkouts` row, written by the runner's `checkout` jobs and the
// repository jobs (repos-scan.ts, repos-refresh.ts, repos-rescue.ts): adding a repository, Clone and Update
// only enqueue one and set the state they expect (`cloning`, `updating`) so
// the page shows it at once. A found repository (GH6) is a `repos` row with
// `found_path` set and no connection: listed, never cloned, never offered to
// a Bot, and not counted against DEFAULT_MAX_REPOS until it is remembered.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ReposDeps = Pick<AppDeps, 'db' | 'infra'>;

export type RepoRow = typeof schema.repos.$inferSelect;
export type RepoCheckoutRow = typeof schema.repoCheckouts.$inferSelect;

export interface RepoWithCheckout {
  repo: RepoRow;
  /** On the owner's computer; null when it has none there yet (or no computer). */
  checkout: RepoCheckoutRow | null;
}

export const invalidRepoUrl = (message: string) =>
  new DomainError(400, 'INVALID_REPO_URL', message);

export interface ParsedRepoUrl {
  /** `owner/name`: the last two segments of the path. */
  fullName: string;
  /** What is stored and cloned: https for GitHub, so the credential helper serves it. */
  remoteUrl: string;
  host: string;
}

/**
 * Reads a git remote: `https://host/owner/name(.git)`, `ssh://git@host/owner/name.git`
 * or `git@host:owner/name.git`. GitHub remotes, https or ssh, become
 * `https://github.com/owner/name.git`: the computer has no SSH keys, and the
 * credential helper (I5) answers for https. Anything else that is not a git
 * remote is refused, and so is a URL with a user name or token in it, which
 * would be stored as is.
 */
export function parseRepoUrl(raw: string): ParsedRepoUrl {
  const value = raw.trim();
  let host: string;
  let path: string;
  let scheme: 'https' | 'ssh';
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(value);
  if (scp) {
    scheme = 'ssh';
    host = scp[2]!.toLowerCase();
    path = scp[3]!;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalidRepoUrl('Give the repository as a git URL, like https://github.com/owner/name');
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      if (url.username || url.password) {
        throw invalidRepoUrl(
          'Leave the user name and token out of the URL; the GitHub connection signs git in',
        );
      }
      scheme = 'https';
    } else if (url.protocol === 'ssh:') {
      scheme = 'ssh';
    } else {
      throw invalidRepoUrl('Only https and ssh git URLs can be added');
    }
    if (url.search || url.hash) throw invalidRepoUrl('A git URL has no query or fragment');
    host = url.hostname.toLowerCase();
    path = decodeURIComponent(url.pathname);
  }
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (!host.includes('.') || segments.length < 2) {
    throw invalidRepoUrl('A repository URL names its owner and name, like github.com/owner/name');
  }
  // GitHub has no deeper paths: `/owner/name/tree/main` is a page, not a remote.
  if (host === 'github.com' && segments.length !== 2) {
    throw invalidRepoUrl('That is a page on GitHub, not a repository: use github.com/owner/name');
  }
  const fullName = segments.slice(-2).join('/');
  if (!REPO_FULL_NAME.test(fullName)) {
    throw invalidRepoUrl('A repository name has letters, digits, dots, dashes and underscores');
  }
  const remoteUrl =
    host === 'github.com'
      ? `https://github.com/${fullName}.git`
      : scheme === 'https'
        ? `https://${host}/${segments.join('/')}.git`
        : value;
  return { fullName, remoteUrl, host };
}

function ownedBy(owner: Owner) {
  return and(eq(schema.repos.ownerId, owner.id), eq(schema.repos.workspaceId, owner.workspaceId));
}

/** A clone found on the computer that nobody remembered yet (GH6). */
export function isFound(repo: Pick<RepoRow, 'foundPath' | 'connectionId'>): boolean {
  return repo.foundPath !== null && repo.connectionId === null;
}

/** Remembered, not merely found: what counts against DEFAULT_MAX_REPOS. */
const remembered = isNull(schema.repos.foundPath);

const repoLimit = () =>
  new DomainError(
    409,
    'REPO_LIMIT',
    `You can keep ${DEFAULT_MAX_REPOS} repositories. Forget one to add another.`,
  );

async function computerIdOf(db: Db, owner: Owner): Promise<string | null> {
  return (await getComputer({ db }, owner))?.id ?? null;
}

/**
 * The owner's remembered repositories with their checkout on the owner's
 * computer, in one query: pinned first, then by last use, then by name.
 * `includeFound` adds the clones found on the computer (the Computer page).
 */
export async function listRepos(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  { includeFound = false }: { includeFound?: boolean } = {},
) {
  const computerId = deps.db
    .select({ id: schema.computers.id })
    .from(schema.computers)
    .where(
      and(
        eq(schema.computers.ownerId, owner.id),
        eq(schema.computers.workspaceId, owner.workspaceId),
      ),
    );
  const rows = await deps.db
    .select({ repo: schema.repos, checkout: schema.repoCheckouts })
    .from(schema.repos)
    .leftJoin(
      schema.repoCheckouts,
      and(
        eq(schema.repoCheckouts.repoId, schema.repos.id),
        sql`${schema.repoCheckouts.computerId} in ${computerId}`,
      ),
    )
    .where(and(ownedBy(owner), includeFound ? undefined : remembered))
    .orderBy(
      desc(schema.repos.pinned),
      sql`${schema.repos.lastUsedAt} desc nulls last`,
      asc(schema.repos.fullName),
    );
  return rows satisfies RepoWithCheckout[];
}

/** One of the owner's repositories with its checkout; 404 for anyone else's. */
export async function getRepo(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  repoId: string,
): Promise<RepoWithCheckout> {
  const found = (await listRepos(deps, owner, { includeFound: true })).find(
    (r) => r.repo.id === repoId,
  );
  if (!found) throw notFound('Repository not found');
  return found;
}

export interface AddRepoInput {
  remoteUrl: string;
  fullName?: string;
  defaultBranch?: string;
  keepCloned?: boolean;
}

/**
 * Remembers a repository by its URL (GH3), within
 * DEFAULT_MAX_REPOS, and clones it onto the owner's computer when there is
 * one: the `checkout` job starts the computer if it has to. A `fullName`
 * given has to be the URL's own.
 */
export async function addRepoByUrl(
  deps: ReposDeps,
  owner: Owner,
  input: AddRepoInput,
): Promise<RepoWithCheckout> {
  const parsed = parseRepoUrl(input.remoteUrl);
  // The name is the URL's: a different one would put the clone at another path.
  const given = input.fullName?.trim();
  if (given && given.toLowerCase() !== parsed.fullName.toLowerCase()) {
    throw new DomainError(
      400,
      'VALIDATION_FAILED',
      `The URL names ${parsed.fullName}; leave the name out or give that one`,
    );
  }
  const fullName = given || parsed.fullName;
  const repo = await deps.db.transaction(async (tx) => {
    // Two adds at once count each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`repos:${owner.id}`}))`);
    const [taken] = await tx
      .select({ id: schema.repos.id, foundPath: schema.repos.foundPath })
      .from(schema.repos)
      .where(and(ownedBy(owner), eq(schema.repos.remoteUrl, parsed.remoteUrl)));
    if (taken && taken.foundPath === null) {
      throw new DomainError(409, 'REPO_EXISTS', `${fullName} is already in your repositories`);
    }
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(schema.repos)
      .where(and(ownedBy(owner), remembered));
    if (n >= DEFAULT_MAX_REPOS) throw repoLimit();
    // A clone found on the computer with this remote: remembered in its place.
    if (taken) await tx.delete(schema.repos).where(eq(schema.repos.id, taken.id));
    const [inserted] = await tx
      .insert(schema.repos)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        fullName,
        remoteUrl: parsed.remoteUrl,
        defaultBranch: input.defaultBranch?.trim() || 'main',
        keepCloned: input.keepCloned ?? true,
      })
      .returning();
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'repo.add',
      targetType: 'repo',
      targetId: inserted!.id,
      metadata: { fullName, host: parsed.host },
    });
    return inserted!;
  });
  const computerId = await computerIdOf(deps.db, owner);
  if (computerId) {
    const checkout = await queueCheckout(deps, repo, computerId, 'clone');
    return { repo, checkout };
  }
  return { repo, checkout: null };
}

export interface Forgotten {
  /** The clone was removed from the computer (`deleteFiles`). */
  filesDeleted: boolean;
  /** Where the clone is (or was) on the computer; null when it had none there. */
  path: string | null;
  /** In plain words, for the page. */
  note: string;
}

/** A checkout path `rm -rf` may take: a repository directory under ~/repos, nothing above it. */
export function deletablePath(path: string): boolean {
  if (posix.normalize(path) !== path || path.includes('\0') || path.endsWith('/')) return false;
  const rel = posix.relative(REPOS_DIR, path);
  return !!rel && !rel.startsWith('..') && !posix.isAbsolute(rel) && rel.split('/').length >= 2;
}

/**
 * Forgets a repository. Its clone stays on the computer's disk, the owner's
 * files, unless `deleteFiles`: then the checkout is removed first, as
 * `runner`, and only from under ~/repos (409 `COMPUTER_OFF` when the
 * computer is not running, and nothing is forgotten).
 */
export async function forgetRepo(
  deps: AppDeps,
  owner: Owner,
  repoId: string,
  { deleteFiles = false }: { deleteFiles?: boolean } = {},
): Promise<Forgotten> {
  const { repo, checkout } = await getRepo(deps, owner, repoId);
  const path = checkout?.path ?? repo.foundPath ?? null;
  let filesDeleted = false;
  if (deleteFiles && path) {
    if (!deletablePath(path)) {
      throw new DomainError(
        409,
        'NOT_DELETABLE',
        `${path} is outside ~/repos, so OpenBots leaves it there. Remove it in the terminal.`,
      );
    }
    const computer = await runningComputer(deps, owner);
    const run = await runAsRunner(
      { deps, agent: agentFor(deps, computer), owner, repoFullName: null },
      'rm',
      ['-rf', '--', path],
      { timeoutMs: 5 * 60_000 },
    );
    if (run.code !== 0) {
      throw new DomainError(
        409,
        'DELETE_FAILED',
        `The clone could not be removed: ${(run.error ?? run.stderr).trim() || `exit ${run.code}`}`,
      );
    }
    filesDeleted = true;
  }
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(schema.repos)
      .where(and(ownedBy(owner), eq(schema.repos.id, repoId)))
      .returning({ id: schema.repos.id, fullName: schema.repos.fullName });
    if (!row) throw notFound('Repository not found');
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'repo.forget',
      targetType: 'repo',
      targetId: row.id,
      metadata: { fullName: row.fullName, filesDeleted },
    });
  });
  return {
    filesDeleted,
    path,
    note: filesDeleted
      ? `Forgot ${repo.fullName} and removed its clone from the computer`
      : path
        ? `Forgot ${repo.fullName}. Its clone stays on the computer at ${path}`
        : `Forgot ${repo.fullName}`,
  };
}

/** Clones a repository onto the owner's computer again (a missing or failed checkout). */
export function cloneRepo(deps: ReposDeps, owner: Owner, repoId: string) {
  return checkoutAction(deps, owner, repoId, 'clone');
}

/** Fetches a repository and fast-forwards its default branch on the owner's computer. */
export function updateRepo(deps: ReposDeps, owner: Owner, repoId: string) {
  return checkoutAction(deps, owner, repoId, 'update');
}

async function checkoutAction(
  deps: ReposDeps,
  owner: Owner,
  repoId: string,
  action: 'clone' | 'update',
): Promise<RepoWithCheckout> {
  const { repo } = await getRepo(deps, owner, repoId);
  const computerId = await computerIdOf(deps.db, owner);
  if (!computerId) {
    throw new DomainError(
      409,
      'NO_COMPUTER',
      'The computer has not been created yet. It is created the first time a Bot uses it, and the repository is cloned then.',
    );
  }
  const checkout = await queueCheckout(deps, repo, computerId, action);
  return { repo, checkout };
}

/**
 * Sets the checkout's state to the one the job is about to bring
 * (`cloning`, `updating`) and enqueues the job. A new checkout row starts
 * at the repository's path under ~/repos.
 */
async function queueCheckout(
  deps: ReposDeps,
  repo: RepoRow,
  computerId: string,
  action: 'clone' | 'update',
): Promise<RepoCheckoutRow> {
  const state = action === 'clone' ? 'cloning' : 'updating';
  const [checkout] = await deps.db
    .insert(schema.repoCheckouts)
    .values({
      workspaceId: repo.workspaceId,
      repoId: repo.id,
      computerId,
      path: checkoutPathFor(repo),
      state,
    })
    .onConflictDoUpdate({
      target: [schema.repoCheckouts.repoId, schema.repoCheckouts.computerId],
      set: { state, error: null, updatedAt: new Date() },
    })
    .returning();
  await enqueueCoderJob(deps, { kind: 'checkout', repoId: repo.id, computerId, action });
  return checkout!;
}

/** The owner's repositories as the Bot's context and `code_task` list them (GH9): one query. */
export async function reposForContext(deps: Pick<AppDeps, 'db'>, owner: Owner): Promise<RepoRef[]> {
  return (await listRepos(deps, owner)).map(toRepoRef);
}

export function toRepoRef({ repo, checkout }: RepoWithCheckout): RepoRef {
  return {
    id: repo.id,
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    ...(checkout ? { path: checkout.path, state: checkout.state } : {}),
    ...(repo.description ? { description: repo.description } : {}),
  };
}

/** Narrows the owner's repositories to a Bot's `coder.allowedRepos` (absent allows all). */
export function allowedRepos<T extends { full_name: string }>(
  repos: T[],
  allowed: string[] | undefined,
): T[] {
  if (!allowed) return repos;
  const names = new Set(allowed.map((name) => name.toLowerCase()));
  return repos.filter((r) => names.has(r.full_name.toLowerCase()));
}

// The picker, found clones, the per-repository toggles, rescue and scan
// (docs/TECHNICAL_PLAN.md 22.12).

export interface RememberInput {
  /** `owner/name` on GitHub, as the picker lists them. */
  fullNames: string[];
  /** The owner's git connection they came through. */
  connectionId: string;
}

/**
 * Remembers repositories picked from a git connection (GH2), within
 * DEFAULT_MAX_REPOS: each is stored as `https://github.com/<name>.git` with
 * `main` as its default branch until the first fetch reads the remote's,
 * and cloned onto the owner's computer when there is one. One already
 * remembered is left as it is; a clone found on the computer with the same
 * remote becomes the remembered one. Each name has to be one the
 * connection lists (`connectionAllows`, else 403 `CONNECTION_NO_ACCESS`)
 * and owned by the connection's account. Returns every named repository.
 */
export async function rememberRepos(
  deps: AppDeps,
  owner: Owner,
  input: RememberInput,
): Promise<RepoWithCheckout[]> {
  const names = [...new Set(input.fullNames.map((n) => n.trim()).filter(Boolean))];
  const bad = names.find((n) => normalizeFullName(n) === null);
  if (bad) throw new DomainError(400, 'VALIDATION_FAILED', `${bad} does not look like owner/name`);
  const [connection] = await deps.db
    .select({ id: schema.gitConnections.id, accountLogin: schema.gitConnections.accountLogin })
    .from(schema.gitConnections)
    .where(
      and(
        eq(schema.gitConnections.id, input.connectionId),
        eq(schema.gitConnections.ownerId, owner.id),
        eq(schema.gitConnections.workspaceId, owner.workspaceId),
      ),
    );
  if (!connection) throw notFound('Connection not found');
  const noAccess = (name: string) =>
    new DomainError(403, 'CONNECTION_NO_ACCESS', `The connection does not reach ${name}`);
  for (const name of names) {
    if (name.split('/')[0]!.toLowerCase() !== connection.accountLogin.toLowerCase()) {
      throw noAccess(name);
    }
    if (!(await connectionAllows(deps, connection.id, name, owner.id))?.read) throw noAccess(name);
  }
  const urlOf = (name: string) => `https://github.com/${name}.git`;
  const added = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`repos:${owner.id}`}))`);
    const existing = await tx
      .select({ remoteUrl: schema.repos.remoteUrl, foundPath: schema.repos.foundPath })
      .from(schema.repos)
      .where(and(ownedBy(owner), inArray(schema.repos.remoteUrl, names.map(urlOf))));
    const kept = new Set(existing.filter((r) => r.foundPath === null).map((r) => r.remoteUrl));
    const fresh = names.filter((n) => !kept.has(urlOf(n)));
    if (!fresh.length) return [];
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(schema.repos)
      .where(and(ownedBy(owner), remembered));
    if (n + fresh.length > DEFAULT_MAX_REPOS) throw repoLimit();
    const rows = await tx
      .insert(schema.repos)
      .values(
        fresh.map((fullName) => ({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          connectionId: connection.id,
          fullName,
          remoteUrl: urlOf(fullName),
        })),
      )
      .onConflictDoUpdate({
        target: [schema.repos.workspaceId, schema.repos.ownerId, schema.repos.remoteUrl],
        set: {
          connectionId: connection.id,
          foundPath: null,
          keepCloned: true,
          updatedAt: new Date(),
        },
        // Only a found clone's row is taken over; a remembered one is left alone.
        setWhere: isNotNull(schema.repos.foundPath),
      })
      .returning();
    for (const row of rows) {
      await recordAudit(tx, {
        workspaceId: owner.workspaceId,
        actor: userActor(owner),
        action: 'repo.add',
        targetType: 'repo',
        targetId: row.id,
        metadata: { fullName: row.fullName, host: 'github.com', connectionId: connection.id },
      });
    }
    return rows;
  });
  const computerId = await computerIdOf(deps.db, owner);
  if (computerId) {
    for (const repo of added) await queueCheckout(deps, repo, computerId, 'clone');
  }
  const wanted = new Set(names.map(urlOf));
  return (await listRepos(deps, owner)).filter((r) => wanted.has(r.repo.remoteUrl));
}

/** The clones on the computer nobody remembered (GH6), from the last scan. */
export async function listFound(deps: Pick<AppDeps, 'db'>, owner: Owner): Promise<FoundRepo[]> {
  const rows = await deps.db
    .select()
    .from(schema.repos)
    .where(and(ownedBy(owner), isNotNull(schema.repos.foundPath)))
    .orderBy(asc(schema.repos.foundPath));
  return rows.filter(isFound).map((repo) => ({
    path: repo.foundPath!,
    remoteUrl: repo.remoteUrl,
    fullName: repo.remoteUrl.startsWith('https://github.com/') ? repo.fullName : null,
  }));
}

/**
 * Remembers a clone found on the computer (GH6) where it is: `keep_cloned`
 * on, `found_path` cleared, and its checkout row `ready` at that path. Its
 * default branch is read at the next refresh.
 */
export async function rememberFound(
  deps: ReposDeps,
  owner: Owner,
  path: string,
): Promise<RepoWithCheckout> {
  const repoId = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`repos:${owner.id}`}))`);
    const [found] = await tx
      .select()
      .from(schema.repos)
      .where(and(ownedBy(owner), eq(schema.repos.foundPath, path)));
    if (!found || !isFound(found)) throw notFound('No clone was found at that path');
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(schema.repos)
      .where(and(ownedBy(owner), remembered));
    if (n >= DEFAULT_MAX_REPOS) throw repoLimit();
    await tx
      .update(schema.repos)
      .set({ keepCloned: true, foundPath: null, updatedAt: new Date() })
      .where(eq(schema.repos.id, found.id));
    const computerId = await computerIdOf(tx, owner);
    if (computerId) {
      await tx
        .insert(schema.repoCheckouts)
        .values({
          workspaceId: owner.workspaceId,
          repoId: found.id,
          computerId,
          path,
          state: 'ready',
        })
        .onConflictDoUpdate({
          target: [schema.repoCheckouts.repoId, schema.repoCheckouts.computerId],
          set: { path, state: 'ready', error: null, updatedAt: new Date() },
        });
    }
    await recordAudit(tx, {
      workspaceId: owner.workspaceId,
      actor: userActor(owner),
      action: 'repo.add',
      targetType: 'repo',
      targetId: found.id,
      metadata: { fullName: found.fullName, foundPath: path },
    });
    return found.id;
  });
  return getRepo(deps, owner, repoId);
}

export interface RepoPatch {
  keepCloned?: boolean;
  pinned?: boolean;
}

/** Turns cloning again on a new home volume (GH4) on or off, and pins a repository. */
export async function patchRepo(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  repoId: string,
  patch: RepoPatch,
): Promise<RepoWithCheckout> {
  const set: Partial<RepoRow> = {};
  if (patch.keepCloned !== undefined) set.keepCloned = patch.keepCloned;
  if (patch.pinned !== undefined) set.pinned = patch.pinned;
  if (Object.keys(set).length) {
    const [row] = await deps.db
      .update(schema.repos)
      .set({ ...set, updatedAt: new Date() })
      .where(and(ownedBy(owner), eq(schema.repos.id, repoId)))
      .returning({ id: schema.repos.id });
    if (!row) throw notFound('Repository not found');
  }
  return getRepo(deps, owner, repoId);
}

/**
 * Starts rescue before loss (GH5) on the owner's computer; the results are
 * read with the request id. With no computer there is nothing to save, and
 * the request is done at once.
 */
export async function requestRescue(deps: ReposDeps, owner: Owner): Promise<{ requestId: string }> {
  return { requestId: await startRescue(deps, owner, await computerIdOf(deps.db, owner)) };
}

/** Queues a scan of the owner's computer for clones nobody remembered (GH6). */
export async function requestScan(deps: ReposDeps, owner: Owner): Promise<void> {
  const computerId = await computerIdOf(deps.db, owner);
  if (!computerId) {
    throw new DomainError(409, 'NO_COMPUTER', 'Start the computer first; there is nothing to scan');
  }
  await enqueueCoderJob(deps, { kind: 'scan', computerId });
}
