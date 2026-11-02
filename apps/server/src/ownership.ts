import { and, eq, inArray } from 'drizzle-orm';
import type { CurrentUser } from './context.js';
import { schema, type Db } from './db/client.js';
import { notFound } from './errors.js';

// Who may see what. A user sees the chats and Bots they own, inside their
// workspace; everything else answers 404, never 403, so ids do not leak.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of `ids` that are chats owned by `user`. */
export async function ownedChatIds(db: Db, user: Owner, ids: string[]): Promise<Set<string>> {
  const candidates = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!candidates.length) return new Set();
  const rows = await db
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(
      and(
        inArray(schema.chats.id, candidates),
        eq(schema.chats.ownerId, user.id),
        eq(schema.chats.workspaceId, user.workspaceId),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** The subset of `ids` that are Bots owned by `user`. */
export async function ownedBotIds(db: Db, user: Owner, ids: string[]): Promise<Set<string>> {
  const candidates = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!candidates.length) return new Set();
  const rows = await db
    .select({ id: schema.bots.id })
    .from(schema.bots)
    .where(
      and(
        inArray(schema.bots.id, candidates),
        eq(schema.bots.ownerId, user.id),
        eq(schema.bots.workspaceId, user.workspaceId),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Throws 404 unless `user` owns the chat. */
export async function assertChatOwner(db: Db, user: Owner, chatId: string): Promise<void> {
  if (!(await ownedChatIds(db, user, [chatId])).has(chatId)) throw notFound('Chat not found');
}

/** Throws 404 unless `user` owns the Bot. */
export async function assertBotOwner(db: Db, user: Owner, botId: string): Promise<void> {
  if (!(await ownedBotIds(db, user, [botId])).has(botId)) throw notFound('Bot not found');
}
