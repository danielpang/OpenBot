import * as SQLite from 'expo-sqlite';
import { mergeMessage, type CachedMessage, type SnapshotCache } from './index';

/** Host ID is part of every key, including message keys: switching hosts never leaks a cache. */
export async function createSqliteCache(name = 'openbots-cache.db'): Promise<SnapshotCache> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (host TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(host,key));
    CREATE TABLE IF NOT EXISTS messages (host TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(host,chat,id));
    CREATE INDEX IF NOT EXISTS messages_by_seq ON messages(host,chat,seq);`);
  return {
    async get<T>(hostId: string, key: string): Promise<T | null> {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM snapshots WHERE host=? AND key=?',
        hostId,
        key,
      );
      return row ? (JSON.parse(row.value) as T) : null;
    },
    async set(hostId, key, value) {
      await db.runAsync(
        'INSERT OR REPLACE INTO snapshots(host,key,value) VALUES(?,?,?)',
        hostId,
        key,
        JSON.stringify(value),
      );
    },
    async removeHost(hostId) {
      await db.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.runAsync('DELETE FROM snapshots WHERE host=?', hostId);
        await transaction.runAsync('DELETE FROM messages WHERE host=?', hostId);
      });
    },
    async mergeMessages(hostId, chatId, incoming) {
      await db.withExclusiveTransactionAsync(async (transaction) => {
        for (const message of incoming) {
          if (message.chatId !== chatId) throw new Error('Message belongs to another chat');
          const row = await transaction.getFirstAsync<{ value: string }>(
            'SELECT value FROM messages WHERE host=? AND chat=? AND id=?',
            hostId,
            chatId,
            message.id,
          );
          const merged = mergeMessage(
            row ? (JSON.parse(row.value) as CachedMessage) : undefined,
            message,
          );
          await transaction.runAsync(
            'INSERT OR REPLACE INTO messages(host,chat,id,seq,value) VALUES(?,?,?,?,?)',
            hostId,
            chatId,
            merged.id,
            merged.seq,
            JSON.stringify(merged),
          );
        }
      });
    },
    async readMessages<T extends CachedMessage>(
      hostId: string,
      chatId: string,
      limit = 100,
    ): Promise<T[]> {
      const rows = await db.getAllAsync<{ value: string }>(
        'SELECT value FROM messages WHERE host=? AND chat=? ORDER BY seq DESC LIMIT ?',
        hostId,
        chatId,
        limit,
      );
      return rows.reverse().map((row) => JSON.parse(row.value) as T);
    },
    async getChatSeq(hostId, chatId) {
      const row = await db.getFirstAsync<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM messages WHERE host=? AND chat=?',
        hostId,
        chatId,
      );
      return row?.seq ?? 0;
    },
    close: () => db.closeAsync(),
  };
}
