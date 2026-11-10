import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CodingSessionStatus } from '@openbots/shared';
import { widgetToolResult } from '@openbots/widgets';
import { inArray } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { expireSessionApprovals } from './approvals.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { resumeWaitingRun } from './coder-run-resume.js';
import { settleSession, type CodingSessionRow } from './coder-state.js';

// Sessions an interrupted process left behind (docs/plans/TECHNICAL_PLAN.md 22.8):
// at worker start, and when a job finds a live session no process runs.

export const RESTART_NOTE =
  'The server restarted during the session; continue it to pick up where it left off';

/** The statuses a session runs in; a job finding one it does not run treats it as interrupted. */
export const LIVE: CodingSessionStatus[] = ['starting', 'running', 'waiting'];

/** A session left running by a process that is gone: failed with the note, its run told. */
export async function interruptSession(
  deps: AppDeps,
  row: CodingSessionRow,
  { runWaitMs = 0 }: { runWaitMs?: number } = {},
) {
  await expireSessionApprovals(deps, row.id);
  const state = await settleSession(deps, row.id, { status: 'failed', error: RESTART_NOTE });
  if (row.runId) {
    await resumeWaitingRun(deps, row.runId, widgetToolResult('coding_session', state), {
      waitMs: runWaitMs,
    });
  }
}

/**
 * Sessions an interrupted process left behind, at worker start (in-memory
 * infra, as `recoverInterruptedRuns`): a session that was running fails
 * with RESTART_NOTE and its run resumes with that (its log stays, since the
 * owner can continue it); a queued one, whose job died with the process, is
 * queued again. Logs whose session is gone are removed.
 */
export async function recoverInterruptedCoderSessions(deps: AppDeps): Promise<number> {
  const rows = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(inArray(schema.codingSessions.status, [...LIVE, 'queued']));
  for (const row of rows) {
    if (row.status === 'queued') {
      await enqueueCoderJob(deps, { kind: 'session', sessionId: row.id });
    } else {
      await interruptSession(deps, row);
    }
  }
  await removeOrphanLogs(deps).catch((error: unknown) =>
    deps.logger.warn({ err: error }, 'coding session logs not swept'),
  );
  return rows.length;
}

/** Session logs on the server whose `coding_sessions` row is gone. */
export async function removeOrphanLogs(deps: AppDeps): Promise<number> {
  const dir = path.join(deps.config.filesDir, 'coders');
  const names = await readdir(dir).catch(() => [] as string[]);
  const ids = names
    .map((name) => /^([0-9a-f-]{36})\.log$/i.exec(name)?.[1])
    .filter((id): id is string => !!id);
  if (!ids.length) return 0;
  const known = new Set(
    (
      await deps.db
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(inArray(schema.codingSessions.id, ids))
    ).map((row) => row.id),
  );
  let removed = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    await rm(path.join(dir, `${id}.log`), { force: true });
    removed++;
  }
  return removed;
}
