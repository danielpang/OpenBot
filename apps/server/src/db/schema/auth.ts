import { boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { workspaces } from './workspace.js';

// The better-auth tables (user, session, account, verification, apikey) in
// Drizzle form. Leaf 0.3 wires the adapter to these with `usePlural: true` and
// lets Postgres generate ids (`advanced.database.generateId: false`), so user ids
// are uuids like every other key and `owner_id` columns can reference them.

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  expiresAt: timestamptz('expires_at').notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /**
   * The organization this session works in (better-auth's organization
   * plugin, plan 21.2). Ignored on a self-hosted install, which has one.
   */
  activeOrganizationId: uuid('active_organization_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = pgTable('accounts', {
  id: id(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamptz('access_token_expires_at'),
  refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verifications = pgTable('verifications', {
  id: id(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * API keys (U4), the table of better-auth's api-key plugin. `key` holds a
 * hash; the plaintext is shown once at creation. `reference_id` is the owning
 * user.
 */
export const apikeys = pgTable(
  'apikeys',
  {
    id: id(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key').notNull(),
    referenceId: uuid('reference_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamptz('last_refill_at'),
    enabled: boolean('enabled').notNull().default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').notNull().default(0),
    remaining: integer('remaining'),
    lastRequest: timestamptz('last_request'),
    expiresAt: timestamptz('expires_at'),
    permissions: text('permissions'),
    metadata: text('metadata'),
    /**
     * The organization the key was made in, and the only one it opens (plan
     * 21.2). Set by `POST /api/v1/api-keys`; a managed install refuses a key
     * without one.
     */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.key), index().on(t.referenceId)],
);
