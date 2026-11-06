import { summarizeArgs, type PendingWait } from '@openbots/agent';
import { PRIORITY, wsEvent, type JobHandler, type MessagePart } from '@openbots/shared';
import { widgetToolResult, type ApprovalState } from '@openbots/widgets';
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { publishCoderControl } from './coder-control.js';
import { setApprovalStatus } from './coder-state.js';
import { actOnWidget, getRunForOwner, resumeRun, type RunRow } from './runs.js';

// Approvals (plan 4.3, 5.6, P1, T5). When the policy answers `ask`, the run
// posts an `approval` widget and pauses; this file keeps the `approvals` row
// beside it. The owner decides through the widget action route or
// `POST /approvals/:id/decide` (which calls the same widget path, so one
// reducer serves both); either way `markApproval` updates the row inside the
// widget's transaction and the decision is announced and audited. An
// unanswered request expires after OPENBOTS_APPROVAL_TTL_MINUTES (24 hours by
// default) and the run resumes denied.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ApprovalsDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export const APPROVALS_QUEUE = 'approvals';
/** Plan 5.6: how long a request waits, from `processLimits.approvalTtlMinutes` (24 hours by default). */
export const approvalTtlMs = (config: Pick<Config, 'processLimits'>) =>
  config.processLimits.approvalTtlMinutes * 60_000;

export type ApprovalRow = typeof schema.approvals.$inferSelect;
type ApprovalStatus = ApprovalRow['status'];

export interface ExpireJob {
  approvalId: string;
  /** Its organization, where it runs (infra/index.ts). */
  workspaceId?: string;
}

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

/** An `approvals` row as the API and the `approval.*` events carry it. */
export function toApproval(row: ApprovalRow, note?: string | null) {
  return {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    sessionId: row.sessionId,
    toolName: row.toolName,
    args: row.args,
    summary: summarizeArgs(row.toolName, row.args),
    reason: row.reason,
    status: row.status,
    note: note ?? null,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt)!,
  };
}

export type Approval = ReturnType<typeof toApproval>;

// Audit log (plan 17): every approval request and decision, and every tool
// call the policy refuses (services/policy.ts).

export interface AuditEntry {
  workspaceId: string;
  actorType: 'user' | 'bot' | 'system';
  actorId: string | null;
  action:
    | 'approval.requested'
    | 'approval.approved'
    | 'approval.denied'
    | 'approval.expired'
    | 'tool.denied';
  targetType: 'approval' | 'run';
  targetId: string;
  metadata: Record<string, unknown>;
}

export async function audit(db: Db, entry: AuditEntry) {
  await db.insert(schema.auditLog).values(entry);
}

/**
 * The run paused on an `ask`: the row and the audit entry, inside the
 * transaction that marks the run waiting, so a reader never sees a waiting
 * run without its approval. `announceApproval` follows the commit. It
 * expires `ttlMs` from now (`approvalTtlMs`).
 */
