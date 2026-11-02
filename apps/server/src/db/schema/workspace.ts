import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, id, timestamptz } from './columns.js';

// Organizations (plan section 21). A `workspaces` row is an organization:
// better-auth's organization plugin (ee/server) maps its `organization`,
// `member` and `invitation` models onto `workspaces`, `workspace_members` and
// `invites`. Every tenant table carries `workspace_id`. A self-hosted install
// has one, the implicit organization.

/** Roles in an organization (better-auth's access control in ee/server). */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  /** better-auth's organization slug: unique, made from the name. */
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  /** better-auth's organization metadata, a JSON string. */
  metadata: text('metadata'),
  /** Organization settings: limits, custom stdio, small models. */
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
});

/** Who belongs to an organization, and their role there (better-auth `member`). */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    /**
     * Set while an owner or admin has suspended the member in this
     * organization: their requests, API keys and sockets in it are refused,
     * while their Bots and data stay. Their other organizations are untouched.
     */
    suspendedAt: timestamptz('suspended_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.workspaceId, t.userId),
    index().on(t.userId),
    check('workspace_members_role', sql`${t.role} in ('owner', 'admin', 'member')`),
  ],
);

/** `workspace_id` column for section 4 tables. */
export const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/**
 * Invitations to an organization (better-auth `invitation`). Each is for one
 * email address; its id is the secret in the invite link. Accepted once.
 */
export const invites = pgTable(
  'invites',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    /** `pending`, `accepted`, `rejected` or `canceled`. */
    status: text('status').notNull().default('pending'),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.email),
    check('invites_role', sql`${t.role} in ('owner', 'admin', 'member')`),
    check('invites_status', sql`${t.status} in ('pending', 'accepted', 'rejected', 'canceled')`),
  ],
);
