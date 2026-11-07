import { CODERS_QUEUE } from '@openbots/shared';
import type { AppDeps } from '../context.js';

// The `coders` queue carries the coding sessions, checkouts and sign-ins
// (docs/TECHNICAL_PLAN.md 22.2; I12), and the remembered repositories' jobs (I18,
// repos-scan.ts, repos-refresh.ts, repos-rescue.ts): a scan for clones nobody remembered, the reconcile after a
// computer start, rescue before loss, and the periodic fetch of each
// checkout's state. One handler (services/coder-runner.ts) takes them all;
// the routes, the timers and the `code_task` tool only enqueue.

export type CoderJob =
  | { kind: 'session'; sessionId: string }
  | { kind: 'checkout'; repoId: string; computerId: string; action: 'clone' | 'update' }
  | { kind: 'login'; loginId: string }
  | { kind: 'scan'; computerId: string }
  | { kind: 'reconcile'; computerId: string }
  | { kind: 'rescue'; ownerId: string; computerId: string; requestId: string }
  | { kind: 'refresh'; computerId: string };

export async function enqueueCoderJob(
  deps: Pick<AppDeps, 'infra'>,
  job: CoderJob,
  options: { delayMs?: number; priority?: number } = {},
): Promise<string> {
  return deps.infra.queue<CoderJob>(CODERS_QUEUE).enqueue(job.kind, job, options);
}
