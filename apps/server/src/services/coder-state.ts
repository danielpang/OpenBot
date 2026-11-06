import {
  CODER_FEED_LINE_MAX,
  CODER_FEED_MAX,
  wsEvent,
  type CoderEvent,
  type CoderFeedLine,
  type CoderUsage,
  type CodingSessionStatus,
} from '@openbots/shared';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  CodingSessionApproval,
  CodingSessionState,
  CodingSessionStateResult,
} from '@openbots/widgets';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { publishEvent } from '../infra/index.js';
import { IGNORED_SESSION_ID, isVendorSessionId } from './coder-adapters/types.js';
import { flushTranscript } from './coder-transcript.js';
import { publishSessionUpdated } from './coding-session-view.js';

// A coding session's two records (I12): its `coding_sessions` row and the
// state of the `coding_session` widget it posted, the `widget_states` row at
// the session's (`message_id`, `part_index`). Every change goes through
// here, so both move together and the widget hears `widget.updated` as it
// does for any other widget. The waiting run's `pending_run_id` is left as it
// is until the session settles.
//
// The agent's output arrives a few lines a second, so feed lines are
// buffered per session and written and published at most once every
// FEED_FLUSH_MS; any other change writes the buffered lines first, so the
// feed stays in order. Changes to one session run one after another. A
// change to the row is published to the owner as `coding_session.updated`,
// after the transcript entries written before it (coder-transcript.ts).

type StateDeps = Pick<AppDeps, 'db' | 'infra' | 'logger'>;
export type CodingSessionRow = typeof schema.codingSessions.$inferSelect;

/** At most one feed write and publish per session this often. */
export const FEED_FLUSH_MS = 500;

// The session log: the CLI's raw output, kept on the server under
// `<filesDir>/coders/<session id>.log` (the runner appends it, at most
// SESSION_LOG_MAX bytes). The path is always made from the id, never read
// from the row.

/** The most a session log grows to; the runner writes SESSION_LOG_FULL once and stops. */
export const SESSION_LOG_MAX = 8 * 1024 * 1024;
export const SESSION_LOG_FULL = '[openbots] The session log reached 8 MB; later output is not kept';

type LogDeps = { config: Pick<AppDeps['config'], 'filesDir'> };

/** Where a session's log is on the server. */
export function sessionLogPath(deps: LogDeps, sessionId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) throw new Error('Not a session id');
  return path.join(deps.config.filesDir, 'coders', `${sessionId}.log`);
}

