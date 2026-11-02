import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { chats, messages } from './chats.js';
import { createdAt, id, timestamptz } from './columns.js';
import { routineRuns } from './prompts.js';
import { workspaceId } from './workspace.js';

// Plan 4.3: Runs (execution).

export const runTrigger = pgEnum('run_trigger', [
  'message',
  'mention',
  'bot_message',
  'bot_dm',
  'widget_action',
  'webhook',
  'routine',
  'resume',
]);

export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const runStepType = pgEnum('run_step_type', [
  'llm',
  'tool_call',
  'tool_result',
  'approval',
  'steer',
  'error',
]);

export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

export const runs = pgTable(
  'runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
    trigger: runTrigger('trigger').notNull(),
    priority: integer('priority').notNull().default(0),
    status: runStatus('status').notNull().default('queued'),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    routineRunId: uuid('routine_run_id').references((): AnyPgColumn => routineRuns.id, {
      onDelete: 'set null',
    }),
    depth: integer('depth').notNull().default(0),
    model: text('model'),
    usage: jsonb('usage'),
    /** Serialized model messages while waiting for approval or a widget. */
    state: jsonb('state'),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    // A Bot's active run in a chat (steering, plan 5.2) and its run history.
    index('runs_bot_status').on(t.botId, t.status),
    index('runs_chat_created').on(t.chatId, t.createdAt),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    type: runStepType('type').notNull(),
    /** The activity log line (I4). */
    label: text('label').notNull(),
    payload: jsonb('payload'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.runId, t.idx)],
);

/** P1. */
export const approvals = pgTable('approvals', {
  id: id(),
  workspaceId: workspaceId(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  toolName: text('tool_name').notNull(),
  args: jsonb('args').notNull().default({}),
  reason: text('reason'),
  status: approvalStatus('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: timestamptz('decided_at'),
  expiresAt: timestamptz('expires_at'),
  createdAt: createdAt(),
});
