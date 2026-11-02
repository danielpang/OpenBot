import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { chats, messages } from './chats.js';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Plan 4.6: Prompts: Skills and Routines (S1 to S3, R1 to R5).

export const skillSource = pgEnum('skill_source', [
  'manual',
  'saved_from_run',
  'demonstration',
  'imported',
]);

/** Only the legacy `skills.status` column uses it. */
export const skillStatus = pgEnum('skill_status', ['draft', 'ready']);

/** One library per account (S2). */
export const skills = pgTable(
  'skills',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** The first line of `content` (the Bot's Skills index). */
    summary: text('summary').notNull().default(''),
    /** The Skill's instructions, markdown (S1). Stored in `body_md`. */
    content: text('body_md').notNull().default(''),
    /**
     * Before Skills became a name and content (the skills_content migration), a Skill had six
     * sections and a draft or ready status. Kept so that migration lost
     * nothing; no longer read or written.
     */
    legacySections: jsonb('sections').default({}),
    legacyStatus: skillStatus('status').default('draft'),
    source: skillSource('source').notNull().default('manual'),
    createdFromRunId: uuid('created_from_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    /**
     * Where an imported Skill came from (S3): the GitHub URL and commit, the
     * folder's other files and the text of those kept as reference material.
     * Null for a Skill written here or saved from a run.
     */
    origin: jsonb('origin'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('skills_slug_per_owner').on(t.workspaceId, t.ownerId, t.slug)],
);

export const botSkills = pgTable(
  'bot_skills',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique().on(t.botId, t.skillId)],
);

/** Cap 50 per Bot, enforced in code (R4). */
export const routines = pgTable(
  'routines',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** `{type:'schedule', cron, preset}` or `{type:'event', source, endpoint_id, match}` (R1, R2). */
    trigger: jsonb('trigger').notNull(),
    promptMd: text('prompt_md').notNull().default(''),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    timezone: text('timezone').notNull().default('UTC'),
    nextRunAt: timestamptz('next_run_at'),
    lastRunAt: timestamptz('last_run_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.botId, t.slug),
    // The scheduler's due scan (plan 10.2).
    index('routines_due')
      .on(t.nextRunAt)
      .where(sql`${t.enabled} and ${t.nextRunAt} is not null`),
  ],
);

/** Trimmed to the 20 most recent per Routine (R4). */
export const routineRuns = pgTable(
  'routine_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    routineId: uuid('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    status: text('status').notNull(),
    resultMessageId: uuid('result_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    exception: text('exception'),
    /** What started it: schedule, run_now, event or retry. */
    reason: text('reason').notNull().default('schedule'),
    /**
     * The scheduled time a schedule run is for; with the unique key below it is
     * the idempotency key "routine plus slot", so two workers that both see a
     * due Routine enqueue its slot once. Null for run-now, event and retry runs.
     */
    slot: timestamptz('slot'),
  },
  (t) => [
    unique('routine_runs_slot').on(t.routineId, t.slot),
    index('routine_runs_routine_started').on(t.routineId, t.startedAt),
  ],
);
