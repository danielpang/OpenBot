import type { RunCheckpoint, SerializedRunState } from '@openbots/agent';
import { isForBot } from '@openbots/router';
import { PRIORITY, wsEvent, type MessagePart } from '@openbots/shared';
import {
  reduceWidget,
  validateWidgetAction,
  widgetToolCall,
  widgetToolResult,
  type ApprovalState,
  type FormState,
} from '@openbots/widgets';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { observeRun } from '../metrics.js';
import { assertBotOwner } from '../ownership.js';
import type { Message } from '../schemas.js';
import {
  announceDecision,
  approvalClosed,
  closeApprovalsForRun,
  decision,
  markApproval,
  type ApprovalRow,
} from './approvals.js';
import { setState } from './bot-state.js';
import { threadBotId } from './chats.js';
import { onUserMessage, runRunStatusHooks, widgetActionHook } from './hooks.js';
import { routeMessage, type RouterOptions } from './router.js';

// Runs (plan 4.3, 5.1, 5.2, 5.6, 5.7). A run is one unit of Bot work in one
// chat, executed by the `runs` queue's worker (workers/runs.ts). Jobs are
// grouped by Bot, so a Bot runs one job at a time and its queued runs start
// by priority, then age.
//
// Status: queued -> running -> completed | failed | cancelled | waiting;
// waiting -> queued (resume) | cancelled. The worker owns the transitions out
// of `running`; every update is conditional on the status it expects, so a
// cancel racing a finish settles on whichever lands first.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type RunsDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export const RUNS_QUEUE = 'runs';
/** Bus channel for run control (cancel) from the API to whichever worker runs it. */
export const RUN_CONTROL_CHANNEL = 'openbots:run-control';

export type RunRow = typeof schema.runs.$inferSelect;
export type RunStepRow = typeof schema.runSteps.$inferSelect;
export type RunTrigger = (typeof schema.runTrigger.enumValues)[number];
export type RunStatus = (typeof schema.runStatus.enumValues)[number];

/** Plan 5.1: the owner waiting comes first, Routines last. */
export const TRIGGER_PRIORITY: Record<RunTrigger, number> = {
  message: PRIORITY.interactive,
  mention: PRIORITY.interactive,
  widget_action: PRIORITY.interactive,
  resume: PRIORITY.interactive,
  bot_message: PRIORITY.normal,
  bot_dm: PRIORITY.normal,
  webhook: PRIORITY.normal,
  routine: PRIORITY.background,
};

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running'];
export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled'];

export interface RunJob {
  runId: string;
  /** Its organization, where it runs (infra/index.ts). */
  workspaceId?: string;
}

export interface RunControl {
  type: 'cancel';
  runId: string;
}

/** What a queued run starts from besides the transcript, e.g. the widget action that started it. */
export interface RunInput {
  widgetAction?: { messageId: string; partIndex: number; kind: string; action: unknown };
  /**
   * A tool call the run makes before the model's first step, through the
   * policy (`WidgetKind.toolCall`: Send on an email draft calls `send_email`).
   */
  toolCall?: { toolName: string; args: unknown };
  /**
   * The thread the run answers in (C7): its context is the root and every
   * reply plus the chat summary, and its reply goes into the thread.
   */
  threadRootId?: string;
  /** The Routine run this run is (plan 10.2): its prompt joins the context. */
  routine?: { routineId: string; routineRunId: string };
  /**
   * The webhook delivery that started it (plan 11): its endpoint's
   * `tool_policy_override` applies to the run.
   */
  webhook?: { endpointId: string; deliveryId: string };
  /**
   * The Bot whose message started the run (a Bot to Bot message or a Bot's
   * @mention): its content is data (P2), so the run gets the stricter rules
   * for runs other Bots start, whatever its trigger.
   */
  fromBotId?: string;
}

/**
 * `runs.state`: the start input while queued, the serialized loop while
 * waiting, and the loop's checkpoint while running (K4).
 */
export type RunState = {
  input?: RunInput;
  /** The loop as of its last step, so a worker can take over a crashed run. */
  checkpoint?: RunCheckpoint;
  /** How many times a worker took the run over after a crash; owns the checkpoint. */
  takeovers?: number;
} & Partial<SerializedRunState>;

/** The thread a run answers in; null for the chat's top level. */
export function runThread(run: Pick<RunRow, 'state'>): string | null {
  return (run.state as RunState | null)?.input?.threadRootId ?? null;
}

