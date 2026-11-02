import { wsEvent, type BotStateKindSchema, type JobHandler } from '@openbots/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { publishEvent } from '../infra/index.js';

// The roster state machine (plan 6.1, I2, I3). Every change writes `bot_state`
// and publishes `bot.state`; `done` settles to `idle` three seconds later
// through a delayed job, so the settle happens whichever process runs it.

export type BotStateKind = z.infer<typeof BotStateKindSchema>;
export type BotStateRow = typeof schema.botState.$inferSelect;

type StateDeps = Pick<AppDeps, 'db' | 'infra'>;

export const BOT_STATE_QUEUE = 'bot-state';
export const DONE_SETTLE_MS = 3_000;

export interface SettleJob {
  botId: string;
  /** The run that finished; a later run's state is left alone. */
  runId: string | null;
  /** Its organization, where it runs (infra/index.ts). */
  workspaceId?: string;
}

export interface SetStateOptions {
  runId?: string | null;
  /** The activity label shown on hover (I3), from `labelFor` in `@openbots/agent`. */
  currentAction?: string | null;
  /** The tool running while `working`; a computer tool lights the title-bar icon (I5). */
  currentTool?: string | null;
}

export async function setState(
  deps: StateDeps,
  botId: string,
  state: BotStateKind,
  { runId = null, currentAction = null, currentTool = null }: SetStateOptions = {},
): Promise<BotStateRow> {
  const [row] = await deps.db
    .update(schema.botState)
    .set({ state, runId, currentAction, currentTool })
    .where(eq(schema.botState.botId, botId))
    .returning();
  if (!row) throw new Error(`setState: no bot_state row for Bot ${botId}`);
  await publish(deps, row);
  if (state === 'done') {
    await deps.infra
      .queue<SettleJob>(BOT_STATE_QUEUE)
      .enqueue(
        'settle',
        { botId, runId, workspaceId: row.workspaceId },
        { delayMs: DONE_SETTLE_MS },
      );
  }
  return row;
}

export async function getState(deps: Pick<AppDeps, 'db'>, botId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.botState)
    .where(eq(schema.botState.botId, botId));
  return row;
}

/** "Cleared when: owner opens the transcript" (plan 6.1). Returns whether it changed. */
export async function clearBlockedOnOpen(deps: StateDeps, botId: string): Promise<boolean> {
  const [row] = await deps.db
    .update(schema.botState)
    .set({ state: 'idle', currentAction: null, currentTool: null })
    .where(and(eq(schema.botState.botId, botId), eq(schema.botState.state, 'blocked')))
    .returning();
  if (row) await publish(deps, row);
  return Boolean(row);
}

/** `done` to `idle`, unless the Bot has moved on since. */
export function settleHandler(deps: AppDeps): JobHandler<SettleJob> {
  return async ({ data: { botId, runId } }) => {
    const [row] = await deps.db
      .update(schema.botState)
      .set({ state: 'idle', currentAction: null, currentTool: null })
      .where(
        and(
          eq(schema.botState.botId, botId),
          eq(schema.botState.state, 'done'),
          runId ? eq(schema.botState.runId, runId) : isNull(schema.botState.runId),
        ),
      )
      .returning();
    if (row) await publish(deps, row);
  };
}

function publish(deps: StateDeps, row: BotStateRow) {
  return publishEvent(
    deps.infra.bus,
    wsEvent(
      'bot.state',
      {
        botId: row.botId,
        state: row.state,
        currentAction: row.currentAction,
        runId: row.runId,
        currentTool: row.currentTool,
      },
      { bot_id: row.botId },
    ),
  );
}