export async function storeApproval(
  tx: Db,
  run: RunRow,
  wait: PendingWait & { messageId: string },
  ttlMs: number,
): Promise<ApprovalRow> {
  const props = wait.widget.props as { reason?: string | null };
  const [row] = await tx
    .insert(schema.approvals)
    .values({
      workspaceId: run.workspaceId,
      runId: run.id,
      messageId: wait.messageId,
      toolName: wait.toolName,
      args: (wait.args ?? {}) as object,
      reason: props.reason ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning();
  await audit(tx, {
    workspaceId: run.workspaceId,
    actorType: 'bot',
    actorId: run.botId,
    action: 'approval.requested',
    targetType: 'approval',
    targetId: row!.id,
    metadata: { runId: run.id, toolName: wait.toolName, reason: props.reason ?? null },
  });
  return row!;
}

/** A stored approval request: `approval.requested` and the expiry job, due at `expiresAt`. */
export async function announceApproval(deps: ApprovalsDeps, row: ApprovalRow) {
  await publishApproval(deps, 'approval.requested', row);
  const delayMs = row.expiresAt
    ? Math.max(0, row.expiresAt.getTime() - Date.now())
    : approvalTtlMs(deps.config);
  await deps.infra
    .queue<ExpireJob>(APPROVALS_QUEUE)
    .enqueue(
      'expire',
      { approvalId: row.id, workspaceId: row.workspaceId },
      { delayMs, priority: PRIORITY.background },
    );
}

/**
 * The owner's decision on an approval widget, inside the widget action's
 * transaction (services/runs.ts). Returns null when no pending row matches,
 * which the caller turns into a refusal.
 */
export async function markApproval(
  tx: Db,
  messageId: string,
  state: ApprovalState,
  actorId: string | null,
): Promise<ApprovalRow | null> {
  const [row] = await tx
    .update(schema.approvals)
    .set({ status: state.status, decidedBy: actorId, decidedAt: new Date() })
    .where(and(eq(schema.approvals.messageId, messageId), eq(schema.approvals.status, 'pending')))
    .returning();
  return row ?? null;
}

/** Who decided a closed request and when, as the approval widget's state carries them. */
export function decision(row: Pick<ApprovalRow, 'decidedBy' | 'decidedAt'>) {
  return { decidedBy: row.decidedBy, decidedAt: row.decidedAt?.toISOString() ?? null };
}

/** After a decision is stored: `approval.resolved` and the audit entry. */
export async function announceDecision(
  deps: ApprovalsDeps,
  row: ApprovalRow,
  actor: { type: 'user' | 'system'; id: string | null },
  note?: string | null,
) {
  await audit(deps.db, {
    workspaceId: row.workspaceId,
    actorType: actor.type,
    actorId: actor.id,
    action: `approval.${row.status as Exclude<ApprovalStatus, 'pending'>}`,
    targetType: 'approval',
    targetId: row.id,
    metadata: { runId: row.runId, toolName: row.toolName, ...(note ? { note } : {}) },
  });
  await publishApproval(deps, 'approval.resolved', row, note);
}

async function publishApproval(
  deps: ApprovalsDeps,
  type: 'approval.requested' | 'approval.resolved',
  row: ApprovalRow,
  note?: string | null,
) {
  const scope = await approvalScope(deps.db, row);
  const [message] = row.messageId
    ? await deps.db
        .select({ seq: schema.messages.seq, threadRootId: schema.messages.threadRootId })
        .from(schema.messages)
        .where(eq(schema.messages.id, row.messageId))
    : [];
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      type,
      {
        approval: toApproval(row, note),
        ...(message?.threadRootId ? { threadRootId: message.threadRootId } : {}),
      },
      { ...scope, ...(message ? { seq: message.seq } : {}) },
    ),
  );
}

/**
 * Where an approval's events go: its run's Bot and chat, or, on the owner's
 * own turn with no run, the session's Bot and chat and its owner, so every
 * socket of the owner hears it.
 */
async function approvalScope(
  db: Db,
  row: ApprovalRow,
): Promise<{ bot_id?: string; chat_id?: string; user_id?: string; workspace_id?: string }> {
  if (row.runId) {
    const [run] = await db
      .select({ botId: schema.runs.botId, chatId: schema.runs.chatId })
      .from(schema.runs)
      .where(eq(schema.runs.id, row.runId));
    return run ? { bot_id: run.botId, ...(run.chatId ? { chat_id: run.chatId } : {}) } : {};
  }
  if (!row.sessionId) return {};
  const [session] = await db
    .select({
      botId: schema.codingSessions.botId,
      chatId: schema.codingSessions.chatId,
      ownerId: schema.codingSessions.ownerId,
      workspaceId: schema.codingSessions.workspaceId,
    })
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, row.sessionId));
  if (!session) return {};
  return {
    bot_id: session.botId,
    ...(session.chatId ? { chat_id: session.chatId } : {}),
    user_id: session.ownerId,
    workspace_id: session.workspaceId,
  };
}

export const approvalClosed = (status: ApprovalStatus | 'closed') =>
  new DomainError(409, 'APPROVAL_CLOSED', `This request was already ${status}`);

/** `POST /approvals/:id/decide` for the owner: the widget action path, by approval id. */
export async function decideApproval(
  deps: ApprovalsDeps,
  owner: Owner,
  approvalId: string,
  input: { decision: 'approve' | 'deny'; note?: string | undefined },
): Promise<{ approval: Approval; resumedRunId: string | null }> {
  const row = await getApprovalForOwner(deps.db, owner, approvalId);
  if (row.status !== 'pending') throw approvalClosed(row.status);
  if (row.sessionId) return decideSessionApproval(deps, owner, row, input);
  const partIndex = row.messageId ? await approvalPartIndex(deps.db, row.messageId) : null;
  if (!row.messageId || partIndex === null) throw approvalClosed(row.status);
  const result = await actOnWidget(deps, owner, row.messageId, partIndex, {
    type: input.decision,
    ...(input.note ? { note: input.note } : {}),
  });
  const [after] = await deps.db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId));
  const note = (result.widget.state as ApprovalState).note ?? null;
  return { approval: toApproval(after!, note), resumedRunId: result.resumedRunId };
}

