import type { AppDeps } from '../context.js';
import type { Db, schema } from '../db/client.js';
import type { Message } from '../schemas.js';

// Extension points the messages API calls without depending on what listens.
// The agent runtime (1.B) registers `onUserMessage` at startup to enqueue a
// run; tests register their own and remove them afterwards.

export type UserMessageHook = (deps: AppDeps, message: Message) => Promise<void> | void;

const userMessageHooks = new Set<UserMessageHook>();

/** Registers a hook for every stored owner message; returns the unregister function. */
export function onUserMessage(hook: UserMessageHook): () => void {
  userMessageHooks.add(hook);
  return () => userMessageHooks.delete(hook);
}

/**
 * Runs every `onUserMessage` hook in registration order. The message is
 * already stored and published, so a failing hook is logged, not rethrown.
 */
export async function runUserMessageHooks(deps: AppDeps, message: Message): Promise<void> {
  for (const hook of userMessageHooks) {
    try {
      await hook(deps, message);
    } catch (error) {
      deps.logger.error({ err: error, messageId: message.id }, 'onUserMessage hook failed');
    }
  }
}

// Run status (1.B publishes every change through `publishRunStatus`): Routines
// (6.2) keep their run records and post the "Routine ran" widget from here.

export type RunStatusHook = (
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  run: typeof schema.runs.$inferSelect,
) => Promise<void> | void;

const runStatusHooks = new Set<RunStatusHook>();

/** Registers a hook for every run status change; returns the unregister function. */
export function onRunStatus(hook: RunStatusHook): () => void {
  runStatusHooks.add(hook);
  return () => runStatusHooks.delete(hook);
}

/** Runs every `onRunStatus` hook; a failing hook is logged and never fails the run. */
export async function runRunStatusHooks(
  deps: Pick<AppDeps, 'db' | 'infra' | 'logger'>,
  run: typeof schema.runs.$inferSelect,
): Promise<void> {
  for (const hook of runStatusHooks) {
    try {
      await hook(deps, run);
    } catch (error) {
      deps.logger.error({ err: error, runId: run.id }, 'onRunStatus hook failed');
    }
  }
}

// Widget actions with a server-side effect (plan 12.2): Confirm on a Routine
// proposal creates the Routine, Run again on a Routine run starts one. The
// hook runs inside the action's transaction after the kind's reducer, may
// replace the next state, and throws to refuse the action (nothing is
// stored); `after` runs once the state is stored and published.

export interface WidgetActionContext {
  message: Pick<
    typeof schema.messages.$inferSelect,
    'id' | 'chatId' | 'workspaceId' | 'authorType' | 'authorId' | 'threadRootId'
  >;
  partIndex: number;
  props: unknown;
  /** The reducer's next state. */
  state: unknown;
  action: unknown;
}

export type WidgetActionHook = (
  deps: Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>,
  tx: Db,
  context: WidgetActionContext,
) => Promise<{ state?: unknown; after?: () => Promise<void> } | void>;

const widgetActionHooks = new Map<string, WidgetActionHook>();

/** Registers the effect of one widget kind's actions; returns the unregister function. */
export function onWidgetAction(kind: string, hook: WidgetActionHook): () => void {
  widgetActionHooks.set(kind, hook);
  return () => {
    if (widgetActionHooks.get(kind) === hook) widgetActionHooks.delete(kind);
  };
}

export function widgetActionHook(kind: string): WidgetActionHook | undefined {
  return widgetActionHooks.get(kind);
}
