import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { bytea, createdAt, id, timestamptz, updatedAt } from './columns.js';
import { workspaceId } from './workspace.js';

// Plan 4.4: Tools (T1 to T5).

export const connectorKind = pgEnum('connector_kind', ['mcp_stdio', 'mcp_http', 'builtin']);

/** Account level (T1). */
export const connectors = pgTable(
  'connectors',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    kind: connectorKind('kind').notNull(),
    /** The catalog entry this was added from, if any; matched by `connector_policy` (T3). */
    catalogId: text('catalog_id'),
    /** An admin vouches for this connector, so its MCP tool hints are believed (S-16). */
    trusted: boolean('trusted').notNull().default(false),
    /** An admin marked the HTTP server as on their own network, so it may be private (S-8). */
    local: boolean('local').notNull().default(false),
    config: jsonb('config').notNull().default({}),
    secrets: bytea('secrets'),
    status: text('status').notNull(),
    lastError: text('last_error'),
    lastCheckedAt: timestamptz('last_checked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('connectors_slug_per_owner').on(t.workspaceId, t.ownerId, t.slug)],
);

/** Cached tool list. */
export const connectorTools = pgTable(
  'connector_tools',
  {
    id: id(),
    workspaceId: workspaceId(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description'),
    inputSchema: jsonb('input_schema').notNull().default({}),
    annotations: jsonb('annotations').notNull().default({}),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.connectorId, t.name)],
);

/** Per-Bot permissions. */
export const botConnectors = pgTable(
  'bot_connectors',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    toolAllowlist: text('tool_allowlist').array(),
    toolDenylist: text('tool_denylist').array().notNull().default([]),
    approvalOverride: text('approval_override'),
  },
  (t) => [unique().on(t.botId, t.connectorId)],
);

/** Admin block list; shows "Disabled by admin" (T3). Exactly one of catalog_id, url_pattern. */
export const connectorPolicy = pgTable(
  'connector_policy',
  {
    id: id(),
    workspaceId: workspaceId(),
    catalogId: text('catalog_id'),
    urlPattern: text('url_pattern'),
    blocked: boolean('blocked').notNull().default(true),
    setBy: uuid('set_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.workspaceId, t.catalogId),
    unique().on(t.workspaceId, t.urlPattern),
    check('connector_policy_target', sql`(${t.catalogId} is null) <> (${t.urlPattern} is null)`),
  ],
);