const threadInput = (threadRootId: string | null | undefined): Pick<EnqueueRunInput, 'input'> =>
  threadRootId ? { input: { threadRootId } } : {};

export interface EnqueueRunInput {
  botId: string;
  chatId: string | null;
  trigger: RunTrigger;
  /** Defaults to the trigger's priority (plan 5.1). */
  priority?: number;
  parentRunId?: string | null;
  depth?: number;
  input?: RunInput;
}

/** Creates the `runs` row and its queue job (groupKey = Bot). */
export async function enqueueRun(deps: RunsDeps, input: EnqueueRunInput): Promise<RunRow> {
  const row = await insertRun(deps.db, input);
  await scheduleRun(deps, row, 'run');
  return row;
}

/** The `runs` row alone, e.g. inside a caller's transaction; `scheduleRun` queues it after commit. */
export async function insertRun(db: Db, input: EnqueueRunInput): Promise<RunRow> {
  const [bot] = await db
    .select({ workspaceId: schema.bots.workspaceId })
    .from(schema.bots)
    .where(eq(schema.bots.id, input.botId));
  if (!bot) throw notFound('Bot not found');
  const [row] = await db
    .insert(schema.runs)
    .values({
      workspaceId: bot.workspaceId,
      botId: input.botId,
      chatId: input.chatId,
      trigger: input.trigger,
      priority: input.priority ?? TRIGGER_PRIORITY[input.trigger],
      parentRunId: input.parentRunId ?? null,
      depth: input.depth ?? 0,
      state: input.input ? ({ input: input.input } satisfies RunState) : null,
    })
    .returning();
  return row!;
}

export async function scheduleRun(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  row: RunRow,
  name: 'run' | 'resume',
) {
  await deps.infra
    .queue<RunJob>(RUNS_QUEUE)
    .enqueue(
      name,
      { runId: row.id, workspaceId: row.workspaceId },
      { priority: row.priority, groupKey: row.botId },
    );
  await publishRunStatus(deps, row);
}

export async function publishRunStatus(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  row: RunRow,
) {
  // An ended run names its last message, so a "finished" notification (N1)
  // opens it, in its thread when it is in one.
  const [last] = TERMINAL_STATUSES.includes(row.status)
    ? await deps.db
        .select({
          id: schema.messages.id,
          seq: schema.messages.seq,
          threadRootId: schema.messages.threadRootId,
        })
        .from(schema.messages)
        .where(eq(schema.messages.runId, row.id))
        .orderBy(desc(schema.messages.seq))
        .limit(1)
    : [];
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'run.status',
      {
        runId: row.id,
        status: row.status,
        error: row.error,
        trigger: row.trigger,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        ...(last ? { messageId: last.id, threadRootId: last.threadRootId ?? runThread(row) } : {}),
      },
      {
        bot_id: row.botId,
        ...(row.chatId ? { chat_id: row.chatId } : {}),
        ...(last ? { seq: last.seq } : {}),
      },
    ),
  );
  observeRun(row);
  // Routine run records follow their run (plan 10.2).
  await runRunStatusHooks(deps, row);
}

