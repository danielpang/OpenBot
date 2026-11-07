import { CODING_SESSION_ENDED, type CodingSessionStatus } from '@openbots/shared';
import { widgetToolResult, type CodingSessionState } from '@openbots/widgets';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { resumeRun, type RunRow } from './runs.js';

// Telling the run that waits on a coding widget how it ended: the runner, the
// sign-in and the owner's actions all resume through here.

/** How long the runner waits for the run to finish pausing before it resumes it. */
export const RUN_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resumes the run waiting on a session's widget with `output`. `code_task`
 * pauses its run after it posts the widget, so a session that ends quickly
 * can beat the pause: the run is given `waitMs` to get there.
 */
export async function resumeWaitingRun(
  deps: Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>,
  runId: string,
  output: unknown,
  { waitMs = RUN_WAIT_MS }: { waitMs?: number } = {},
): Promise<RunRow | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [run] = await deps.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    if (run?.status === 'waiting') {
      return resumeRun(deps, runId, output).catch((error: unknown) => {
        deps.logger.info({ err: error, runId }, 'coding session outcome not resumed');
        return null;
      });
    }
    if (!run || (run.status !== 'running' && run.status !== 'queued') || Date.now() >= deadline) {
      deps.logger.info({ runId, status: run?.status }, 'no run waits on the coding session');
      return null;
    }
    await sleep(250);
  }
}

/**
 * For the services: a run that paused on a session which had already
 * ended (the race `resumeWaitingRun` waits out, past its wait) resumes now.
 */
export async function resumeIfSessionEnded(deps: AppDeps, sessionId: string): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId));
  if (!row?.runId || !CODING_SESSION_ENDED.includes(row.status as CodingSessionStatus)) return;
  if (!row.messageId || row.partIndex === null) return;
  const [stored] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, row.messageId),
        eq(schema.widgetStates.partIndex, row.partIndex),
      ),
    );
  if (!stored) return;
  await resumeWaitingRun(
    deps,
    row.runId,
    widgetToolResult('coding_session', stored.state as CodingSessionState),
    { waitMs: 0 },
  );
}
