import { skillBlock } from '@openbots/agent';
import {
  describeTrigger,
  InvalidScheduleError,
  isValidTimezone,
  normalizeTrigger,
  triggerNextRunAt,
} from '@openbots/routines';
import {
  handleFromName,
  RoutineTriggerSchema,
  withHandleSuffix,
  type EventTrigger,
  type MessagePart,
  type RoutineRunStatus,
  type RoutineTrigger,
  type RoutineTriggerInput,
} from '@openbots/shared';
import {
  type RoutineCreatedProps,
  type RoutineProposalProps,
  type RoutineProposalState,
  type RoutineRunProps,
  type RoutineRunState,
} from '@openbots/widgets';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  sql,
} from 'drizzle-orm';
import { ZodRealError } from 'zod';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { insertRoutineEndpoint } from '../hooks/inbox.js';
import { ownerActive } from '../membership.js';
import { parseTriggerRule } from '../hooks/match.js';
import { assertBotOwner } from '../ownership.js';
import { recordAudit, userActor } from './audit.js';
import type { Config } from '../config.js';
import { organizationSettings, raiseLimitHint } from '../workspace.js';
import { onRunStatus, onWidgetAction } from './hooks.js';
import { announceMessage, postMessage, storeMessage } from './messages.js';
import { insertRun, scheduleRun, TERMINAL_STATUSES, type RunInput, type RunRow } from './runs.js';
import { skillOrigin } from './skills.js';
import { dueRoutineWorkspaces, inWorkspace } from '../db/scope.js';

// Routines (plan 4.6, 10.2, R1 to R5). A Routine binds a Bot, a trigger and a
// prompt (or a Skill) and posts into the Bot's transcript by default.
//
// Scheduler: every 30 seconds the worker claims the due Routines with
// `SELECT ... FOR UPDATE SKIP LOCKED`, inserts a `routine_runs` record keyed
// by (routine, slot) and a `routine` run at priority 3, and advances
// `next_run_at` with croner, all in one transaction; the run's job is queued
// after commit. Two workers ticking at once never claim the same row, and a
// worker that read a stale `next_run_at` hits the (routine, slot) key, so each
// slot is enqueued once. Missed slots (no worker up) collapse into one run.
//
// Every run keeps a record (trimmed to the 20 most recent per Routine, R4)
// that follows the run's status; when the run ends a "Routine ran" widget is
// posted into the transcript with the outcome and the exception actions (R3).
//
// A Routine's Skill must be enabled for its Bot (S2), as for `/` and
// `use_skill`. Create and update refuse one that is not. A Skill that stops
// being usable later (deleted, turned off for the Bot) makes a schedule or
// event run a failed record with no run, and an event row in the transcript
// says why (once, not on every slot); Run now and Run again refuse.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type RoutinesDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export type RoutineRow = typeof schema.routines.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
export type RoutineRunRow = typeof schema.routineRuns.$inferSelect;
export type RoutineRunReason = 'schedule' | 'run_now' | 'event' | 'retry';

/** How often the worker looks for due Routines (plan 10.2). */
export const ROUTINE_TICK_MS = 30_000;
/** Routines claimed per tick; the rest wait for the next one. */
const TICK_BATCH = 50;

export const routineLimitReached = (limit: number, config: Pick<Config, 'deployment'>) =>
  new DomainError(
    409,
    'ROUTINE_LIMIT_REACHED',
    `This Bot has reached its limit of ${limit} Routines. Delete one, or ${raiseLimitHint(config)}.`,
  );
const invalidSchedule = (message: string) => new DomainError(400, 'INVALID_SCHEDULE', message);
const emptyRoutine = () =>
  new DomainError(400, 'EMPTY_ROUTINE', 'A Routine needs a prompt or a Skill to run');

export interface RoutineInput {
  name: string;
  trigger: RoutineTriggerInput;
  prompt?: string;
  skillId?: string | null;
  enabled?: boolean;
  timezone?: string;
}

export type RoutinePatch = Partial<RoutineInput>;

export interface RoutineRecord {
  routine: RoutineRow;
  lastRun: RoutineRunRow | null;
}

/**
 * The trigger with its cron derived from the preset; 400 for a bad schedule or
 * timezone, or for an event trigger's matching rule that does not parse.
 */