// A coding session's request (I13) has no approval widget and no paused
// run: the session's job waits on the agent's prompt. The decision goes to
// it over openbots:coder-control, and a push or PR approval also arms the
// session's push credential.

async function decideSessionApproval(
  deps: ApprovalsDeps,
  owner: Owner,
  row: ApprovalRow,
  input: { decision: 'approve' | 'deny'; note?: string | undefined },
): Promise<{ approval: Approval; resumedRunId: string | null }> {
  const status = input.decision === 'approve' ? 'approved' : 'denied';
  const [decided] = await deps.db
    .update(schema.approvals)
    .set({ status, decidedBy: owner.id, decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.status, 'pending')))
    .returning();
  if (!decided) throw approvalClosed('closed');
  await answerSession(deps, decided, status);
  await announceDecision(deps, decided, { type: 'user', id: owner.id }, input.note);
  return { approval: toApproval(decided, input.note), resumedRunId: null };
}

/** Tells the session's job the decision, and shows it on the session's widget. */
async function answerSession(
  deps: ApprovalsDeps,
  row: ApprovalRow,
  status: 'approved' | 'denied' | 'expired',
) {
  if (!row.sessionId) return;
  const sessionId = row.sessionId;
  const decision = status === 'approved' ? 'approved' : 'denied';
  if (decision === 'approved' && (row.actionClass === 'push' || row.actionClass === 'pr')) {
    await publishCoderControl(deps, { type: 'push_allowed', sessionId });
  }
  await publishCoderControl(deps, { type: 'approval', sessionId, approvalId: row.id, decision });
  // The job updates the widget too; this covers a job that is gone.
  await setApprovalStatus(deps, sessionId, row.id, status).catch((error: unknown) =>
    deps.logger.warn({ err: error, sessionId }, 'session approval not shown'),
  );
}

export async function getApprovalForOwner(
  db: Db,
  owner: Owner,
  approvalId: string,
): Promise<ApprovalRow> {
  const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  if (!row) throw notFound('Approval not found');
  if (row.runId) {
    await getRunForOwner(db, owner, row.runId).catch(() => {
      throw notFound('Approval not found');
    });
    return row;
  }
  const [session] = row.sessionId
    ? await db
        .select({
          ownerId: schema.codingSessions.ownerId,
          workspaceId: schema.codingSessions.workspaceId,
        })
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, row.sessionId))
    : [];
  if (session?.ownerId !== owner.id || session.workspaceId !== owner.workspaceId) {
    throw notFound('Approval not found');
  }
  return row;
}

/**
 * The owner's pending requests, oldest first, with where each one sits: its
 * run's Bot and chat (or its session's, on the owner's own turn) and the
 * widget message's seq (the Mac app's tray).
 */
export async function listPendingApprovals(db: Db, owner: Owner) {
  const rows = await db
    .select({
      approval: schema.approvals,
      botId: schema.bots.id,
      chatId: sql<string | null>`coalesce(${schema.runs.chatId}, ${schema.codingSessions.chatId})`,
      seq: schema.messages.seq,
    })
    .from(schema.approvals)
    .leftJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
    .leftJoin(schema.codingSessions, eq(schema.codingSessions.id, schema.approvals.sessionId))
    .innerJoin(
      schema.bots,
      eq(schema.bots.id, sql`coalesce(${schema.runs.botId}, ${schema.codingSessions.botId})`),
    )
    .leftJoin(schema.messages, eq(schema.messages.id, schema.approvals.messageId))
    .where(
      and(
        eq(schema.approvals.status, 'pending'),
        eq(schema.bots.workspaceId, owner.workspaceId),
        or(
          and(isNotNull(schema.approvals.runId), eq(schema.bots.ownerId, owner.id)),
          and(isNull(schema.approvals.runId), eq(schema.codingSessions.ownerId, owner.id)),
        ),
      ),
    )
    .orderBy(asc(schema.approvals.createdAt));
  return rows.map((row) => ({
    ...toApproval(row.approval),
    botId: row.botId,
    chatId: row.chatId,
    seq: row.seq,
  }));
}

/** Where the approval widget sits in its message. */
async function approvalPartIndex(db: Db, messageId: string): Promise<number | null> {
  const [message] = await db
    .select({ parts: schema.messages.parts })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  const parts = (message?.parts ?? []) as MessagePart[];
  const index = parts.findLastIndex((p) => p.type === 'widget' && p.kind === 'approval');
  return index < 0 ? null : index;
}

