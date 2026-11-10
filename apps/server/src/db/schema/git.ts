import { sql } from 'drizzle-orm';
import type { GitConnectionRepoAccess } from '@openbots/shared';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bytea, createdAt, id, timestamptz, updatedAt } from './columns.js';
import { workspaceId } from './workspace.js';

// Git connections (GH1, GH2, GH7, GH8; I17) and the install's own settings.
// Value sets for the text columns live in `@openbots/shared` git.ts:
// `GitConnectionKind`, `GitActAs`, `GitConnectionStatus`.

/**
 * One per owner per GitHub account or organization: an App installation
 * (`installation_id`), the owner's OAuth sign-in or a pasted token.
 * `secrets` is a sealed envelope (secrets.ts), like `connectors.secrets`,
 * holding the `token` kind's token and the owner's OAuth token for
 * `act_as = 'owner'`; an App connection mints installation tokens instead.
 */
export const gitConnections = pgTable(
  'git_connections',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('github'),
    kind: text('kind').notNull(),
    installationId: text('installation_id'),
    accountLogin: text('account_login').notNull(),
    /** `user` or `organization`, when known. */
    accountType: text('account_type'),
    actAs: text('act_as').notNull().default('bot'),
    secrets: bytea('secrets'),
    /**
     * An App connection's reach (H1): the installation's repositories the
     * owner's own GitHub authorization listed at install or reauthorization
     * (`GET /user/installations/{id}/repositories`), with `push` and `admin`.
     * Tokens are minted only for these, and write only where `push`. Null
     * until read (and for `oauth` and `token`): such a connection reaches
     * nothing until the owner authorizes again.
     */
    repositories: jsonb('repositories').$type<GitConnectionRepoAccess[]>(),
    repositoriesSyncedAt: timestamptz('repositories_synced_at'),
    status: text('status').notNull().default('connected'),
    lastSyncedAt: timestamptz('last_synced_at'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('git_connections_workspace_owner').on(t.workspaceId, t.ownerId),
    uniqueIndex('git_connections_installation_per_owner')
      .on(t.workspaceId, t.ownerId, t.provider, t.installationId)
      .where(sql`${t.installationId} is not null`),
  ],
);

/**
 * Who an owner's coding sessions commit as: `bot` (the Bot as author, the
 * owner as co-author) or `owner` (the owner as author). `name` and `email`
 * override the account's for that, null when not set (session-git.ts).
 */
export const gitIdentities = pgTable(
  'git_identities',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commitAs: text('commit_as').notNull().default('bot'),
    name: text('name'),
    email: text('email'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('git_identities_owner').on(t.workspaceId, t.ownerId)],
);

/** `instance_settings.key` of the self-hoster's own GitHub App (I17). */
export const INSTANCE_SETTING_GITHUB_APP = 'github_app';

/**
 * Settings of the install, no organization's (so no workspace_id), each a
 * sealed envelope of JSON under the master key; `rotateMasterKey` re-seals
 * them. Like `instance_keys`, read and written outside any organization's
 * scope. `github_app` holds the App the manifest flow made (a
 * `StoredGithubApp`, services/github-app-types.ts).
 */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: bytea('value').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The nonces of the GitHub App flows' `state` (manifest, install,
 * reauthorize) already used, so a callback URL cannot be replayed. A row
 * lives as long as its state (10 minutes); expired rows are deleted as new
 * ones come. The install's, no organization's, like `instance_settings`.
 */
export const githubStateNonces = pgTable('github_state_nonces', {
  nonce: text('nonce').primaryKey(),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
});
