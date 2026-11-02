import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { chats } from './chats.js';
import { createdAt, id, updatedAt } from './columns.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Plan 4.8: Artifacts, memory, files (A1 to A4, M1 to M3).

export const artifactKind = pgEnum('artifact_kind', ['document', 'code', 'data', 'design', 'file']);

export const memoryKind = pgEnum('memory_kind', ['preference', 'fact', 'summary']);

/**
 * What a stored file is for. Only `attachment` rows (uploads the owner attached
 * in chats) are listed as attachments or attachable to a message (plan 12.1);
 * Artifact version blobs, webhook delivery bodies and avatar uploads are not.
 */
export const filePurpose = pgEnum('file_purpose', [
  'attachment',
  'artifact',
  'webhook_body',
  'avatar',
]);

/**
 * pgvector needs a fixed dimension to index. 1536 is the native size of
 * OpenAI text-embedding-3-small; larger models can be truncated to it
 * (Matryoshka), smaller ones need a new column.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const artifacts = pgTable('artifacts', {
  id: id(),
  workspaceId: workspaceId(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }),
  chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
  kind: artifactKind('kind').notNull(),
  title: text('title').notNull(),
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => artifactVersions.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Every edit is a new version (A2). */
export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: id(),
    workspaceId: workspaceId(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    summary: text('summary'),
    createdByRunId: uuid('created_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.artifactId, t.version)],
);

/** Belongs to a Bot (M1). */
export const botMemories = pgTable(
  'bot_memories',
  {
    id: id(),
    workspaceId: workspaceId(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: memoryKind('kind').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    /**
     * What made `embedding`: `provider:model` or `local` (M1). Vectors of
     * different sources are not compared; null (rows from before this column)
     * is stale and re-embedded in the background.
     */
    embeddingModel: text('embedding_model'),
    sourceRunId: uuid('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Recency per Bot, and similarity search for context assembly (plan 5.3 item 5).
    index('bot_memories_bot_created').on(t.botId, t.createdAt),
    index('bot_memories_embedding').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Attachments, artifact blobs, webhook bodies and avatar uploads, told apart by `purpose`. */
export const files = pgTable(
  'files',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    sha256: text('sha256').notNull(),
    purpose: filePurpose('purpose').notNull().default('attachment'),
    /** An attachment's chat: where the owner first sent it. Null until sent. */
    chatId: uuid('chat_id').references(() => chats.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  // The owner's attachments, newest first (the Computer page's list).
  (t) => [index('files_owner_purpose_created').on(t.ownerId, t.purpose, t.createdAt)],
);

export const auditLog = pgTable('audit_log', {
  id: id(),
  workspaceId: workspaceId(),
  actorType: text('actor_type').notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: createdAt(),
});