/**
 * Closes a pending request without the owner's click (expiry, or the run was
 * cancelled): the row, the widget state and the events, in the widget's lock
 * so a racing decision either lands first or is refused. Returns the run that
 * was waiting on it, or null when the request was no longer pending.
 */
async function closeApproval(
  deps: ApprovalsDeps,
  row: ApprovalRow,
  state: ApprovalState & { status: 'expired' | 'denied' },
): Promise<{ closed: ApprovalRow; pendingRunId: string | null } | null> {
  const partIndex = row.messageId ? await approvalPartIndex(deps.db, row.messageId) : null;
  const done = await deps.db.transaction(async (tx) => {
    const current =
      row.messageId && partIndex !== null
        ? (
            await tx
              .select()
              .from(schema.widgetStates)
              .where(
                and(
                  eq(schema.widgetStates.messageId, row.messageId),
                  eq(schema.widgetStates.partIndex, partIndex),
                ),
              )
              .for('update')
          )[0]
        : undefined;
    const [closed] = await tx
      .update(schema.approvals)
      .set({ status: state.status, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.status, 'pending')))
      .returning();
    if (!closed) return null;
    if (current) {
      await tx
        .update(schema.widgetStates)
        .set({
          state: { ...state, ...decision(closed) },
          pendingRunId: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.widgetStates.id, current.id));
    }
    return { closed, pendingRunId: current?.pendingRunId ?? null, partIndex };
  });
  if (!done) return null;
  if (row.messageId && done.partIndex !== null) {
    const [message] = await deps.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row.messageId));
    if (message) {
      await publishEvent(
        deps.infra.bus,
        wsEvent(
          'widget.updated',
          {
            widget: {
              messageId: message.id,
              partIndex: done.partIndex,
              state: { ...state, ...decision(done.closed) },
              pendingRunId: null,
            },
          },
          {
            chat_id: message.chatId,
            seq: message.seq,
            ...(message.authorId ? { bot_id: message.authorId } : {}),
          },
        ),
      );
    }
  }
  await announceDecision(deps, done.closed, { type: 'system', id: null }, state.note);
  // A session's request expired or its run was cancelled: the agent hears no.
  if (done.closed.sessionId) await answerSession(deps, done.closed, state.status);
  return { closed: done.closed, pendingRunId: done.pendingRunId };
}

/**
 * Expires one request once its time is up and resumes its run with a denial.
 * Returns whether it expired anything.
 */
export async function expireApproval(
  deps: ApprovalsDeps,
  approvalId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await deps.db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, approvalId));
  if (row?.status !== 'pending' || !row.expiresAt || row.expiresAt > now) return false;
  const state: ApprovalState & { status: 'expired' } = { status: 'expired' };
  const result = await closeApproval(deps, row, state);
  if (!result) return false;
  if (result.pendingRunId) {
    await resumeRun(deps, result.pendingRunId, widgetToolResult('approval', state)).catch(
      (error: unknown) => {
        deps.logger.info({ err: error, approvalId }, 'expired approval not resumed');
      },
    );
  }
  return true;
}

/** Every pending request past its time; at worker start, for jobs an in-memory queue lost. */
export async function expireDueApprovals(deps: ApprovalsDeps, now = new Date()) {
  const due = await deps.db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.status, 'pending'), lte(schema.approvals.expiresAt, now)));
  let expired = 0;
  for (const { id } of due) if (await expireApproval(deps, id, now)) expired++;
  return expired;
}

/** A waiting run was cancelled: its pending requests close as denied. */
export async function closeApprovalsForRun(deps: ApprovalsDeps, runId: string) {
  const pending = await deps.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.status, 'pending')));
  for (const row of pending) {
    await closeApproval(deps, row, { status: 'denied', note: 'The run was cancelled' });
  }
}

/**
 * A coding session ended (it settled, failed, stopped or hit its time
 * limit): its requests still pending expire, with the events and the audit
 * entry, so the owner's tray drops them. Returns how many it expired.
 */
export async function expireSessionApprovals(
  deps: ApprovalsDeps,
  sessionId: string,
): Promise<number> {
  const pending = await deps.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.sessionId, sessionId), eq(schema.approvals.status, 'pending')));
  let expired = 0;
  for (const row of pending) {
    const closed = await closeApproval(deps, row, {
      status: 'expired',
      note: 'The coding session ended',
    });
    if (closed) expired++;
  }
  return expired;
}

/** The `approvals` queue handler: one delayed `expire` job per request. */
export function expiryHandler(deps: AppDeps): JobHandler<ExpireJob> {
  return async (job) => {
    await expireApproval(deps, job.data.approvalId);
  };
}
