import { summarizeChat, toModelMessages } from '@openbots/agent';
import type { LanguageModel } from 'ai';
import { and, asc, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { chatHandles, transcriptMessage } from './chats.js';

// Rolling chat summaries (plan 4.2, 5.3 item 6, 18.6). Context assembly reads
// the last `window` top-level messages plus `chats.summary`; this folds the
// top-level messages that have scrolled out of that window into the summary
// with the small model, a batch at a time, and advances
// `summary_through_seq`. The run worker calls it after a completed run, like
// memory extraction. Thread replies stay out: a thread run reads its thread
// in full.

type SummaryDeps = Pick<AppDeps, 'db' | 'logger'>;

/** Messages beyond the window that must pile up before the summary is rewritten. */
export const SUMMARY_BATCH = 20;
/** Messages folded in at most per pass; the rest wait for the next run. */
export const SUMMARY_MAX_BATCH = 100;

/**
 * The top-level messages a run reads, oldest first, out of the newest
 * `window + 2 * batch` (`rows`, newest first). The last `window` exactly would
 * start one message later after every message, so no two runs would open with
 * the same messages and a provider's prompt cache (a prefix match) would never
 * hold the transcript. Instead the start stays put while up to `batch` more
 * messages arrive, then moves on by about a batch:
 *
 * - to the message after the summary's (`through`), when that leaves at
 *   least `window`. The window then moves exactly when the summary is
 *   rewritten, and no message is in both or in neither.
 * - otherwise (no summary yet, or one that has fallen behind) to the last
 *   multiple of `batch` at or before the `window`th newest message's seq.
 */
export function contextWindow<T extends { seq: number }>(
  rows: T[],
  window: number,
  batch: number,
  through: number | null,
): T[] {
  const edge = rows[window - 1];
  if (!edge) return rows.toReversed();
  const oldest = rows.at(-1)!.seq;
  const start =
    through !== null && through < edge.seq && through >= oldest - 1
      ? through + 1
      : Math.floor(edge.seq / batch) * batch;
  return rows.filter((r) => r.seq >= start).toReversed();
}

export interface SummaryOptions {
  /** The context window the summary sits behind (`HISTORY_WINDOW`). */
  window: number;
  batch?: number;
}

/**
 * Folds the top-level messages older than the window and newer than
 * `summary_through_seq` into the summary once there are `batch` of them.
 * Returns the new `summary_through_seq`, or null when nothing changed.
 */
export async function updateChatSummary(
  deps: SummaryDeps,
  chatId: string,
  model: LanguageModel,
  { window, batch = SUMMARY_BATCH }: SummaryOptions,
): Promise<number | null> {
  const [chat] = await deps.db.select().from(schema.chats).where(eq(schema.chats.id, chatId));
  if (!chat) return null;
  const m = schema.messages;
  const topLevel = and(eq(m.chatId, chat.id), isNull(m.threadRootId));
  // The oldest message still in the window; everything before it is summary material.
  const [edge] = await deps.db
    .select({ seq: m.seq })
    .from(m)
    .where(topLevel)
    .orderBy(desc(m.seq))
    .offset(window - 1)
    .limit(1);
  if (!edge) return null;
  const through = chat.summaryThroughSeq ?? 0;
  const rows = await deps.db
    .select()
    .from(m)
    .where(and(topLevel, gt(m.seq, through), lt(m.seq, edge.seq), ne(m.status, 'streaming')))
    .orderBy(asc(m.seq))
    .limit(SUMMARY_MAX_BATCH);
  if (rows.length < batch) return null;

  const handles = await chatHandles(
    deps.db,
    chat,
    rows.map((r) => r.authorId),
  );
  const transcript = toModelMessages(rows.map((r) => transcriptMessage(r, null, handles)))
    .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
    .filter((t) => t.trim());
  const summary = transcript.length
    ? await summarizeChat({ model, previous: chat.summary, transcript })
    : chat.summary;
  const last = rows.at(-1)!.seq;
  // Conditional on the watermark it read, so two passes racing keep one result.
  const [updated] = await deps.db
    .update(schema.chats)
    .set({ summary: summary?.trim() ? summary : chat.summary, summaryThroughSeq: last })
    .where(
      and(
        eq(schema.chats.id, chat.id),
        sql`${schema.chats.summaryThroughSeq} is not distinct from ${chat.summaryThroughSeq}`,
      ),
    )
    .returning({ id: schema.chats.id });
  return updated ? last : null;
}
