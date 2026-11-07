import {
  RepoRescueResultSchema,
  type CodingSessionStatus,
  type EventBus,
  type RepoRescueResult,
} from '@openbots/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { recordAudit, userActor } from './audit.js';
import {
  assertResettable,
  computerAvailable,
  computerUnavailable,
  destroyComputer,
  getComputer,
  type ComputerRow,
} from './computer.js';
import {
  RESCUE_CHANNEL,
  rescueStatus,
  startRescue,
  unsavedWork,
  type RescueMessage,
} from './repos-rescue.js';

// Reset computer, rescue first (GH5; the owner's decision). `prepareReset`
// runs the rescue job over every checkout of the owner's computer (the job
// starts the computer if it is off) and remembers which coding sessions were
// live; `resetStatus` reads the rescue's results, what it could not push and
// the live sessions, so the UI can warn; `resetComputer` then, within
// `RESET_PREPARE_TTL_MS` of the prepare and only once its rescue is done,
// stops the computer and its coding sessions, removes the container and its
// home volume (the state volume, with the cookie store and the coding agents'
// sign-ins, only on request), marks every checkout `missing`, clears the
// sessions' worktree paths and records `computer.reset`. The next start makes
// a fresh computer, and its reconcile clones the `keep_cloned` repositories
// again.
//
// A prepare reaches every process over the bus, as the rescue's results do,
// so the process that takes the reset need not be the one that took the
// prepare. A prepare is used once.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

/** How long after its prepare a reset may go ahead. */
export const RESET_PREPARE_TTL_MS = 15 * 60_000;
/** Sessions a reset would cut short: the agent is working on the computer. */
const LIVE_SESSION: CodingSessionStatus[] = ['starting', 'running', 'waiting'];

const RESET_CHANNEL = 'openbots:computer:reset';

interface Prepared {
  ownerId: string;
  workspaceId: string;
  computerId: string;
  at: number;
  /** The live sessions the owner was shown, which a confirmed reset may stop. */
  sessionIds: string[];
}

interface PreparedMessage extends Prepared {
  requestId: string;
}

interface Rescued {
  results: RepoRescueResult[];
  error: string | null;
  at: number;
}

const prepared = new Map<string, Prepared>();
const rescued = new Map<string, Rescued>();
const listening = new WeakMap<EventBus, Promise<unknown>>();

/** For tests: forgets every prepared reset this process knows of. */
export function resetPreparedResets(): void {
  prepared.clear();
  rescued.clear();
}

function prune(now = Date.now()) {
  for (const [id, p] of prepared) if (now - p.at > RESET_PREPARE_TTL_MS) prepared.delete(id);
  for (const [id, r] of rescued) if (now - r.at > RESET_PREPARE_TTL_MS) rescued.delete(id);
}

function listen(deps: Pick<AppDeps, 'infra'>) {
  const bus = deps.infra.bus;
  let ready = listening.get(bus);
  if (!ready) {
    ready = Promise.all([
      bus.subscribe<PreparedMessage>(RESET_CHANNEL, (msg) => {
        if (typeof msg?.requestId !== 'string' || typeof msg.computerId !== 'string') return;
        const { requestId, ...record } = msg;
        if (!prepared.has(requestId)) prepared.set(requestId, record);
      }),
      // The rescue's own record lasts ten minutes from its end; a reset may
      // come up to fifteen after its prepare, so the results are kept here.
      bus.subscribe<RescueMessage>(RESCUE_CHANNEL, (msg) => {
        const results = RepoRescueResultSchema.array().safeParse(msg?.results);
        if (typeof msg?.requestId !== 'string' || !results.success) return;
        rescued.set(msg.requestId, {
          results: results.data,
          error: msg.error ?? null,
          at: Date.now(),
        });
      }),
    ]);
    listening.set(bus, ready);
  }
  return ready;
}

/** The owner's live coding sessions, for the warning before a reset. */
async function liveSessions(deps: Pick<AppDeps, 'db'>, owner: Owner) {
  return deps.db
    .select({
      id: schema.codingSessions.id,
      botId: schema.codingSessions.botId,
      agent: schema.codingSessions.agent,
      repoFullName: schema.codingSessions.repoFullName,
      branch: schema.codingSessions.branch,
      status: schema.codingSessions.status,
    })
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
        inArray(schema.codingSessions.status, LIVE_SESSION),
      ),
    );
}

async function computerOf(deps: AppDeps, owner: Owner): Promise<ComputerRow> {
  if (!computerAvailable(deps)) throw computerUnavailable('This install has no computer');
  const row = await getComputer(deps, owner);
  if (!row) throw notFound('The account has no computer yet');
  assertResettable(deps);
  return row;
}

/** `POST /computer/reset/prepare`: rescues every checkout first; read it with `resetStatus`. */
export async function prepareReset(deps: AppDeps, owner: Owner): Promise<{ requestId: string }> {
  const row = await computerOf(deps, owner);
  prune();
  await listen(deps);
  const sessionIds = (await liveSessions(deps, owner)).map((s) => s.id);
  const requestId = await startRescue(deps, owner, row.id);
  const record: Prepared = {
    ownerId: owner.id,
    workspaceId: owner.workspaceId,
    computerId: row.id,
    at: Date.now(),
    sessionIds,
  };
  prepared.set(requestId, record);
  await deps.infra.bus.publish<PreparedMessage>(RESET_CHANNEL, { requestId, ...record });
  return { requestId };
}