/** The last `maxBytes` of a session's log; empty when it has none. */
export async function readSessionLog(
  deps: LogDeps,
  session: Pick<CodingSessionRow, 'id'>,
  maxBytes: number,
): Promise<string> {
  let file;
  try {
    file = await open(sessionLogPath(deps, session.id), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.max(0, Math.min(size, Math.floor(maxBytes)));
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
}

export async function removeSessionLog(
  deps: LogDeps,
  session: Pick<CodingSessionRow, 'id'>,
): Promise<void> {
  await rm(sessionLogPath(deps, session.id), { force: true });
}

const EMPTY: CodingSessionState = { status: 'queued', feed: [], approvals: [] };

const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > CODER_FEED_LINE_MAX ? `${line.slice(0, CODER_FEED_LINE_MAX - 1)}…` : line;
};

/** A feed line for an event, or for the runner's own note (`text`). */
export function feedLine(
  type: CoderFeedLine['type'],
  text: string,
  at = new Date(),
): CoderFeedLine {
  return { t: at.toISOString(), type, text: clip(text) };
}

/** How an event reads in the feed. */
export function describeEvent(event: CoderEvent): string {
  switch (event.type) {
    case 'text':
      return event.text;
    case 'tool_use':
      return `${event.name}: ${event.summary}`;
    case 'file_change': {
      const verb =
        event.kind === 'create' ? 'Wrote' : event.kind === 'delete' ? 'Deleted' : 'Edited';
      const counts =
        event.added !== undefined || event.removed !== undefined
          ? ` (+${event.added ?? 0} -${event.removed ?? 0})`
          : '';
      return `${verb} ${event.path}${counts}`;
    }
    case 'command': {
      const ended = event.exit_code === undefined ? '' : ` (exit ${event.exit_code})`;
      const said = event.summary ? `: ${event.summary}` : '';
      return `$ ${event.command}${ended}${said}`;
    }
    case 'approval_request':
      return `Asks: ${event.title}`;
    case 'usage': {
      const cost = event.cost_usd ? `, $${event.cost_usd.toFixed(2)}` : '';
      return `${event.input_tokens} tokens in, ${event.output_tokens} out${cost}`;
    }
    case 'result':
      return event.ok
        ? `Finished: ${event.summary || 'done'}`
        : `Stopped: ${event.error ?? event.summary}`;
    case 'error':
      return event.message;
  }
}

/** Two usage reports as one: tokens and cost add up, the latest billing wins. */
export function addUsage(previous: CoderUsage | null | undefined, next: CoderUsage): CoderUsage {
  if (!previous) return next;
  const cost =
    previous.cost_usd === undefined && next.cost_usd === undefined
      ? undefined
      : (previous.cost_usd ?? 0) + (next.cost_usd ?? 0);
  return {
    input_tokens: previous.input_tokens + next.input_tokens,
    output_tokens: previous.output_tokens + next.output_tokens,
    ...(cost === undefined ? {} : { cost_usd: cost }),
    billed: next.billed === 'unknown' ? previous.billed : next.billed,
  };
}

// Per session: the unwritten feed lines, the flush timer, and the chain
// every change waits its turn on.
interface Pending {
  lines: CoderFeedLine[];
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  chain: Promise<unknown>;
}
const pending = new Map<string, Pending>();

function slot(sessionId: string): Pending {
  let found = pending.get(sessionId);
  if (!found) {
    found = { lines: [], timer: null, lastFlush: 0, chain: Promise.resolve() };
    pending.set(sessionId, found);
  }
  return found;
}

/** Runs `fn` after every earlier change to the session. */
function serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const s = slot(sessionId);
  const next = s.chain.then(fn, fn);
  s.chain = next.catch(() => {});
  return next;
}

async function loadSession(deps: StateDeps, sessionId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId));
  return row ?? null;
}

type Mutation = (state: CodingSessionState) => CodingSessionState;

/**
 * Writes the widget state in its row lock, the buffered feed lines first,
 * then publishes it. `rowPatch` goes to the session row in the same
 * transaction, and the row is published too. Returns the new state, or null
 * when the session has no widget (its message was deleted).
 */
async function write(
  deps: StateDeps,
  sessionId: string,
  mutate: Mutation,
  rowPatch: Partial<typeof schema.codingSessions.$inferInsert> = {},
  { clearPending = false }: { clearPending?: boolean } = {},
): Promise<CodingSessionState | null> {
  const s = slot(sessionId);
  const lines = s.lines.splice(0);
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.lastFlush = Date.now();
  const session = await loadSession(deps, sessionId);
  if (!session) return null;
  return inWorkspace(session.workspaceId, async () => {
    let updated: CodingSessionRow | undefined;
    const done = await deps.db.transaction(async (tx) => {
      if (Object.keys(rowPatch).length) {
        [updated] = await tx
          .update(schema.codingSessions)
          .set({ ...rowPatch, updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, sessionId))
          .returning();
      }
      if (!session.messageId || session.partIndex === null) return null;
      const [current] = await tx
        .select()
        .from(schema.widgetStates)
        .where(
          and(
            eq(schema.widgetStates.messageId, session.messageId),
            eq(schema.widgetStates.partIndex, session.partIndex),
          ),
        )
        .for('update');
      const before = { ...EMPTY, ...((current?.state as CodingSessionState | undefined) ?? {}) };
      const fed = lines.length
        ? { ...before, feed: [...before.feed, ...lines].slice(-CODER_FEED_MAX) }
        : before;
      const state = mutate(fed);
      const pendingRunId = clearPending ? null : (current?.pendingRunId ?? null);
      await tx
        .insert(schema.widgetStates)
        .values({
          workspaceId: session.workspaceId,
          messageId: session.messageId,
          partIndex: session.partIndex,
          state: state as object,
          pendingRunId,
        })
        .onConflictDoUpdate({
          target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
          set: { state: state as object, pendingRunId, updatedAt: new Date() },
        });
      return { state, pendingRunId };
    });
    await flushTranscript(deps, sessionId);
    if (updated) await publishSessionUpdated(deps, updated);
    if (!done || !session.messageId || session.partIndex === null) return done?.state ?? null;
    const [message] = await deps.db
      .select({
        chatId: schema.messages.chatId,
        seq: schema.messages.seq,
        authorType: schema.messages.authorType,
        authorId: schema.messages.authorId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, session.messageId));
    if (message) {
      await publishEvent(
        deps.infra.bus,
        wsEvent(
          'widget.updated',
          {
            widget: {
              messageId: session.messageId,
              partIndex: session.partIndex,
              state: done.state,
              pendingRunId: done.pendingRunId,
            },
          },
          {
            chat_id: message.chatId,
            seq: message.seq,
            ...(message.authorType === 'bot' && message.authorId
              ? { bot_id: message.authorId }
              : {}),
          },
        ),
      );
    }
    return done.state;
  });
}