export function checkedTrigger(input: RoutineTriggerInput, timezone: string): RoutineTrigger {
  if (!isValidTimezone(timezone)) throw invalidSchedule(`Unknown timezone ${timezone}`);
  if (input.type === 'event' && input.match) {
    const rule = parseTriggerRule(input);
    if (!rule.success) {
      throw new ZodRealError(
        rule.error.issues.map((i) => ({ ...i, path: ['trigger', 'match', ...i.path] })),
      );
    }
  }
  try {
    return normalizeTrigger(input);
  } catch (error) {
    if (error instanceof InvalidScheduleError) throw invalidSchedule(error.message);
    throw error;
  }
}

/** When an enabled Routine next runs, from now; null for event triggers and disabled ones. */
function nextRun(trigger: RoutineTrigger, timezone: string, enabled: boolean, now = new Date()) {
  return enabled ? triggerNextRunAt(trigger, timezone, now) : null;
}

async function freeSlug(tx: Db, botId: string, name: string, exceptId?: string): Promise<string> {
  const base = handleFromName(name) || 'routine';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : withHandleSuffix(base, String(n));
    const [taken] = await tx
      .select({ id: schema.routines.id })
      .from(schema.routines)
      .where(and(eq(schema.routines.botId, botId), eq(schema.routines.slug, candidate)));
    if (!taken || taken.id === exceptId) return candidate;
  }
}

/**
 * Why a Routine of `botId` cannot run the Skill `skillId` (S1, S2), in words
 * for the owner; null when it can.
 */
export async function skillProblem(
  db: Db,
  botId: string,
  skillId: string | null,
): Promise<string | null> {
  if (!skillId) return null;
  const [skill] = await db
    .select({ name: schema.skills.name, enabled: schema.botSkills.enabled })
    .from(schema.skills)
    .leftJoin(
      schema.botSkills,
      and(eq(schema.botSkills.skillId, schema.skills.id), eq(schema.botSkills.botId, botId)),
    )
    .where(eq(schema.skills.id, skillId));
  if (!skill) return 'Its Skill was deleted.';
  if (!skill.enabled) {
    return `The Skill "${skill.name}" is not enabled for this Bot. Enable it in the Bot's Settings first.`;
  }
  return null;
}

const skillUnavailable = (problem: string) => new DomainError(409, 'SKILL_UNAVAILABLE', problem);

/** 400 unless the Skill is the owner's and enabled for the Bot (S2). */
async function assertUsableSkill(db: Db, owner: Owner, botId: string, skillId: string) {
  await assertSkillOwner(db, owner, skillId);
  const problem = await skillProblem(db, botId, skillId);
  if (problem) throw new DomainError(400, 'SKILL_UNAVAILABLE', problem);
}

/**
 * Creates a Routine for one of the owner's Bots; at most 50 per Bot (R4,
 * admin-overridable), counted under the Bot's Routines lock. `db` may be a
 * caller's transaction (a proposal's Confirm). An event Routine that names
 * no endpoint gets its own in the same transaction, without a token until
 * the owner generates one (R2, H2).
 */