/** Serializes "is a run active here?" against "start one" for a Bot. */
async function lockBot(db: Db, botId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`runs:${botId}`}))`);
}

export type UserMessageOutcome =
  | { kind: 'enqueued'; runId: string }
  | { kind: 'attached'; runId: string }
  | { kind: 'steered'; runId: string }
  | { kind: 'answered'; runId: string }
  | { kind: 'ignored' };

/**
 * An owner message in a Bot's transcript (plan 5.1, 5.2): it goes to the Bot
 * as `takeOwnerMessage` says. Group and Bot-to-Bot chats go through the
 * router (router.ts), which hands an owner message to each Bot it is for the
 * same way.
 */
export async function handleUserMessage(
  deps: RunsDeps,
  message: Message,
): Promise<UserMessageOutcome> {
  if (message.authorType !== 'user') return { kind: 'ignored' };
  const [chat] = await deps.db
    .select()
    .from(schema.chats)
    .where(eq(schema.chats.id, message.chatId));
  if (chat?.type !== 'bot_dm' || !chat.botId) return { kind: 'ignored' };
  return takeOwnerMessage(deps, message, {
    botId: chat.botId,
    chatId: chat.id,
    trigger: 'message',
    ...threadInput(message.threadRootId),
  });
}

/**
 * Where an owner message for one Bot goes (plan 5.1, 5.2, 5.6, C7). A reply
 * in the thread of the Bot's pending approval request or question starts
 * nothing: the run reads the thread when it resumes. Otherwise only a run in
 * the message's thread (or at the top level, for a top-level message) takes
 * it, keeping the Bot's attention on that item: a queued or running one is
 * steered (the transcript is the steering inbox, and the loop picks up owner
 * messages past its watermark at the next step), and one waiting on a
 * question takes the text as the answer. With neither, `start` is queued.
 */
async function takeOwnerMessage(
  deps: RunsDeps,
  message: Message,
  start: EnqueueRunInput & { chatId: string },
): Promise<Exclude<UserMessageOutcome, { kind: 'ignored' }>> {
  const { botId, chatId } = start;
  const decided = await deps.db.transaction(async (tx) => {
    await lockBot(tx, botId);
    const open = await tx
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.botId, botId),
          eq(schema.runs.chatId, chatId),
          inArray(schema.runs.status, ['queued', 'running', 'waiting']),
        ),
      )
      .orderBy(desc(schema.runs.createdAt));
    const thread = message.threadRootId ?? null;
    if (thread) {
      const asked = open.find((r) => (r.state as RunState | null)?.pending?.messageId === thread);
      if (asked?.status === 'waiting') return { kind: 'attached' as const, run: asked };
    }
    // Only a run in the same thread (or both at the top level) takes the message.
    const here = open.filter((r) => runThread(r) === thread);
    const active = here.find((r) => ACTIVE_STATUSES.includes(r.status));
    if (active) return { kind: 'steered' as const, run: active };
    const waiting = here.find((r) => (r.state as RunState | null)?.pending?.reason === 'question');
    if (waiting) return { kind: 'waiting' as const, run: waiting };
    return { kind: 'enqueued' as const, run: await insertRun(tx, start) };
  });

  if (decided.kind === 'steered') return { kind: 'steered', runId: decided.run.id };
  if (decided.kind === 'attached') return { kind: 'attached', runId: decided.run.id };
  if (decided.kind === 'enqueued') {
    await scheduleRun(deps, decided.run, 'run');
    return { kind: 'enqueued', runId: decided.run.id };
  }
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  const pending = (decided.run.state as RunState).pending!;
  if (text && pending.messageId !== undefined && pending.partIndex !== undefined) {
    const answered = await applyWidgetAction(deps, pending.messageId, pending.partIndex, {
      type: 'answer',
      text,
    }).catch(() => null);
    if (answered?.resumedRunId) return { kind: 'answered', runId: answered.resumedRunId };
  }
  const run = await enqueueRun(deps, start);
  return { kind: 'enqueued', runId: run.id };
}

/**
 * Registers the runtime's `onUserMessage` hook; call once per process
 * (main.ts). A Bot's transcript is handled here; group chats are routed
 * (plan 7).
 */
export function registerRunHooks(router: RouterOptions = {}): () => void {
  return onUserMessage(async (deps, message) => {
    const outcome = await handleUserMessage(deps, message);
    if (outcome.kind === 'ignored') await routeMessage(deps, message, router);
  });
}

export type RoutedRunOutcome = {
  kind: Exclude<UserMessageOutcome['kind'], 'ignored'>;
  runId: string;
};

/**
 * A run the router asked for (plan 7). An owner's message goes to the Bot as
 * in its transcript (`takeOwnerMessage`): it steers the Bot's run in the same
 * thread (or top level), answers its question, or attaches to its pending
 * request when it is a reply in that request's thread (C7). A Bot's message
 * always starts a run.
 */
export async function startRoutedRun(
  deps: RunsDeps,
  input: EnqueueRunInput & { chatId: string },
  { ownerMessage }: { ownerMessage: Message | null },
): Promise<RoutedRunOutcome> {
  if (ownerMessage) return takeOwnerMessage(deps, ownerMessage, input);
  const run = await enqueueRun(deps, input);
  return { kind: 'enqueued', runId: run.id };
}

/**
 * Bots with a run in the chat's thread (or top level) that an owner message
 * there would reach without the router asking (plan 5.2): one queued or
 * running, or one waiting on a question.
 */
export async function botsAtWork(db: Db, chatId: string, thread: string | null) {
  const open = await db
    .select({ botId: schema.runs.botId, status: schema.runs.status, state: schema.runs.state })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.chatId, chatId),
        inArray(schema.runs.status, ['queued', 'running', 'waiting']),
      ),
    );
  return open
    .filter(
      (r) =>
        runThread(r) === thread &&
        (ACTIVE_STATUSES.includes(r.status) ||
          (r.state as RunState | null)?.pending?.reason === 'question'),
    )
    .map((r) => r.botId);
}

/**
 * An owner message in a group ends the handoffs still queued from earlier Bot
 * chains in its thread (or at the top level): runs a Bot's message started
 * (they have a parent run) that no worker has picked up yet. Work queued
 * before the owner moved on would otherwise run after their newer message.
 * A Bot already running is left to its steering, which takes the message.
 * The update only touches runs still queued, so a worker that claims one
 * first keeps it. Returns the dropped runs.
 */
export async function dropQueuedHandoffs(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  chatId: string,
  thread: string | null,
): Promise<RunRow[]> {
  // The run's thread, as `runThread` reads it.
  const runThreadSql = sql`${schema.runs.state} -> 'input' ->> 'threadRootId'`;
  const dropped = await deps.db
    .update(schema.runs)
    .set({
      status: 'cancelled',
      error: 'Dropped: the owner sent a newer message',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(schema.runs.chatId, chatId),
        eq(schema.runs.status, 'queued'),
        isNotNull(schema.runs.parentRunId),
        // Never started: a run resumed after an approval or answer is queued again, but keeps it.
        isNull(schema.runs.startedAt),
        thread ? sql`${runThreadSql} = ${thread}` : sql`${runThreadSql} is null`,
      ),
    )
    .returning();
  await Promise.all(dropped.map((row) => publishRunStatus(deps, row)));
  return dropped;
}

/** Moves a waiting run back to the queue with the answer for its pending tool call (plan 5.6). */
export async function resumeRun(deps: RunsDeps, runId: string, output: unknown): Promise<RunRow> {
  const [current] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  const state = current?.state as RunState | null;
  if (current?.status !== 'waiting' || !state?.pending) throw runNotWaiting();
  const [row] = await deps.db
    .update(schema.runs)
    .set({
      status: 'queued',
      priority: TRIGGER_PRIORITY.resume,
      state: { ...state, resume: { output } } satisfies RunState,
    })
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'waiting')))
    .returning();
  if (!row) throw runNotWaiting();
  await scheduleRun(deps, row, 'resume');
  return row;
}

const runNotWaiting = () => new DomainError(409, 'RUN_NOT_WAITING', 'The run is not waiting');

// Widget actions (plan 12.2, W2)

export type WidgetStateView = {
  messageId: string;
  partIndex: number;
  state: unknown;
  pendingRunId: string | null;
};

export interface WidgetActionResult {
  widget: WidgetStateView;
  /** The waiting run the action resumed, if any. */
  resumedRunId: string | null;
  /** The `widget_action` run the action started, if no run was waiting on it. */
  startedRunId: string | null;
}

export const invalidAction = (message: string) =>
  new DomainError(400, 'INVALID_WIDGET_ACTION', message);
/** Widget kinds whose actions are settled by the server and start no run. */
const SETTLED_KINDS = new Set(['approval', 'skill_draft', 'login_request']);

export const widgetClosed = (message: string) => new DomainError(409, 'WIDGET_CLOSED', message);

/** `POST /messages/:id/widgets/:part/action` for the owner. */
export async function actOnWidget(
  deps: RunsDeps,
  owner: Owner,
  messageId: string,
  partIndex: number,
  action: unknown,
): Promise<WidgetActionResult> {
  const [row] = await deps.db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.chats.id, schema.messages.chatId))
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.chats.ownerId, owner.id),
        eq(schema.chats.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Message not found');
  return applyWidgetAction(deps, messageId, partIndex, action, owner.id);
}

async function applyWidgetAction(
  deps: RunsDeps,
  messageId: string,
  partIndex: number,
  action: unknown,
  actorId: string | null = null,
): Promise<WidgetActionResult> {
  const [message] = await deps.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  const part = (message?.parts as MessagePart[] | undefined)?.[partIndex];
  if (!message || part?.type !== 'widget') throw notFound('Widget not found');
  const checked = validateWidgetAction(part.kind, action);
  if (!checked.ok) throw invalidAction(checked.error);

  const updated = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.widgetStates)
      .where(
        and(
          eq(schema.widgetStates.messageId, messageId),
          eq(schema.widgetStates.partIndex, partIndex),
        ),
      )
      .for('update');
    const next = reduceWidget(part.kind, current?.state ?? part.state, checked.value, part.props);
    if (!next.ok) throw next.invalid ? invalidAction(next.error) : widgetClosed(next.error);
    let nextState = next.value;
    // A kind with a server-side effect (a Routine proposal's Confirm) applies it here.
    const effect = await widgetActionHook(part.kind)?.(deps, tx, {
      message,
      partIndex,
      props: part.props,
      state: nextState,
      action: checked.value,
    });
    if (effect && effect.state !== undefined) nextState = effect.state;
    // An approval widget is backed by its `approvals` row (P1); both move together.
    let approval: ApprovalRow | null = null;
    if (part.kind === 'approval') {
      approval = await markApproval(tx, messageId, nextState as ApprovalState, actorId);
      if (!approval) throw approvalClosed('closed');
      // Who decided and when stay with the widget, so a reload still says so.
      nextState = { ...(nextState as ApprovalState), ...decision(approval) };
    }
    const values = {
      workspaceId: message.workspaceId,
      messageId,
      partIndex,
      state: nextState as object,
      pendingRunId: null,
      updatedAt: new Date(),
    };
    await tx
      .insert(schema.widgetStates)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
        set: { state: values.state, pendingRunId: null, updatedAt: values.updatedAt },
      });
    return {
      state: nextState,
      pendingRunId: current?.pendingRunId ?? null,
      approval,
      after: effect ? effect.after : undefined,
    };
  });

  const widget: WidgetStateView = {
    messageId,
    partIndex,
    state: updated.state,
    pendingRunId: null,
  };
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'widget.updated',
      { widget },
      {
        chat_id: message.chatId,
        seq: message.seq,
        ...(message.authorType === 'bot' && message.authorId ? { bot_id: message.authorId } : {}),
      },
    ),
  );

  await updated.after?.();

  if (updated.approval) {
    const note = (updated.state as ApprovalState).note ?? null;
    await announceDecision(deps, updated.approval, { type: 'user', id: actorId }, note);
  }

  if (updated.pendingRunId) {
    const resumed = await resumeRun(
      deps,
      updated.pendingRunId,
      widgetToolResult(part.kind, updated.state),
    ).catch((error: unknown) => {
      // The run was cancelled or already resumed; the answer is still stored.
      deps.logger.info({ err: error, runId: updated.pendingRunId }, 'widget answer not resumed');
      return null;
    });
    if (resumed) return { widget, resumedRunId: resumed.id, startedRunId: null };
  }
  // A decision on a request no run waits for any more (cancelled) starts
  // nothing, and a Skill draft is settled by its hook (services/skills.ts).
  if (message.authorType === 'bot' && message.authorId && !SETTLED_KINDS.has(part.kind)) {
    const toolCall = widgetToolCall(part.kind, updated.state, part.props);
    // A form's run is told the values as the reducer checked them, not as posted.
    const told =
      part.kind === 'form'
        ? { ...(checked.value as object), values: (updated.state as FormState).values }
        : checked.value;
    const run = await enqueueRun(deps, {
      botId: message.authorId,
      chatId: message.chatId,
      trigger: 'widget_action',
      input: {
        widgetAction: { messageId, partIndex, kind: part.kind, action: told },
        ...(toolCall ? { toolCall } : {}),
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
      },
    });
    return { widget, resumedRunId: null, startedRunId: run.id };
  }
  return { widget, resumedRunId: null, startedRunId: null };
}

// Reading and cancelling

/** A `run_steps` row as the API and the `run.step` event carry it. */
export function toRunStep(row: typeof schema.runSteps.$inferSelect) {
  return {
    id: row.id,
    runId: row.runId,
    idx: row.idx,
    type: row.type,
    label: row.label,
    payload: row.payload,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getRunForOwner(db: Db, owner: Owner, runId: string): Promise<RunRow> {
  const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!row) throw notFound('Run not found');
  await assertBotOwner(db, owner, row.botId).catch(() => {
    throw notFound('Run not found');
  });
  return row;
}

export async function listRunSteps(db: Db, owner: Owner, runId: string): Promise<RunStepRow[]> {
  await getRunForOwner(db, owner, runId);
  return db
    .select()
    .from(schema.runSteps)
    .where(eq(schema.runSteps.runId, runId))
    .orderBy(asc(schema.runSteps.idx));
}

/**
 * Cancel (plan 5.7). A queued run is skipped when its job comes up; a running
 * one is aborted by its worker, which hears about it on the control channel
 * and also checks the status between steps; a waiting one is closed here.
 */
export async function cancelRun(deps: RunsDeps, owner: Owner, runId: string): Promise<RunRow> {
  const before = await getRunForOwner(deps.db, owner, runId);
  if (TERMINAL_STATUSES.includes(before.status)) return before;
  const [row] = await deps.db
    .update(schema.runs)
    .set({ status: 'cancelled', error: 'Cancelled by the owner', finishedAt: new Date() })
    .where(
      and(eq(schema.runs.id, runId), inArray(schema.runs.status, ['queued', 'running', 'waiting'])),
    )
    .returning();
  if (!row) return getRunForOwner(deps.db, owner, runId);
  if (before.status === 'running') {
    await deps.infra.bus.publish<RunControl>(RUN_CONTROL_CHANNEL, { type: 'cancel', runId });
  }
  if (before.status === 'waiting') {
    await deps.db
      .update(schema.widgetStates)
      .set({ pendingRunId: null })
      .where(eq(schema.widgetStates.pendingRunId, runId));
    await closeApprovalsForRun(deps, runId);
    await settleBotIfRun(deps, row.botId, runId, 'idle');
  }
  await publishRunStatus(deps, row);
  return row;
}

/** Sets the Bot's state only if the roster still shows this run. */
export async function settleBotIfRun(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  botId: string,
  runId: string,
  state: 'idle' | 'blocked',
) {
  const [current] = await deps.db
    .select({ runId: schema.botState.runId })
    .from(schema.botState)
    .where(eq(schema.botState.botId, botId));
  if (current?.runId === runId) await setState(deps, botId, state, { runId });
}

/**
 * Marks a running run completed and, under the Bot's lock, starts a follow-up
 * `message` run when owner messages arrived after the loop's last steering
 * check: the hook saw this run as active and left them to it. In a group only
 * messages for the Bot count (`isForBot`, as steering takes them); the rest
 * were not its to answer. Only messages in the run's thread (or at the top
 * level, for a top-level run) count, and the follow-up answers there too.
 */
export async function completeRun(
  deps: RunsDeps,
  runId: string,
  patch: Partial<Pick<RunRow, 'usage' | 'model'>>,
  seenSeq: number,
): Promise<{ run: RunRow | null; followUp: RunRow | null }> {
  const done = await deps.db.transaction(async (tx) => {
    const [before] = await tx
      .select({ state: schema.runs.state })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const thread = before ? runThread(before) : null;
    const [row] = await tx
      .update(schema.runs)
      .set({ ...patch, status: 'completed', state: null, finishedAt: new Date() })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'running')))
      .returning();
    if (!row?.chatId) return { run: row ?? null, followUp: null };
    await lockBot(tx, row.botId);
    const [chat] = await tx.select().from(schema.chats).where(eq(schema.chats.id, row.chatId));
    const late = await tx
      .select({
        mentions: schema.messages.mentions,
        mentionEveryone: schema.messages.mentionEveryone,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.chatId, row.chatId),
          eq(schema.messages.authorType, 'user'),
          thread ? eq(schema.messages.threadRootId, thread) : isNull(schema.messages.threadRootId),
          sql`${schema.messages.seq} > ${seenSeq}`,
        ),
      );
    // In a group only the messages routing gives this Bot count (C5, C7).
    const threadBot = chat?.type === 'group' ? await threadBotId(tx, chat, thread) : null;
    const forBot = late.some((m) => chat?.type !== 'group' || isForBot(row.botId, m, threadBot));
    const start =
      chat?.type === 'group'
        ? { trigger: 'mention' as const, depth: 1 }
        : { trigger: 'message' as const };
    const followUp = forBot
      ? await insertRun(tx, {
          botId: row.botId,
          chatId: row.chatId,
          ...start,
          ...threadInput(thread),
        })
      : null;
    return { run: row, followUp };
  });
  if (done.run) await publishRunStatus(deps, done.run);
  if (done.followUp) await scheduleRun(deps, done.followUp, 'run');
  return done;
}
