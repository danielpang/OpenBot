import {
  embedderFor,
  localEmbedder,
  type Embedder,
  type MemoryItem,
  type MemoryKind,
} from '@openbots/agent';
import { ModelConfigSchema, PRIORITY, type JobHandler } from '@openbots/shared';
import { and, cosineDistance, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { notFound } from '../errors.js';
import { assertBotOwner } from '../ownership.js';
import { providerSource } from './providers.js';

// Memory v0 (M1 to M3; plan 4.8, 5.3). Each Bot has its own `bot_memories`:
// what it saved with `remember`, what post-run extraction proposed, and what
// the owner wrote or edited on the Memory tab. Every row carries an embedding
// and the source that made it (see `@openbots/agent` memory/embed.ts for the
// provider and local sources) so context assembly can pick memories similar
// to the conversation. A query is compared only with memories of its own
// source; when a Bot's source changes (a new provider, a key added, a failed
// call that fell back to local), a background job re-embeds the rest.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type MemoryDeps = Pick<AppDeps, 'db' | 'config' | 'logger'>;

export type MemoryRow = typeof schema.botMemories.$inferSelect;

/** Memories in a run's context: the most recent few, then the most similar. */
export const CONTEXT_MEMORIES = 8;
const RECENT_IN_CONTEXT = 4;

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
}

export function toMemoryItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The Bot's provider's embedding model, else the local fallback. */
export async function embedderForBot(deps: MemoryDeps, botId: string): Promise<Embedder> {
  const [bot] = await deps.db
    .select({ modelConfig: schema.bots.modelConfig })
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  const config = ModelConfigSchema.safeParse(bot?.modelConfig);
  if (!config.success) return localEmbedder;
  const provider = await providerSource(deps).getProvider(config.data.provider_id);
  return embedderFor(provider, (err) =>
    deps.logger.warn({ err, botId }, 'embedding failed; using the local embedding'),
  );
}

async function embedOne(embedder: Embedder, text: string) {
  const { source, vectors } = await embedder.embed([text]);
  return { embedding: vectors[0]!, embeddingModel: source };
}

// Owner API (M2)

export async function listMemories(db: Db, owner: Owner, botId: string): Promise<MemoryRow[]> {
  await assertBotOwner(db, owner, botId);
  return db
    .select()
    .from(schema.botMemories)
    .where(eq(schema.botMemories.botId, botId))
    .orderBy(desc(schema.botMemories.createdAt));
}

export async function createMemory(
  deps: MemoryDeps,
  owner: Owner,
  botId: string,
  input: MemoryInput,
): Promise<MemoryRow> {
  await assertBotOwner(deps.db, owner, botId);
  return saveMemory(deps, { botId, workspaceId: owner.workspaceId, ...input });
}

async function ownedMemory(db: Db, owner: Owner, botId: string, memoryId: string) {
  await assertBotOwner(db, owner, botId);
  const [row] = await db
    .select()
    .from(schema.botMemories)
    .where(and(eq(schema.botMemories.id, memoryId), eq(schema.botMemories.botId, botId)));
  if (!row) throw notFound('Memory not found');
  return row;
}

export async function updateMemory(
  deps: MemoryDeps,
  owner: Owner,
  botId: string,
  memoryId: string,
  patch: Partial<MemoryInput>,
): Promise<MemoryRow> {
  const current = await ownedMemory(deps.db, owner, botId, memoryId);
  const content = patch.content ?? current.content;
  const embedded =
    content === current.content
      ? { embedding: current.embedding, embeddingModel: current.embeddingModel }
      : await embedOne(await embedderForBot(deps, botId), content);
  const [row] = await deps.db
    .update(schema.botMemories)
    .set({ kind: patch.kind ?? current.kind, content, ...embedded, updatedAt: new Date() })
    .where(eq(schema.botMemories.id, memoryId))
    .returning();
  return row!;
}

export async function deleteMemory(db: Db, owner: Owner, botId: string, memoryId: string) {
  await ownedMemory(db, owner, botId, memoryId);
  await db.delete(schema.botMemories).where(eq(schema.botMemories.id, memoryId));
}

// Runtime

export async function saveMemory(
  deps: MemoryDeps,
  input: MemoryInput & { botId: string; workspaceId: string; sourceRunId?: string | null },
  embedder?: Embedder,
): Promise<MemoryRow> {
  const embedded = await embedOne(
    embedder ?? (await embedderForBot(deps, input.botId)),
    input.content,
  );
  const [row] = await deps.db
    .insert(schema.botMemories)
    .values({
      workspaceId: input.workspaceId,
      botId: input.botId,
      kind: input.kind,
      content: input.content.trim(),
      ...embedded,
      sourceRunId: input.sourceRunId ?? null,
    })
    .returning();
  return row!;
}

