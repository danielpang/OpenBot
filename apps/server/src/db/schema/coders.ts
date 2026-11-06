import type { CoderChangedFile, CoderCommit, CoderUsage } from '@openbots/shared';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { artifacts } from './artifacts.js';
import { users } from './auth.js';
import { bots } from './bots.js';
import { chats, messages } from './chats.js';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { computers } from './computer.js';
import { gitConnections } from './git.js';
import { providers } from './models.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Coding agents on the computer (CA2 to CA8, GH3, GH4; I6). Value sets for
// the text columns live in `@openbots/shared` coders.ts: `CoderAgent`,
// `CoderAuthKind`, `CoderMode`, `CodingSessionStatus`, `CoderLoginStatus`.
// No vendor credential is ever stored here: sign-ins live on the computer's
// state volume, under the `coder` user.

/** What Settings > Coding agents shows for one agent of one owner. */
export const coderAccounts = pgTable(
  'coder_accounts',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    authKind: text('auth_kind').notNull().default('none'),
    /** The Settings > Models provider whose key an `api_key` account uses. */
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    /** The signed-in account as the agent names it: an email, or the plan. */
    accountLabel: text('account_label'),
    signedInAt: timestamptz('signed_in_at'),
    lastError: text('last_error'),
    /** The CLI's version on the computer, from `<cli> --version`. */
    version: text('version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('coder_accounts_owner_agent').on(t.workspaceId, t.ownerId, t.agent)],
);

/**
 * The remembered repositories (GH4): added by URL, picked from a git
 * connection (`connection_id`; forgetting the connection keeps the row), or
 * remembered from a clone found on the computer (`found_path`, GH6).
 */
export const repos = pgTable(
  'repos',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => gitConnections.id, {
      onDelete: 'set null',
    }),
    /** `owner/name` on its host. */
    fullName: text('full_name').notNull(),
    remoteUrl: text('remote_url').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    visibility: text('visibility'),
    description: text('description'),
    /** Cloned again on a new home volume (GH4). */
    keepCloned: boolean('keep_cloned').notNull().default(true),
    pinned: boolean('pinned').notNull().default(false),
    lastUsedAt: timestamptz('last_used_at'),
    /** The last push to the remote GitHub reported (the App's `push` event, or a listing). */
    lastRemotePushAt: timestamptz('last_remote_push_at'),
    /** Where a clone found on the computer was, before it was remembered (GH6). */
    foundPath: text('found_path'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('repos_owner_remote').on(t.workspaceId, t.ownerId, t.remoteUrl)],
);

/**
 * A repository on one computer: its path and state from the last fetch
 * (`RepoCheckoutState` in `@openbots/shared` git.ts). A new home
 * volume starts with none, which is what triggers re-cloning.
 */
export const repoCheckouts = pgTable(
  'repo_checkouts',
  {
    id: id(),
    workspaceId: workspaceId(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    computerId: uuid('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    /** Absolute, under /home/bot/repos. */
    path: text('path').notNull(),
    state: text('state').notNull().default('missing'),
    ahead: integer('ahead').notNull().default(0),
    behind: integer('behind').notNull().default(0),
    headSha: text('head_sha'),
    lastFetchAt: timestamptz('last_fetch_at'),
    /** The checkout's size on disk, its worktrees included, as the last refresh measured it. */
    diskBytes: bigint('disk_bytes', { mode: 'number' }),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('repo_checkouts_workspace_id_idx').on(t.workspaceId),
    unique('repo_checkouts_repo_computer').on(t.repoId, t.computerId),
  ],
);

/**
 * One per `code_task` (I12); a continued session keeps its row. The widget
 * it posted is (`message_id`, `part_index`); `push_allowed` is what the
 * credential helper's push credential waits on.
 */
export const codingSessions = pgTable(
  'coding_sessions',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    partIndex: integer('part_index'),
    agent: text('agent').notNull(),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    /** Kept beside `repo_id` so the session still reads after the repository is forgotten. */
    repoFullName: text('repo_full_name'),
    remoteUrl: text('remote_url'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    base: text('base'),
    mode: text('mode').notNull(),
    prompt: text('prompt').notNull(),
    /** The vendor's own session id, for the adapter's resume argv. */
    vendorSessionId: text('vendor_session_id'),
    status: text('status').notNull().default('queued'),
    pushAllowed: boolean('push_allowed').notNull().default(false),
    usage: jsonb('usage').$type<CoderUsage>(),
    summary: text('summary'),
    changedFiles: jsonb('changed_files').$type<CoderChangedFile[]>(),
    commits: jsonb('commits').$type<CoderCommit[]>(),
    prUrl: text('pr_url'),
    /** The Artifact holding the branch's diff against its base (CA5 View diff); Discard leaves it. */
    diffArtifactId: uuid('diff_artifact_id').references(() => artifacts.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    /** The full event log, a file under the session's directory on the computer. */
    logPath: text('log_path'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('coding_sessions_workspace_id_idx').on(t.workspaceId),
    index('coding_sessions_bot_status').on(t.botId, t.status),
    index('coding_sessions_run').on(t.runId),
  ],
);

/**
 * A sign-in to a coding agent in progress (I4): the link and code the
 * agent's login printed, and the `coder_login` widget it is shown in.
 */
export const coderLogins = pgTable(
  'coder_logins',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    status: text('status').notNull().default('pending'),
    url: text('url'),
    deviceCode: text('device_code'),
    accountLabel: text('account_label'),
    error: text('error'),
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    partIndex: integer('part_index'),
    expiresAt: timestamptz('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('coder_logins_owner_agent').on(t.workspaceId, t.ownerId, t.agent)],
);