function preparedFor(owner: Owner, requestId: string): Prepared {
  prune();
  const record = prepared.get(requestId);
  if (!record || record.ownerId !== owner.id || record.workspaceId !== owner.workspaceId) {
    throw notFound('No such reset, or it was prepared more than fifteen minutes ago');
  }
  return record;
}

/** The rescue's results once it is done: from the bus, else this process's rescue record. */
function rescueOf(owner: Owner, requestId: string): Rescued | null {
  const known = rescued.get(requestId);
  if (known) return known;
  try {
    const status = rescueStatus(owner, requestId);
    return status.status === 'done' ? { results: status.results, error: null, at: 0 } : null;
  } catch {
    return null;
  }
}

/** `GET /computer/reset/{requestId}`: the rescue's progress, what it could not push, and the live sessions. */
export async function resetStatus(deps: AppDeps, owner: Owner, requestId: string) {
  await listen(deps);
  const record = preparedFor(owner, requestId);
  const done = rescueOf(owner, requestId);
  const sessions = await liveSessions(deps, owner);
  // Shown now, so a reset confirmed after this may stop them.
  record.sessionIds = [...new Set([...record.sessionIds, ...sessions.map((s) => s.id)])];
  const results = done?.results ?? [];
  return {
    status: done ? ('done' as const) : ('running' as const),
    results,
    unsaved: unsavedWork(results).map((r) => ({
      fullName: r.fullName,
      branch: r.branch,
      note: r.note,
    })),
    error: done?.error ?? null,
    runningSessions: sessions.map((s) => ({
      id: s.id,
      botId: s.botId,
      agent: s.agent,
      repoFullName: s.repoFullName,
      branch: s.branch,
      status: s.status as CodingSessionStatus,
    })),
    expiresAt: new Date(record.at + RESET_PREPARE_TTL_MS).toISOString(),
  };
}

const notPrepared = (message: string) => new DomainError(409, 'RESET_NOT_PREPARED', message);

export interface ResetOptions {
  requestId: string;
  /** Removes the cookie store and the coding agents' sign-ins too. */
  resetSignIns?: boolean;
}

/**
 * `POST /computer/reset`: refused (409 `RESET_NOT_PREPARED`) unless the
 * prepare is the owner's, for this computer, less than
 * `RESET_PREPARE_TTL_MS` old and its rescue done; refused (409
 * `CODING_SESSION_RUNNING`) while a coding session runs that the owner was
 * not shown. A rescue that failed outright does not block the reset: the
 * status said so, and a computer that will not start is when a reset helps.
 */
export async function resetComputer(
  deps: AppDeps,
  owner: Owner,
  { requestId, resetSignIns = false }: ResetOptions,
): Promise<ComputerRow> {
  const row = await computerOf(deps, owner);
  await listen(deps);
  prune();
  const record = prepared.get(requestId);
  if (
    !record ||
    record.ownerId !== owner.id ||
    record.workspaceId !== owner.workspaceId ||
    record.computerId !== row.id
  ) {
    throw notPrepared('Prepare the reset first, then confirm it within fifteen minutes');
  }
  const done = rescueOf(owner, requestId);
  if (!done) throw notPrepared('The rescue before the reset is still running');
  const shown = new Set(record.sessionIds);
  const unseen = (await liveSessions(deps, owner)).filter((s) => !shown.has(s.id));
  if (unseen.length) {
    throw new DomainError(
      409,
      'CODING_SESSION_RUNNING',
      'A coding session started after the reset was prepared; prepare it again',
    );
  }
  prepared.delete(requestId);
  const by = userActor(owner);
  const reset = await destroyComputer(deps, row, { signIns: resetSignIns }, by);
  await deps.db.transaction(async (tx) => {
    const checkouts = await tx
      .update(schema.repoCheckouts)
      .set({ state: 'missing', error: null, updatedAt: new Date() })
      .where(eq(schema.repoCheckouts.computerId, row.id))
      .returning({ id: schema.repoCheckouts.id });
    await tx
      .update(schema.codingSessions)
      .set({ worktreePath: null })
      .where(
        and(
          eq(schema.codingSessions.ownerId, owner.id),
          eq(schema.codingSessions.workspaceId, owner.workspaceId),
        ),
      );
    if (resetSignIns) {
      // Sign-ins the CLIs held on the state volume are gone; a Settings > Models key is not.
      await tx
        .update(schema.coderAccounts)
        .set({
          authKind: 'none',
          accountLabel: null,
          signedInAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.coderAccounts.ownerId, owner.id),
            eq(schema.coderAccounts.workspaceId, owner.workspaceId),
            isNull(schema.coderAccounts.providerId),
          ),
        );
    }
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor: by,
      action: 'computer.reset',
      targetType: 'computer',
      targetId: row.id,
      metadata: {
        requestId,
        signIns: resetSignIns,
        checkouts: checkouts.length,
        unsaved: unsavedWork(done.results).length,
        rescueFailed: !!done.error,
      },
    });
  });
  return reset;
}
