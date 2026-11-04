export interface CachedMessage {
  id: string;
  chatId: string;
  seq: number;
  deltaSeq?: number;
  [key: string]: unknown;
}

export interface SnapshotCache {
  get<T>(hostId: string, key: string): Promise<T | null>;
  set<T>(hostId: string, key: string, value: T): Promise<void>;
  removeHost(hostId: string): Promise<void>;
  mergeMessages(hostId: string, chatId: string, messages: readonly CachedMessage[]): Promise<void>;
  readMessages<T extends CachedMessage = CachedMessage>(
    hostId: string,
    chatId: string,
    limit?: number,
  ): Promise<T[]>;
  getChatSeq(hostId: string, chatId: string): Promise<number>;
  close(): Promise<void>;
}

/** Keeps REST snapshots from replacing a more recent streamed message. */
export function mergeMessage(
  previous: CachedMessage | undefined,
  incoming: CachedMessage,
): CachedMessage {
  if (previous && (previous.deltaSeq ?? 0) > (incoming.deltaSeq ?? 0)) return previous;
  return incoming;
}

export function createMemoryCache(): SnapshotCache {
  const snapshots = new Map<string, Map<string, string>>();
  const messages = new Map<string, Map<string, Map<string, CachedMessage>>>();
  return {
    async get<T>(hostId: string, key: string): Promise<T | null> {
      const item = snapshots.get(hostId)?.get(key);
      return item === undefined ? null : (JSON.parse(item) as T);
    },
    async set(hostId, key, value) {
      if (!snapshots.has(hostId)) snapshots.set(hostId, new Map());
      snapshots.get(hostId)!.set(key, JSON.stringify(value));
    },
    async removeHost(hostId) {
      snapshots.delete(hostId);
      messages.delete(hostId);
    },
    async mergeMessages(hostId, chatId, incoming) {
      if (incoming.some((message) => message.chatId !== chatId))
        throw new Error('Message belongs to another chat');
      if (!messages.has(hostId)) messages.set(hostId, new Map());
      const chats = messages.get(hostId)!;
      if (!chats.has(chatId)) chats.set(chatId, new Map());
      const held = chats.get(chatId)!;
      for (const message of incoming) {
        held.set(message.id, structuredClone(mergeMessage(held.get(message.id), message)));
      }
    },
    async readMessages<T extends CachedMessage>(
      hostId: string,
      chatId: string,
      limit = 100,
    ): Promise<T[]> {
      if (limit <= 0) return [];
      return [...(messages.get(hostId)?.get(chatId)?.values() ?? [])]
        .sort((a, b) => a.seq - b.seq)
        .slice(-limit)
        .map((item) => structuredClone(item) as T);
    },
    async getChatSeq(hostId, chatId) {
      return Math.max(
        0,
        ...[...(messages.get(hostId)?.get(chatId)?.values() ?? [])].map((message) => message.seq),
      );
    },
    async close() {},
  };
}
