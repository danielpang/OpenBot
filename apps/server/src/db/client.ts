import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export { schema };

/**
 * Any Drizzle database or transaction over this schema: postgres.js in
 * production, PGlite in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string, options: postgres.Options<Record<string, never>> = {}) {
  const client = postgres(url, { onnotice: () => {}, ...options });
  const db = drizzle(client, { schema });
  return Object.assign(db, { close: () => client.end() });
}

/**
 * Reserves the next `messages.seq` for a chat.
 *
 * `seq` is the realtime contract: per chat, strictly increasing, assigned by
 * the database, and carried on every WS event for resync. It comes from the
 * `chats.chat_seq` counter, bumped with `UPDATE ... RETURNING`. The update
 * row-locks the chat until the transaction ends, so call this inside the same
 * transaction that inserts the message: concurrent writers to one chat then
 * commit in seq order, and a rolled-back insert leaves at most a gap, never a
 * duplicate or an out-of-order commit. Writers to different chats do not block
 * each other.
 */
export async function nextSeq(db: Db, chatId: string): Promise<number> {
  const [row] = await db
    .update(schema.chats)
    .set({ chatSeq: sql`${schema.chats.chatSeq} + 1` })
    .where(eq(schema.chats.id, chatId))
    .returning({ seq: schema.chats.chatSeq });
  if (!row) throw new Error(`nextSeq: chat ${chatId} not found`);
  return row.seq;
}