export async function createRoutine(
  deps: Pick<AppDeps, 'config' | 'db'>,
  owner: Owner,
  botId: string,
  input: RoutineInput,
  db: Db = deps.db,
): Promise<RoutineRow> {
  await assertBotOwner(db, owner, botId);
  const timezone = input.timezone ?? 'UTC';
  const trigger = checkedTrigger(input.trigger, timezone);
  const prompt = input.prompt?.trim() ?? '';
  if (!prompt && !input.skillId) throw emptyRoutine();
  if (input.skillId) await assertUsableSkill(db, owner, botId, input.skillId);
  await assertEndpointOf(db, botId, trigger);
  const enabled = input.enabled ?? true;
  const create = async (tx: Db) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`routines:${botId}`}))`);
    const { limits } = await organizationSettings({ ...deps, db: tx }, owner.workspaceId);
    const [row] = await tx
      .select({ n: count() })
      .from(schema.routines)
      .where(eq(schema.routines.botId, botId));
    if ((row?.n ?? 0) >= limits.routinesPerBot)
      throw routineLimitReached(limits.routinesPerBot, deps.config);
    const [created] = await tx
      .insert(schema.routines)
      .values({
        workspaceId: owner.workspaceId,
        botId,
        name: input.name.trim(),
        slug: await freeSlug(tx, botId, input.name),
        trigger,
        promptMd: prompt,
        skillId: input.skillId ?? null,
        enabled,
        timezone,
        nextRunAt: nextRun(trigger, timezone, enabled),
      })
      .returning();
    if (trigger.type === 'event' && !trigger.endpoint_id) {
      return linkNewEndpoint(tx, owner, created!, trigger);
    }
    return created!;
  };
  return db === deps.db ? db.transaction(create) : create(db);
}

async function assertSkillOwner(db: Db, owner: Owner, skillId: string) {
  const [skill] = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.id, skillId),
        eq(schema.skills.ownerId, owner.id),
        eq(schema.skills.workspaceId, owner.workspaceId),
      ),
    );
  if (!skill) throw notFound('Skill not found');
}

/** Gives an event Routine a new endpoint without a token, links it and audits it (R2, H2). */
async function linkNewEndpoint(
  tx: Db,
  owner: Owner,
  routine: RoutineRow,
  trigger: EventTrigger,
): Promise<RoutineRow> {
  const endpoint = await insertRoutineEndpoint(tx, routine);
  await recordAudit(tx, {
    workspaceId: owner.workspaceId,
    actor: userActor(owner),
    action: 'webhook.create',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    metadata: { botId: routine.botId, slug: endpoint.slug, routineId: routine.id },
  });
  const [linked] = await tx
    .update(schema.routines)
    .set({ trigger: { ...trigger, endpoint_id: endpoint.id } })
    .where(eq(schema.routines.id, routine.id))
    .returning();
  return linked!;
}

/** 404 unless an event trigger's webhook endpoint is one of the Routine's Bot's (S-18 G3). */
async function assertEndpointOf(db: Db, botId: string, trigger: RoutineTrigger) {
  if (trigger.type !== 'event' || !trigger.endpoint_id) return;
  const [endpoint] = await db
    .select({ id: schema.webhookEndpoints.id })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, trigger.endpoint_id),
        eq(schema.webhookEndpoints.botId, botId),
      ),
    );
  if (!endpoint) throw notFound('Webhook endpoint not found');
}

/** The Bot's Routines with their latest run record, oldest first. */
export async function listRoutines(db: Db, owner: Owner, botId: string): Promise<RoutineRecord[]> {
  await assertBotOwner(db, owner, botId);
  const rows = await db
    .select()
    .from(schema.routines)
    .where(eq(schema.routines.botId, botId))
    .orderBy(asc(schema.routines.createdAt), asc(schema.routines.id));
  return withLastRuns(db, rows);
}

async function withLastRuns(db: Db, rows: RoutineRow[]): Promise<RoutineRecord[]> {
  if (!rows.length) return [];
  const runs = await db
    .selectDistinctOn([schema.routineRuns.routineId])
    .from(schema.routineRuns)
    .where(
      inArray(
        schema.routineRuns.routineId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(
      schema.routineRuns.routineId,
      desc(schema.routineRuns.startedAt),
      desc(schema.routineRuns.id),
    );
  const last = new Map(runs.map((r) => [r.routineId, r]));
  return rows.map((routine) => ({ routine, lastRun: last.get(routine.id) ?? null }));
}

/** One of the owner's Routines; another user's is 404. */
export async function getRoutine(db: Db, owner: Owner, routineId: string): Promise<RoutineRow> {
  const [row] = await db.select().from(schema.routines).where(eq(schema.routines.id, routineId));
  if (!row) throw notFound('Routine not found');
  await assertBotOwner(db, owner, row.botId).catch(() => {
    throw notFound('Routine not found');
  });
  return row;
}

export async function getRoutineRecord(
  db: Db,
  owner: Owner,
  routineId: string,
): Promise<RoutineRecord> {
  const [record] = await withLastRuns(db, [await getRoutine(db, owner, routineId)]);
  return record!;
}

/**
 * Edits a Routine. A change to the trigger, timezone or enabled flag moves
 * `next_run_at` to the next slot from now, so an edit never leaves a stale
 * slot behind (no drift after edits, plan 10.2). A trigger that stops being
 * an event turns the Routine's endpoints off, so they cannot start it;
 * switching back to an event turns on again only the ones that switch turned
 * off (the named one, when the trigger names one) and links it; a Routine
 * with no endpoint at all gets a new one without a token (R2, H2). Each
 * change is audited. An endpoint the owner turned off stays off.
 */
export async function updateRoutine(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  routineId: string,
  patch: RoutinePatch,
): Promise<RoutineRow> {
  const current = await getRoutine(deps.db, owner, routineId);
  const timezone = patch.timezone ?? current.timezone;
  const enabled = patch.enabled ?? current.enabled;
  const trigger = patch.trigger
    ? checkedTrigger(patch.trigger, timezone)
    : RoutineTriggerSchema.parse(current.trigger);
  if (patch.timezone && !isValidTimezone(timezone)) {
    throw invalidSchedule(`Unknown timezone ${timezone}`);
  }
  const prompt = patch.prompt !== undefined ? patch.prompt.trim() : current.promptMd;
  const skillId = patch.skillId !== undefined ? patch.skillId : current.skillId;
  if (!prompt && !skillId) throw emptyRoutine();
  if (patch.skillId && patch.skillId !== current.skillId) {
    await assertUsableSkill(deps.db, owner, current.botId, patch.skillId);
  }
  if (patch.trigger) await assertEndpointOf(deps.db, current.botId, trigger);
  const rescheduled =
    patch.trigger !== undefined || patch.timezone !== undefined || patch.enabled !== undefined;
  const wasEvent = RoutineTriggerSchema.safeParse(current.trigger).data?.type === 'event';
  return deps.db.transaction(async (tx) => {
    let stored = trigger;
    const switched = (enabled: boolean, ids: { id: string }[]) =>
      Promise.all(
        ids.map(({ id }) =>
          recordAudit(tx, {
            workspaceId: owner.workspaceId,
            actor: userActor(owner),
            action: 'webhook.update',
            targetType: 'webhook_endpoint',
            targetId: id,
            metadata: { fields: ['enabled'], enabled, reason: 'trigger_switch', routineId },
          }),
        ),
      );
    if (patch.trigger && trigger.type !== 'event') {
      // Only endpoints that are on: one the owner turned off keeps its reason.
      await switched(
        false,
        await tx
          .update(schema.webhookEndpoints)
          .set({ enabled: false, disabledReason: 'trigger_switch' })
          .where(
            and(
              eq(schema.webhookEndpoints.routineId, routineId),
              eq(schema.webhookEndpoints.enabled, true),
            ),
          )
          .returning({ id: schema.webhookEndpoints.id }),
      );
    }
    if (patch.trigger && trigger.type === 'event' && !wasEvent) {
      // Only what a trigger switch turned off, and only the named endpoint when there is one.
      const back = await tx
        .update(schema.webhookEndpoints)
        .set({ enabled: true, disabledReason: null })
        .where(
          and(
            eq(schema.webhookEndpoints.routineId, routineId),
            eq(schema.webhookEndpoints.disabledReason, 'trigger_switch'),
            trigger.endpoint_id ? eq(schema.webhookEndpoints.id, trigger.endpoint_id) : undefined,
          ),
        )
        .returning({ id: schema.webhookEndpoints.id });
      await switched(true, back);
      if (back.length === 1 && !trigger.endpoint_id)
        stored = { ...trigger, endpoint_id: back[0]!.id };
    }
    const [row] = await tx
      .update(schema.routines)
      .set({
        ...(patch.name !== undefined
          ? {
              name: patch.name.trim(),
              slug: await freeSlug(tx, current.botId, patch.name, current.id),
            }
          : {}),
        trigger: stored,
        promptMd: prompt,
        skillId,
        enabled,
        timezone,
        ...(rescheduled ? { nextRunAt: nextRun(trigger, timezone, enabled) } : {}),
      })
      .where(eq(schema.routines.id, routineId))
      .returning();
    if (!row) throw notFound('Routine not found');
    if (patch.trigger && stored.type === 'event' && !stored.endpoint_id && !wasEvent) {
      const [any] = await tx
        .select({ id: schema.webhookEndpoints.id })
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.routineId, routineId))
        .limit(1);
      if (!any) return linkNewEndpoint(tx, owner, row, stored);
    }
    return row;
  });
}

/** Deletes a Routine and its run records; runs already started finish. */
export async function deleteRoutine(db: Db, owner: Owner, routineId: string): Promise<void> {
  await getRoutine(db, owner, routineId);
  await db.delete(schema.routines).where(eq(schema.routines.id, routineId));
}

/** The Routine's run records, newest first (at most 20 are kept, R4). */
export async function listRoutineRuns(
  db: Db,
  owner: Owner,
  routineId: string,
): Promise<RoutineRunRow[]> {
  await getRoutine(db, owner, routineId);
  return db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, routineId))
    .orderBy(desc(schema.routineRuns.startedAt), desc(schema.routineRuns.id));
}

/** `POST /routines/:id/run-now`: one run now, outside the schedule, which stays as it is. */
export async function runRoutineNow(
  deps: RoutinesDeps,
  owner: Owner,
  routineId: string,
): Promise<RoutineRunRow> {
  const routine = await getRoutine(deps.db, owner, routineId);
  const started = await deps.db.transaction((tx) =>
    claimRoutineRun(deps, tx, routine, { reason: 'run_now' }),
  );
  // Run now has no slot, and refuses rather than skips: neither null nor skipped.
  if (!started || 'skipped' in started) throw notFound('Routine not found');
  await dispatchRoutineRun(deps, started);
  return started.routineRun;
}

/**
 * Starts a Routine's run for an event (leaf 6.3 calls this when a matched
 * webhook, GitHub or Slack event arrives for an event-triggered Routine).
 * `before` runs after the claim commits and before the job is queued (the
 * webhook message goes into the transcript there).
 */
export async function startRoutineForEvent(
  deps: RoutinesDeps,
  routine: RoutineRow,
  input: Pick<RunInput, 'webhook'> = {},
  before?: (claimed: ClaimedRoutineRun) => Promise<void>,
): Promise<ClaimedRoutineRun | SkippedRoutineRun | null> {
  if (!routine.enabled) return null;
  const started = await deps.db.transaction((tx) =>
    claimRoutineRun(deps, tx, routine, { reason: 'event', input }),
  );
  if (!started) return null;
  if ('skipped' in started) {
    if (started.message) await announceMessage(deps, started.message);
    return started;
  }
  await before?.(started);
  await dispatchRoutineRun(deps, started);
  return started;
}

export interface ClaimedRoutineRun {
  routineRun: RoutineRunRow;
  run: RunRow;
}

/** A slot or event the Routine's Skill could not run (S1, S2): a failed record and no run. */
export interface SkippedRoutineRun {
  skipped: string;
  routineRun: RoutineRunRow;
  /** The event row that says why, to announce after commit; null when the last record said so already. */
  message: MessageRow | null;
}

/**
 * Inside `tx`: the run record, keyed by (routine, slot) for schedule runs so
 * a slot is claimed once (null when it already was), the `routine` run row
 * (priority 3, plan 5.1), `last_run_at`, and the trim to the most recent
 * records (R4). The run's job is queued by `dispatchRoutineRun` after commit.
 * A Skill that cannot run (`skillProblem`) refuses Run now and Run again with
 * 409, and skips a schedule or event run (`SkippedRoutineRun`).
 */
export async function claimRoutineRun(
  deps: Pick<AppDeps, 'config'>,
  tx: Db,
  routine: RoutineRow,
  {
    reason,
    slot = null,
    input = {},
  }: { reason: RoutineRunReason; slot?: Date | null; input?: Pick<RunInput, 'webhook'> },
): Promise<ClaimedRoutineRun | SkippedRoutineRun | null> {
  const problem = await skillProblem(tx, routine.botId, routine.skillId);
  if (problem) {
    if (reason === 'run_now' || reason === 'retry') throw skillUnavailable(problem);
    return skipRoutineRun(deps, tx, routine, { reason, slot, problem });
  }
  const [record] = await tx
    .insert(schema.routineRuns)
    .values({
      workspaceId: routine.workspaceId,
      routineId: routine.id,
      status: 'queued' satisfies RoutineRunStatus,
      reason,
      slot,
      startedAt: new Date(),
    })
    .onConflictDoNothing({ target: [schema.routineRuns.routineId, schema.routineRuns.slot] })
    .returning();
  if (!record) return null;
  const chatId = routine.chatId ?? (await transcriptId(tx, routine.botId));
  const run = await insertRun(tx, {
    botId: routine.botId,
    chatId,
    trigger: 'routine',
    input: { ...input, routine: { routineId: routine.id, routineRunId: record.id } },
  });
  const [routineRun] = await tx
    .update(schema.routineRuns)
    .set({ runId: run.id })
    .where(eq(schema.routineRuns.id, record.id))
    .returning();
  await tx
    .update(schema.routines)
    .set({ lastRunAt: new Date() })
    .where(eq(schema.routines.id, routine.id));
  const { limits } = await organizationSettings({ ...deps, db: tx }, routine.workspaceId);
  await trimRoutineRuns(tx, routine.id, limits.runRecordsPerRoutine);
  return { routineRun: routineRun!, run };
}

/**
 * Records a run the Routine's Skill could not make: a failed record with the
 * reason and no run. The transcript gets an event row saying why, unless the
 * Routine's last record already did, so a Routine every minute does not post
 * one a minute.
 */
async function skipRoutineRun(
  deps: Pick<AppDeps, 'config'>,
  tx: Db,
  routine: RoutineRow,
  { reason, slot, problem }: { reason: RoutineRunReason; slot: Date | null; problem: string },
): Promise<SkippedRoutineRun | null> {
  const [previous] = await tx
    .select({ runId: schema.routineRuns.runId, exception: schema.routineRuns.exception })
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, routine.id))
    .orderBy(desc(schema.routineRuns.startedAt), desc(schema.routineRuns.id))
    .limit(1);
  const now = new Date();
  const [record] = await tx
    .insert(schema.routineRuns)
    .values({
      workspaceId: routine.workspaceId,
      routineId: routine.id,
      status: 'failed' satisfies RoutineRunStatus,
      reason,
      slot,
      startedAt: now,
      finishedAt: now,
      exception: problem,
    })
    .onConflictDoNothing({ target: [schema.routineRuns.routineId, schema.routineRuns.slot] })
    .returning();
  if (!record) return null;
  const { limits } = await organizationSettings({ ...deps, db: tx }, routine.workspaceId);
  await trimRoutineRuns(tx, routine.id, limits.runRecordsPerRoutine);
  const repeated = previous && !previous.runId && previous.exception === problem;
  if (repeated) return { skipped: problem, routineRun: record, message: null };
  const chatId = routine.chatId ?? (await transcriptId(tx, routine.botId));
  const message = await storeMessage(
    tx,
    { id: chatId, workspaceId: routine.workspaceId },
    {
      authorType: 'routine',
      authorId: routine.id,
      parts: [
        {
          type: 'event',
          kind: 'routine_skipped',
          text: `The Routine "${routine.name}" did not run. ${problem}`,
          data: { routineId: routine.id, skillId: routine.skillId },
        },
      ],
    },
  );
  return { skipped: problem, routineRun: record, message };
}

/** Queues a claimed run's job, after the claiming transaction committed. */
export async function dispatchRoutineRun(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  claimed: ClaimedRoutineRun,
) {
  await scheduleRun(deps, claimed.run, 'run');
}

/** Keeps the `keep` most recent run records of a Routine (R4). */
export async function trimRoutineRuns(db: Db, routineId: string, keep: number) {
  const kept = db
    .select({ id: schema.routineRuns.id })
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, routineId))
    .orderBy(desc(schema.routineRuns.startedAt), desc(schema.routineRuns.id))
    .limit(keep);
  await db
    .delete(schema.routineRuns)
    .where(
      and(eq(schema.routineRuns.routineId, routineId), notInArray(schema.routineRuns.id, kept)),
    );
}

/** The Bot's transcript, created if missing (as `openBotChat` does). */
async function transcriptId(tx: Db, botId: string): Promise<string> {
  const find = () =>
    tx
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(and(eq(schema.chats.botId, botId), eq(schema.chats.type, 'bot_dm')));
  const [chat] = await find();
  if (chat) return chat.id;
  const [bot] = await tx.select().from(schema.bots).where(eq(schema.bots.id, botId));
  if (!bot) throw notFound('Bot not found');
  await tx
    .insert(schema.chats)
    .values({ workspaceId: bot.workspaceId, ownerId: bot.ownerId, type: 'bot_dm', botId })
    .onConflictDoNothing();
  const [created] = await find();
  return created!.id;
}

// The scheduler (plan 10.2)

/**
 * One scheduler tick: claims every enabled Routine whose `next_run_at` has
 * passed, skipping rows another worker holds, and starts one run per slot.
 * Returns the number of runs started. `now` is the clock (tests fake it).
 */
export async function tickRoutines(deps: RoutinesDeps, now: Date = new Date()): Promise<number> {
  const claimed = await deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schema.routines)
      .where(
        and(
          eq(schema.routines.enabled, true),
          isNotNull(schema.routines.nextRunAt),
          lte(schema.routines.nextRunAt, now),
        ),
      )
      .orderBy(asc(schema.routines.nextRunAt))
      .limit(TICK_BATCH)
      .for('update', { skipLocked: true });
    const out: (ClaimedRoutineRun | SkippedRoutineRun)[] = [];
    for (const routine of due) {
      const slot = routine.nextRunAt!;
      let next: Date | null = null;
      try {
        // From now, not from the slot: missed slots collapse into this one run.
        // An interval keeps its rhythm from the slot (R1).
        const parsed = RoutineTriggerSchema.parse(routine.trigger);
        next = triggerNextRunAt(parsed, routine.timezone, slot > now ? slot : now, slot);
      } catch (error) {
        deps.logger.error({ err: error, routineId: routine.id }, 'routine has a bad schedule');
      }
      await tx
        .update(schema.routines)
        .set({ nextRunAt: next })
        .where(eq(schema.routines.id, routine.id));
      // A suspended or removed owner's Routines wait, without a run (plan 21.6).
      const [bot] = await tx
        .select({ ownerId: schema.bots.ownerId, workspaceId: schema.bots.workspaceId })
        .from(schema.bots)
        .where(eq(schema.bots.id, routine.botId));
      if (!bot || !(await ownerActive(tx, bot))) continue;
      const started = await claimRoutineRun(deps, tx, routine, { reason: 'schedule', slot });
      if (started) out.push(started);
    }
    return out;
  });
  for (const skipped of claimed) {
    if (!('skipped' in skipped) || !skipped.message) continue;
    await announceMessage(deps, skipped.message).catch((err: unknown) =>
      deps.logger.error({ err, routineId: skipped.routineRun.routineId }, 'skip not announced'),
    );
  }
  const runs = claimed.filter((c): c is ClaimedRoutineRun => !('skipped' in c));
  for (const started of runs) {
    try {
      await dispatchRoutineRun(deps, started);
    } catch (error) {
      deps.logger.error({ err: error, runId: started.run.id }, 'routine run not queued');
    }
  }
  return runs.length;
}

/** The 30-second ticker in the worker; stop it with the returned function. */
/**
 * One scheduler tick: only the organizations with a Routine due, each in its
 * own scope (db/scope.ts). Returns the runs started.
 */
export async function tickDueRoutines(deps: RoutinesDeps, now: Date = new Date()): Promise<number> {
  let started = 0;
  for (const id of await dueRoutineWorkspaces(deps.db, now)) {
    started += await inWorkspace(id, () => tickRoutines(deps, now));
  }
  return started;
}

export function startRoutineScheduler(deps: RoutinesDeps, everyMs = ROUTINE_TICK_MS): () => void {
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    tickDueRoutines(deps)
      .then(
        (started) => started && deps.logger.info({ runs: started }, 'started due routines'),
        (err: unknown) => deps.logger.error({ err }, 'routine scheduler tick failed'),
      )
      .finally(() => {
        ticking = false;
      });
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Run records follow their run, and a finished run posts "Routine ran" (R3).

/** The `onRunStatus` hook: keeps the record's status, and on a final status posts the widget. */
export async function syncRoutineRun(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  run: RunRow,
): Promise<void> {
  if (run.trigger !== 'routine') return;
  const [record] = await deps.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.runId, run.id));
  if (!record || record.finishedAt) return;
  if (!TERMINAL_STATUSES.includes(run.status)) {
    await deps.db
      .update(schema.routineRuns)
      .set({ status: run.status satisfies RoutineRunStatus })
      .where(and(eq(schema.routineRuns.id, record.id), isNull(schema.routineRuns.finishedAt)));
    return;
  }
  const finishedAt = run.finishedAt ?? new Date();
  const exception = run.status === 'completed' ? null : (run.error ?? null);
  // The closed record, the "Routine ran" message and the link between them
  // commit together, so a reader never sees a finished record without its
  // result. Only the first final status posts, however many times it is
  // published.
  const posted = await deps.db.transaction(async (tx) => {
    const [closed] = await tx
      .update(schema.routineRuns)
      .set({ status: run.status, finishedAt, exception })
      .where(and(eq(schema.routineRuns.id, record.id), isNull(schema.routineRuns.finishedAt)))
      .returning();
    if (!closed || !run.chatId) return null;
    const [routine] = await tx
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, record.routineId));
    if (!routine) return null;
    const props: RoutineRunProps = {
      routine_id: routine.id,
      routine_run_id: record.id,
      bot_id: routine.botId,
      name: routine.name,
      run_id: run.id,
      outcome: run.status as RoutineRunProps['outcome'],
      reason: record.reason as RoutineRunReason,
      started_at: (run.startedAt ?? record.startedAt).toISOString(),
      finished_at: finishedAt.toISOString(),
      ...(exception ? { exception: exception.slice(0, 2_000) } : {}),
    };
    const message = await storeMessage(
      tx,
      { id: run.chatId, workspaceId: run.workspaceId },
      {
        authorType: 'routine',
        authorId: routine.id,
        parts: [{ type: 'widget', kind: 'routine_run', props }],
      },
    );
    await tx
      .update(schema.routineRuns)
      .set({ resultMessageId: message.id })
      .where(eq(schema.routineRuns.id, record.id));
    return message;
  });
  if (posted) await announceMessage(deps, posted);
}

/** What a Routine run's context starts from: the Routine's prompt, or its Skill. */
export async function routineInstructions(db: Db, routineId: string): Promise<string | null> {
  const [routine] = await db
    .select()
    .from(schema.routines)
    .where(eq(schema.routines.id, routineId));
  if (!routine) return null;
  const trigger = RoutineTriggerSchema.safeParse(routine.trigger);
  const when = trigger.success ? ` (${describeTrigger(trigger.data, routine.timezone)})` : '';
  const lines = [
    `[system] Your Routine "${routine.name}"${when} started this run; the owner is not waiting. Do what it says and report the result in this chat.`,
  ];
  if (routine.promptMd) lines.push(routine.promptMd);
  if (routine.skillId) {
    const [skill] = await db
      .select({
        name: schema.skills.name,
        content: schema.skills.content,
        origin: schema.skills.origin,
      })
      .from(schema.skills)
      .where(eq(schema.skills.id, routine.skillId));
    if (skill) {
      const importedFrom = skillOrigin(skill.origin)?.repo ?? null;
      lines.push(`Follow the Skill "${skill.name}":`, skillBlock({ ...skill, importedFrom }));
    }
  }
  return lines.join('\n\n');
}

// Widget effects: Confirm on a proposal (R5), Run again and Pause on a run.

async function confirmProposal(
  deps: Pick<AppDeps, 'config' | 'db'>,
  tx: Db,
  message: { chatId: string; authorType: string; authorId: string | null },
  props: RoutineProposalProps,
  state: RoutineProposalState,
) {
  if (message.authorType !== 'bot' || !message.authorId) throw notFound('Bot not found');
  const [chat] = await tx
    .select({ ownerId: schema.chats.ownerId, workspaceId: schema.chats.workspaceId })
    .from(schema.chats)
    .where(eq(schema.chats.id, message.chatId));
  if (!chat) throw notFound('Chat not found');
  const timezone = state.timezone ?? 'UTC';
  return createRoutine(
    deps,
    { id: chat.ownerId, workspaceId: chat.workspaceId },
    message.authorId,
    { name: props.name, prompt: props.prompt, trigger: props.trigger, timezone },
    tx,
  );
}

/**
 * Registers the run-status and widget hooks; call once per process (main.ts),
 * like `registerRunHooks`. Returns the unregister function.
 */
export function registerRoutineHooks(): () => void {
  const off = [
    onRunStatus(syncRoutineRun),
    onWidgetAction('routine_proposal', async (deps, tx, { message, props, state }) => {
      const proposal = state as RoutineProposalState;
      if (proposal.status !== 'confirmed') return;
      const routine = await confirmProposal(
        deps,
        tx,
        message,
        props as RoutineProposalProps,
        proposal,
      );
      return {
        state: { ...proposal, routine_id: routine.id } satisfies RoutineProposalState,
        after: async () => {
          const created: RoutineCreatedProps = {
            routine_id: routine.id,
            bot_id: routine.botId,
            name: routine.name,
            trigger: RoutineTriggerSchema.parse(routine.trigger),
            timezone: routine.timezone,
            next_run_at: routine.nextRunAt?.toISOString() ?? null,
          };
          const parts: MessagePart[] = [
            { type: 'widget', kind: 'routine_created', props: created },
          ];
          await postMessage(deps, message.chatId, {
            authorType: 'routine',
            authorId: routine.id,
            threadRootId: message.threadRootId,
            parts,
          });
        },
      };
    }),
    onWidgetAction('routine_run', async (deps, tx, { props, state, action }) => {
      const { routine_id: routineId } = props as RoutineRunProps;
      const [routine] = await tx
        .select()
        .from(schema.routines)
        .where(eq(schema.routines.id, routineId))
        .for('update');
      if (!routine) throw new DomainError(409, 'ROUTINE_GONE', 'This Routine was deleted');
      const current = state as RoutineRunState;
      if ((action as { type: string }).type === 'pause') {
        await tx
          .update(schema.routines)
          .set({ enabled: false, nextRunAt: null })
          .where(eq(schema.routines.id, routine.id));
        return;
      }
      // Retry has no slot and refuses rather than skips, so it always claims.
      const claimed = (await claimRoutineRun(deps, tx, routine, {
        reason: 'retry',
      })) as ClaimedRoutineRun;
      return {
        state: { ...current, rerun_run_id: claimed.run.id } satisfies RoutineRunState,
        after: () => dispatchRoutineRun(deps, claimed),
      };
    }),
  ];
  return () => off.forEach((f) => f());
}
