import { posix } from 'node:path';
import { COMPUTER_HOME, REPOS_DIR } from '@openbots/computer';
import { REPO_SCAN_DEPTH } from '@openbots/shared';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { gitContextOn, runAsRunner, runGit, runningOn, SHORT_MS } from './repos-checkout.js';
import { parseRepoUrl } from './repos.js';

// The scan for clones nobody remembered (docs/TECHNICAL_PLAN.md 22.12; GH6),
// a `scan` job on the `coders` queue. It runs `find` and git as `runner`
// through repos-checkout.ts, never starts the computer and never clones.

/** The most repositories one scan records; the rest are left for the owner to tidy. */
export const SCAN_MAX = 200;

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
 * theirs (`parseRepoUrl`); null when it is not one OpenBots can clone again.
 * A user name or token in the URL (the runner's own `fetch@`, or one typed
 * by hand) is dropped first, so it is never stored.
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
 * `runner`, and reads each one's `origin`. A clone of a remembered
 * repository under ~/repos updates that checkout's row (a `missing` one is
 * there after all); any other becomes a found repository (`found_path`,
 * `keep_cloned` false). Found rows the scan no longer sees are dropped,
 * unless `find` failed and printed nothing: then nothing is known and
 * nothing changes. Never clones anything.
 */
export async function scanComputer(deps: AppDeps, computerId: string): Promise<ScanResult> {
  const on = await runningOn(deps, computerId);
  if (!on) return { found: 0, matched: 0 };
  const ctx = gitContextOn(deps, on);
  const run = await runAsRunner(
    ctx,
    'find',
    [COMPUTER_HOME, '-maxdepth', String(REPO_SCAN_DEPTH + 1), '-name', '.git', '-prune'],
    { timeoutMs: SHORT_MS },
  );
  // find exits 1 for a directory `runner` may not read; what it printed still counts.
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

/**
 * The periodic scan (every `REPO_FETCH_INTERVAL_MS` beside the refresh,
 * workers.ts): one `scan` job per running computer. Returns how many.
 */
export async function queueRepoScans(deps: AppDeps): Promise<number> {
  const rows = await runningComputerIds(deps);
  for (const { id } of rows) await enqueueCoderJob(deps, { kind: 'scan', computerId: id });
  return rows.length;
}

/** The computers that are up. */
export function runningComputerIds(deps: AppDeps) {
  return deps.db
    .select({ id: schema.computers.id })
    .from(schema.computers)
    .where(eq(schema.computers.status, 'running'));
}