/**
 * The Bot's memories most similar to `query`, among those embedded by the
 * same source as the query: vectors from another source are not comparable.
 */
export async function searchMemories(
  deps: Pick<AppDeps, 'db'>,
  botId: string,
  query: string,
  limit: number,
  embedder: Embedder,
  exclude: string[] = [],
): Promise<MemoryRow[]> {
  if (!query.trim()) return [];
  const { embedding, embeddingModel } = await embedOne(embedder, query);
  const m = schema.botMemories;
  return deps.db
    .select()
    .from(m)
    .where(
      and(
        eq(m.botId, botId),
        isNotNull(m.embedding),
        eq(m.embeddingModel, embeddingModel),
        exclude.length ? notInArray(m.id, exclude) : undefined,
      ),
    )
    .orderBy(cosineDistance(m.embedding, embedding))
    .limit(limit);
}

/**
 * Top-K for context assembly (plan 5.3 item 5): the most recent memories,
 * then the most similar to the recent conversation, oldest first. Memories
 * embedded by another source than the Bot's are queued for re-embedding.
 */
export async function contextMemories(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  botId: string,
  recentText: string,
  embedder: Embedder,
  k = CONTEXT_MEMORIES,
): Promise<MemoryItem[]> {
  await queueReembedIfStale(deps, botId, embedder.id);
  const recent = await deps.db
    .select()
    .from(schema.botMemories)
    .where(eq(schema.botMemories.botId, botId))
    .orderBy(desc(schema.botMemories.createdAt))
    .limit(RECENT_IN_CONTEXT);
  const similar = await searchMemories(
    deps,
    botId,
    recentText,
    k - recent.length,
    embedder,
    recent.map((r) => r.id),
  );
  return [...recent, ...similar]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(toMemoryItem);
}

// Re-embedding (M1)

export const MEMORIES_QUEUE = 'memories';
/** Memories embedded per call while re-embedding. */
const REEMBED_BATCH = 64;

export interface ReembedJob {
  botId: string;
  /** The source the Bot's memories should have; a job for an old source does nothing. */
  source: string;
  /** Its organization, where it runs (infra/index.ts). */
  workspaceId?: string;
}

const staleFor = (botId: string, source: string) =>
  and(
    eq(schema.botMemories.botId, botId),
    sql`${schema.botMemories.embeddingModel} is distinct from ${source}`,
  );

/** Queues a re-embed when any of the Bot's memories has another source than `source`. */
export async function queueReembedIfStale(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  botId: string,
  source: string,
): Promise<boolean> {
  const [stale] = await deps.db
    .select({ id: schema.botMemories.id, workspaceId: schema.botMemories.workspaceId })
    .from(schema.botMemories)
    .where(staleFor(botId, source))
    .limit(1);
  if (!stale) return false;
  await deps.infra
    .queue<ReembedJob>(MEMORIES_QUEUE)
    .enqueue(
      'reembed',
      { botId, source, workspaceId: stale.workspaceId },
      { groupKey: `reembed:${botId}`, priority: PRIORITY.background },
    );
  return true;
}

/**
 * Re-embeds the Bot's memories whose source is not `embedder`'s, a batch at a
 * time. Stops early, leaving the rest stale, when a call falls back to
 * another source (the provider is failing; a later run queues it again).
 * Returns how many memories were re-embedded.
 */
export async function reembedMemories(
  deps: Pick<AppDeps, 'db'>,
  botId: string,
  embedder: Embedder,
): Promise<number> {
  const m = schema.botMemories;
  let done = 0;
  for (;;) {
    const rows = await deps.db
      .select({ id: m.id, content: m.content })
      .from(m)
      .where(staleFor(botId, embedder.id))
      .orderBy(m.createdAt)
      .limit(REEMBED_BATCH);
    if (!rows.length) return done;
    const { source, vectors } = await embedder.embed(rows.map((r) => r.content));
    if (source !== embedder.id) return done;
    for (const [i, row] of rows.entries()) {
      // An owner's edit in between has its own fresh embedding; leave it.
      await deps.db
        .update(m)
        .set({ embedding: vectors[i]!, embeddingModel: source })
        .where(and(eq(m.id, row.id), eq(m.content, row.content)));
    }
    done += rows.length;
    if (rows.length < REEMBED_BATCH) return done;
  }
}

/** The re-embed worker: only while the Bot's source is still the job's. */
export function reembedHandler(
  deps: MemoryDeps,
  embedderOf: (botId: string) => Promise<Embedder> = (botId) => embedderForBot(deps, botId),
): JobHandler<ReembedJob> {
  return async (job) => {
    const { botId, source } = job.data;
    const embedder = await embedderOf(botId);
    if (embedder.id !== source) return;
    const count = await reembedMemories(deps, botId, embedder);
    if (count) deps.logger.info({ botId, source, count }, 're-embedded memories');
  };
}
