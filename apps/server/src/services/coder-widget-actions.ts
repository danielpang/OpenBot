import type { CoderControl, CodingSessionStatus } from '@openbots/shared';
import {
  widgetToolResult,
  type CodingSessionAction,
  type CodingSessionProps,
  type CodingSessionState,
} from '@openbots/widgets';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError } from '../errors.js';
import { publishCoderControl } from './coder-control.js';
import { moveRunToWaitingLogin } from './coder-login.js';
import { resumeIfSessionEnded, resumeWaitingRun } from './coder-run-resume.js';
import { settleSession } from './coder-state.js';
import {
  CODING_SESSION_ACTIVE,
  discardWorktree,
  ended,
  sessionEnded,
  sessionRunning,
  type CodingSessionRow,
} from './coding-sessions.js';
import type { WidgetActionContext } from './hooks.js';
import { postUserMessage } from './messages.js';

// The `coding_session` widget's actions (docs/TECHNICAL_PLAN.md 22.2 step 8),
// which the widget action path calls (services/runs.ts): Stop publishes on
// the coder control channel (a session nobody claimed yet is stopped here),
// Continue posts the owner's prompt as an owner message in the session's
// chat, so a run of the Bot continues it through `code_task` (with a run to
// ask the owner in and to hear the result), Discard removes the worktree,
// its branch and its log. And the paused run's check, when what it waits on
// ended before it paused.

export const SESSION_KIND = 'coding_session';

/**
 * A run paused on a coding widget posted by `code_task` (workers/runs.ts):
 * when what it waits on already ended before the pause, it resumes now. A
 * session's widget asks the runner's helper (unless a sign-in the runner
 * started lists the run: it waits on that instead); a sign-in's reads its state.
 */
export async function resumeIfCoderWidgetDone(
  deps: AppDeps,
  runId: string,
  posted: { messageId: string; partIndex: number },
  kind: string,
): Promise<void> {
  if (kind === SESSION_KIND) {
    // The runner found the agent signed out before the run paused: it waits on the sign-in.
    if (await moveRunToWaitingLogin(deps, runId)) return;
    const [session] = await deps.db
      .select({ id: schema.codingSessions.id })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.messageId, posted.messageId),
          eq(schema.codingSessions.partIndex, posted.partIndex),
        ),
      );
    if (session) await resumeIfSessionEnded(deps, session.id);
    return;
  }
  const [stored] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, posted.messageId),
        eq(schema.widgetStates.partIndex, posted.partIndex),
      ),
    );
  const status = (stored?.state as { status?: string } | undefined)?.status;
  if (!status || status === 'pending' || status === 'awaiting_code') return;
  await resumeWaitingRun(deps, runId, widgetToolResult(kind, stored!.state), { waitMs: 0 });
}

/** The widget kinds a run started by `code_task` waits on. */
export const CODER_WIDGET_KINDS = new Set([SESSION_KIND, 'coder_login']);

// The widget's actions

/**
 * The `coding_session` widget's action hook (called from services/runs.ts
 * inside the action's transaction): moves the row with the widget and clears
 * `control`, which only says what the owner asked for. Throws to refuse.
 */
export async function onCodingSessionAction(
  deps: Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>,
  tx: Db,
  context: WidgetActionContext,
): Promise<{ state?: unknown; after?: () => Promise<void> } | void> {
  const action = context.action as CodingSessionAction;
  if (action.type === 'open_terminal') return;
  const props = context.props as CodingSessionProps;
  const [row] = await tx
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.id, props.session_id),
        eq(schema.codingSessions.workspaceId, context.message.workspaceId),
      ),
    )
    .for('update');
  if (!row) return;
  const { control: _, ...reduced } = context.state as CodingSessionState;
  // Continue leaves the session ended: the Bot's `code_task` reopens it.
  const state: CodingSessionState =
    action.type === 'continue'
      ? { ...reduced, status: row.status as CodingSessionStatus }
      : reduced;
  const after = await sessionEffect(
    deps as AppDeps,
    tx,
    row,
    action,
    context.message.threadRootId ?? null,
  );
  return { state, ...(after ? { after } : {}) };
}

/**
 * The row side of an owner's action, written with `tx`; returns what runs
 * once the action is stored (publishing, the job, the computer).
 */
export async function sessionEffect(
  deps: AppDeps,
  tx: Db,
  row: CodingSessionRow,
  action: CodingSessionAction,
  /** The thread the session's widget is in, where Continue's message goes. */
  thread: string | null,
): Promise<(() => Promise<void>) | undefined> {
  switch (action.type) {
    case 'stop': {
      if (ended(row.status)) throw sessionEnded();
      // Nobody claimed it yet: it stops here, and its run hears so.
      const [unclaimed] = await tx
        .update(schema.codingSessions)
        .set({ status: 'stopped', finishedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(schema.codingSessions.id, row.id), eq(schema.codingSessions.status, 'queued')),
        )
        .returning();
      return async () => {
        await publishCoderControl(deps, { type: 'stop', sessionId: row.id } satisfies CoderControl);
        if (!unclaimed) return;
        const state = await settleSession(deps, row.id, { status: 'stopped' });
        if (row.runId) {
          await resumeWaitingRun(deps, row.runId, widgetToolResult(SESSION_KIND, state), {
            waitMs: 0,
          });
        }
      };
    }
    case 'continue': {
      if (!ended(row.status)) throw sessionRunning();
      const [busy] = await tx
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(
          and(
            eq(schema.codingSessions.botId, row.botId),
            inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
            ne(schema.codingSessions.id, row.id),
          ),
        )
        .limit(1);
      if (busy) {
        throw new DomainError(
          409,
          'CODER_BUSY',
          'This Bot is running another coding session; continue this one when it ends',
        );
      }
      const [chat] = row.chatId
        ? await tx.select().from(schema.chats).where(eq(schema.chats.id, row.chatId))
        : [];
      const [bot] = await tx
        .select({ handle: schema.bots.handle, archivedAt: schema.bots.archivedAt })
        .from(schema.bots)
        .where(eq(schema.bots.id, row.botId));
      if (!chat || !bot || bot.archivedAt) {
        throw new DomainError(
          409,
          'SESSION_NO_CHAT',
          'The chat this session started in is gone, so its Bot cannot continue it',
        );
      }
      // The Bot continues it with `code_task`, from a run of its own: so the
      // session has a run to ask the owner in, and the Bot hears the result.
      // Outside its transcript the message mentions the Bot, so it is routed there.
      const text = `${chat.type === 'bot_dm' ? '' : `@${bot.handle} `}Continue coding session ${row.id}: ${action.prompt}`;
      const owner = { id: row.ownerId, workspaceId: row.workspaceId };
      return async () => {
        await postUserMessage(deps, owner, chat.id, {
          text,
          ...(thread ? { threadRootId: thread } : {}),
        });
      };
    }
    case 'discard':
      if (!ended(row.status)) {
        throw new DomainError(409, 'SESSION_RUNNING', 'Stop the session before discarding it');
      }
      return () => discardWorktree(deps, row);
    case 'open_terminal':
      return undefined;
  }
}
