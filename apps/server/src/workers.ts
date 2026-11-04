import type { JobHandler } from '@openbots/shared';
import type { AppDeps } from './context.js';
import { forEachWorkspace } from './db/scope.js';
import {
  EVENT_DELIVERIES_QUEUE,
  eventDeliveryHandler,
  requeuePendingEventDeliveries,
  startEventFanOut,
} from './hooks/outbound.js';
import { APPROVALS_QUEUE, expireDueApprovals, expiryHandler } from './services/approvals.js';
import { AUDIT_TRIM_MS, trimAuditLog } from './services/audit.js';
import { BOT_STATE_QUEUE, settleHandler } from './services/bot-state.js';
import { PAIRING_SWEEP_MS, expireDuePairings } from './services/devices.js';
import { IDLE_SWEEP_MS, refreshSandboxImage, sweepIdleComputers } from './services/computer.js';
import { expireDueLoginRequests, LOGINS_QUEUE, loginExpiryHandler } from './services/logins.js';
import { MEMORIES_QUEUE, reembedHandler } from './services/memories.js';
import { startRoutineScheduler } from './services/routines.js';
import { RUNS_QUEUE } from './services/runs.js';
import { startPushWorker } from './workers/push.js';
import { createRunWorker, recoverInterruptedRuns } from './workers/runs.js';

/**
 * Job handlers by queue name. Later leaves add theirs (runs in 1.B, approval
 * expiry in 2.2, webhook deliveries in 6.3); each queue is processed by the
 * `worker` and `all` roles.
 */
export const JOB_HANDLERS: Record<
  string,
  { handler: (deps: AppDeps) => JobHandler; concurrency?: number }
> = {
  [BOT_STATE_QUEUE]: { handler: settleHandler as (deps: AppDeps) => JobHandler, concurrency: 4 },
  // One job per Bot at a time (groupKey = Bot id); this is runs across Bots.
  [RUNS_QUEUE]: { handler: (deps) => createRunWorker(deps) as JobHandler, concurrency: 8 },
  // One delayed job per approval request, due when it expires (plan 5.6).
  [APPROVALS_QUEUE]: { handler: expiryHandler as (deps: AppDeps) => JobHandler, concurrency: 2 },
  // One delayed job per sign-in request, due when it expires like an approval (plan 9.7).
  [LOGINS_QUEUE]: { handler: loginExpiryHandler as (deps: AppDeps) => JobHandler, concurrency: 2 },
  // Outbound event subscriptions, retried with backoff (plan 11, H6).
  [EVENT_DELIVERIES_QUEUE]: {
    handler: (deps) => eventDeliveryHandler(deps) as JobHandler,
    concurrency: 4,
  },
  // A Bot's memories re-embedded after its embedding source changed (M1).
  [MEMORIES_QUEUE]: { handler: (deps) => reembedHandler(deps) as JobHandler, concurrency: 2 },
};

/**
 * Work for every organization (db/scope.ts): `fn` runs in each one's scope
 * in turn, and the counts add up.
 */
export async function inEveryOrganization(
  deps: Pick<AppDeps, 'db'>,
  fn: () => Promise<number>,
): Promise<number> {
  const counts = await forEachWorkspace(deps.db, fn);
  return counts.reduce((sum, n) => sum + n, 0);
}

/** Background work for the `worker` and `all` roles (queues, scheduler). */
export async function startWorkers(deps: AppDeps): Promise<{ stop(): Promise<void> }> {
  const { infra, logger } = deps;
  // In-process queues cannot outlive the process, so its running runs are queued again.
  if (infra.kind === 'memory') {
    const recovered = await inEveryOrganization(deps, () => recoverInterruptedRuns(deps));
    if (recovered) logger.warn({ runs: recovered }, 'took over runs interrupted by a restart');
    const requeued = await inEveryOrganization(deps, () => requeuePendingEventDeliveries(deps));
    if (requeued) logger.info({ deliveries: requeued }, 'requeued pending event deliveries');
  }
  // Requests that came due while no worker was up, or whose in-memory job was lost.
  const expired = await inEveryOrganization(deps, () => expireDueApprovals(deps));
  if (expired) logger.info({ approvals: expired }, 'expired overdue approval requests');
  const logins = await inEveryOrganization(deps, () => expireDueLoginRequests(deps));
  if (logins) logger.info({ logins }, 'expired overdue sign-in requests');
  for (const [name, { handler, concurrency }] of Object.entries(JOB_HANDLERS)) {
    await infra.queue(name).process(handler(deps), {
      concurrency,
      onError: (err, job) => logger.error({ err, queue: name, jobId: job.id }, 'job failed'),
    });
  }
  // A new release's computer image, for computers to move to at their next start (plan 16.3).
  void refreshSandboxImage(deps);
  // Idle computers stop after their timeout (plan 9.5); the home volume stays.
  const sweep = setInterval(() => {
    inEveryOrganization(deps, () => sweepIdleComputers(deps)).then(
      (stopped) => stopped && logger.info({ computers: stopped }, 'stopped idle computers'),
      (err: unknown) => logger.error({ err }, 'idle computer sweep failed'),
    );
  }, IDLE_SWEEP_MS);
  sweep.unref();
  // Audit rows past the workspace's retention (default 180 days, S-11); now and hourly.
  const trimAudit = () =>
    inEveryOrganization(deps, () => trimAuditLog(deps)).then(
      (trimmed) => trimmed && logger.info({ rows: trimmed }, 'trimmed the audit log'),
      (err: unknown) => logger.error({ err }, 'audit log trim failed'),
    );
  void trimAudit();
  const trim = setInterval(trimAudit, AUDIT_TRIM_MS);
  trim.unref();
  // Pairings used or past their 5 minutes are dropped; now and every few minutes (plan 4.5).
  const sweepPairings = () =>
    inEveryOrganization(deps, () => expireDuePairings(deps)).then(
      (dropped) => dropped && logger.info({ pairings: dropped }, 'dropped spent pairings'),
      (err: unknown) => logger.error({ err }, 'pairing sweep failed'),
    );
  void sweepPairings();
  const pairings = setInterval(sweepPairings, PAIRING_SWEEP_MS);
  pairings.unref();
  // Due Routines every 30 seconds, exactly once per slot across workers (plan 10.2).
  const stopScheduler = startRoutineScheduler(deps);
  // Bus events an owner subscribed to become signed outbound deliveries (H6).
  const stopFanOut = await startEventFanOut(deps);
  // Notices become encrypted pushes through the relay (RELAY_PROTOCOL.md 7), when there is one
  // and its link runs (it does not when the instance key could not be opened, server.ts).
  const push = deps.config.relayUrl && deps.relay ? await startPushWorker(deps) : null;
  logger.info({ queues: Object.keys(JOB_HANDLERS), infra: infra.kind }, 'workers started');
  // The queues themselves are closed with the infra in main.ts.
  return {
    stop: async () => {
      clearInterval(sweep);
      clearInterval(trim);
      clearInterval(pairings);
      stopScheduler();
      await stopFanOut();
      await push?.stop();
    },
  };
}
