import { boolean, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { bytea, createdAt, id, timestamptz } from './columns.js';
import { workspaceId } from './workspace.js';

// Plan 4.5: Computer (K1 to K7).

export const computerProvider = pgEnum('computer_provider', ['docker', 'remote']);

/** One per account in each organization (K1, plan 21.3). */
export const computers = pgTable(
  'computers',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    provider: computerProvider('provider').notNull().default('docker'),
    spec: jsonb('spec').notNull().default({}),
    status: text('status').notNull(),
    containerId: text('container_id'),
    agentUrl: text('agent_url'),
    agentToken: bytea('agent_token'),
    volumeName: text('volume_name'),
    alwaysOn: boolean('always_on').notNull().default(false),
    idleTimeoutMin: integer('idle_timeout_min'),
    lastUsedAt: timestamptz('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('computers_one_per_owner').on(t.workspaceId, t.ownerId)],
);

/** One screen per Bot (K2); `controlled_by_user_id` set during takeover (K3). */
export const botScreens = pgTable(
  'bot_screens',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .unique()
      .references(() => bots.id, { onDelete: 'cascade' }),
    computerId: uuid('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    displayNumber: integer('display_number').notNull(),
    browserProfileDir: text('browser_profile_dir'),
    cdpPort: integer('cdp_port'),
    status: text('status').notNull(),
    controlledByUserId: uuid('controlled_by_user_id').references(() => users.id),
    controlledSince: timestamptz('controlled_since'),
  },
  (t) => [unique().on(t.computerId, t.displayNumber)],
);