/**
 * Adds a line to the session's feed: written and published with the next
 * flush, at most FEED_FLUSH_MS after the last one. Returns at once.
 */
export function appendFeed(deps: StateDeps, sessionId: string, line: CoderFeedLine): void {
  const s = slot(sessionId);
  s.lines.push(line);
  if (s.lines.length > CODER_FEED_MAX) s.lines.splice(0, s.lines.length - CODER_FEED_MAX);
  if (s.timer) return;
  const wait = Math.max(0, FEED_FLUSH_MS - (Date.now() - s.lastFlush));
  s.timer = setTimeout(() => {
    s.timer = null;
    serial(sessionId, () => write(deps, sessionId, (state) => state)).catch((error: unknown) =>
      deps.logger.warn({ err: error, sessionId }, 'coding session feed not written'),
    );
  }, wait);
  s.timer.unref?.();
}

export function flushFeed(deps: StateDeps, sessionId: string): Promise<CodingSessionState | null> {
  return serial(sessionId, () => write(deps, sessionId, (state) => state));
}

/** The session's status on its row and in its widget, with any other row columns. */
export function setSessionStatus(
  deps: StateDeps,
  sessionId: string,
  status: CodingSessionStatus,
  patch: Partial<typeof schema.codingSessions.$inferInsert> = {},
): Promise<CodingSessionState | null> {
  return serial(sessionId, () =>
    write(
      deps,
      sessionId,
      (state) => ({
        ...state,
        status,
        ...(patch.startedAt ? { started_at: new Date(patch.startedAt).toISOString() } : {}),
      }),
      { status, ...patch },
    ),
  );
}

/**
 * The owner's own next prompt reopened the ended session (its row is
 * already queued): the widget is queued again, without the last turn's
 * result, error and finish, with `line` in its feed.
 */
export function reopenSessionWidget(
  deps: StateDeps,
  sessionId: string,
  line: CoderFeedLine,
): Promise<CodingSessionState | null> {
  return serial(sessionId, () => {
    slot(sessionId).lines.push(line);
    return write(deps, sessionId, (state) => {
      const {
        control: _control,
        result: _result,
        error: _error,
        finished_at: _finished,
        ...rest
      } = state;
      return { ...rest, status: 'queued' };
    });
  });
}

/**
 * One event from the agent: its feed line, and what it records. Usage adds
 * to the session's; a result keeps the summary and the vendor's session id;
 * an error keeps the message.
 */
export async function applyEvent(
  deps: StateDeps,
  sessionId: string,
  event: CoderEvent,
): Promise<void> {
  if (event.type === 'result' && event.vendor_session_id !== undefined) {
    if (!isVendorSessionId(event.vendor_session_id)) {
      const { vendor_session_id: _, ...rest } = event;
      appendFeed(deps, sessionId, feedLine('error', IGNORED_SESSION_ID));
      return applyEvent(deps, sessionId, rest);
    }
  }
  const line = feedLine(event.type, describeEvent(event));
  if (event.type !== 'usage' && event.type !== 'result' && event.type !== 'error') {
    appendFeed(deps, sessionId, line);
    return;
  }
  await serial(sessionId, async () => {
    const session = await loadSession(deps, sessionId);
    if (!session) return null;
    slot(sessionId).lines.push(line);
    if (event.type === 'usage') {
      const { type: _, ...usage } = event;
      return write(deps, sessionId, (state) => state, {
        usage: addUsage(session.usage, usage),
      });
    }
    if (event.type === 'result') {
      return write(
        deps,
        sessionId,
        (state) => ({
          ...state,
          ...(event.vendor_session_id ? { vendor_session_id: event.vendor_session_id } : {}),
          ...(event.ok ? {} : { error: event.error ?? event.summary }),
        }),
        {
          summary: event.summary,
          ...(event.vendor_session_id ? { vendorSessionId: event.vendor_session_id } : {}),
          ...(event.ok ? {} : { error: event.error ?? event.summary }),
        },
      );
    }
    return write(deps, sessionId, (state) => ({ ...state, error: event.message }), {
      error: event.message,
    });
  });
}

/** Adds an approval to the widget, or changes its status. */
export function setApproval(
  deps: StateDeps,
  sessionId: string,
  approval: CodingSessionApproval,
): Promise<CodingSessionState | null> {
  return serial(sessionId, () =>
    write(deps, sessionId, (state) => {
      const found = state.approvals.some((a) => a.id === approval.id);
      return {
        ...state,
        approvals: found
          ? state.approvals.map((a) => (a.id === approval.id ? { ...a, ...approval } : a))
          : [...state.approvals, approval],
      };
    }),
  );
}

/** Changes one approval's status, if the widget lists it and it is still pending. */
export function setApprovalStatus(
  deps: StateDeps,
  sessionId: string,
  approvalId: string,
  status: CodingSessionApproval['status'],
): Promise<CodingSessionState | null> {
  return serial(sessionId, () =>
    write(deps, sessionId, (state) => ({
      ...state,
      approvals: state.approvals.map((a) =>
        a.id === approvalId && a.status === 'pending' ? { ...a, status } : a,
      ),
    })),
  );
}

export interface SessionOutcome {
  status: Extract<CodingSessionStatus, 'settled' | 'failed' | 'stopped'>;
  result?: CodingSessionStateResult;
  /** The row's `error`, and the widget's unless `widgetError` says otherwise. */
  error?: string | null;
  /** What the widget shows when the row keeps a machine-readable marker (NEEDS_LOGIN). */
  widgetError?: string;
}

/**
 * The session ended: its row (status, finish time, result columns, error)
 * and its widget (status, result, error; pending approvals expire; the
 * owner's control is done; no run waits on it any more). Returns the
 * widget state, which is what the waiting run resumes with.
 */
export async function settleSession(
  deps: StateDeps,
  sessionId: string,
  outcome: SessionOutcome,
): Promise<CodingSessionState> {
  const finishedAt = new Date();
  const { result, error } = outcome;
  const shown = outcome.widgetError ?? error;
  const state = await serial(sessionId, () =>
    write(
      deps,
      sessionId,
      (current) => {
        const { control: _, ...rest } = current;
        return {
          ...rest,
          status: outcome.status,
          finished_at: finishedAt.toISOString(),
          approvals: rest.approvals.map((a) =>
            a.status === 'pending' ? { ...a, status: 'expired' as const } : a,
          ),
          ...(result ? { result } : {}),
          ...(shown ? { error: shown } : {}),
          ...(shown === null ? { error: undefined } : {}),
        };
      },
      {
        status: outcome.status,
        finishedAt,
        ...(result
          ? {
              summary: result.summary,
              changedFiles: result.changed_files,
              commits: result.commits,
              prUrl: result.pr_url ?? null,
              ...(result.usage ? { usage: result.usage } : {}),
              // A settle with no diff clears the last one's, as the widget's result does.
              diffArtifactId: result.diff_artifact_id ?? null,
            }
          : {}),
        ...(error !== undefined ? { error } : {}),
      },
      { clearPending: true },
    ),
  );
  pending.delete(sessionId);
  return (
    state ?? {
      ...EMPTY,
      status: outcome.status,
      finished_at: finishedAt.toISOString(),
      ...(result ? { result } : {}),
      ...(shown ? { error: shown } : {}),
    }
  );
}
