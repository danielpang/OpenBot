import { unwrap, type components } from '@openbots/api-client';
import { useEffect, useRef, useState } from 'react';
import { useMobile } from './provider';
import { applyEvent, mergeMessages, readResync, type Message } from './timeline';
import { SnapshotWriter } from '../cache/writer';

export function useMessages(chatId?: string, threadRootId?: string) {
  const { client, ws, host, cache, onResync, setFocusedChat } = useMobile();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const current = useRef<Message[]>([]);
  const actions = useRef({ refetch: async () => {}, loadMore: async () => {} });
  const generation = useRef(0);
  const cacheKey = `transcript:${chatId}:${threadRootId ?? ''}`;
  const replace = (next: Message[]) => {
    current.current = next;
    setMessages(next);
  };

  useEffect(() => {
    const token = ++generation.current;
    let stopped = false;
    let syncing = false;
    let repeat = false;
    const writer = host ? new SnapshotWriter<Message[]>(cache, host.id, cacheKey) : null;
    const valid = () => !stopped && token === generation.current;
    const inScope = (message: Message) =>
      threadRootId
        ? message.id === threadRootId || message.threadRootId === threadRootId
        : !message.threadRootId;
    const update = (change: (held: Message[]) => Message[]) => {
      if (!valid()) return;
      const next = change(current.current);
      replace(next);
      writer?.schedule(next.slice(-500));
    };
    const report = (cause: unknown) => {
      if (valid()) setError(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const resync = async () => {
      if (!client || !chatId || !valid()) return;
      if (syncing) {
        repeat = true;
        return;
      }
      syncing = true;
      try {
        do {
          repeat = false;
          // Include the oldest held message, since its completion/widget may have changed offline.
          const since = Math.max(0, (current.current[0]?.seq ?? 1) - 1);
          await readResync(
            (cursor) =>
              unwrap(
                client.GET('/api/v1/chats/{id}/resync', {
                  params: { path: { id: chatId }, query: { since: cursor } },
                }),
              ),
            since,
            (page) => {
              const removed = new Set(page.deleted.map((message) => message.id));
              update((held) =>
                mergeMessages(
                  held.filter((message) => !removed.has(message.id)),
                  page.messages.filter(inScope),
                ),
              );
            },
          );
          if (valid()) setError(null);
        } while (repeat && valid());
      } catch (cause) {
        report(cause);
      } finally {
        syncing = false;
      }
    };
    const page = async (before?: number) => {
      if (!client || !chatId) return;
      const result = await unwrap(
        client.GET('/api/v1/chats/{id}/messages', {
          params: { path: { id: chatId }, query: { before, limit: 50, thread: threadRootId } },
        }),
      );
      if (!valid()) return;
      update((held) => mergeMessages(held, result.messages));
      setHasMore(result.hasMore);
      setError(null);
      for (const message of result.messages) ws?.noteSeq(chatId, message.seq);
    };
    actions.current = {
      refetch: resync,
      async loadMore() {
        if (!valid()) return;
        setLoadingMore(true);
        try {
          await page(current.current[0]?.seq);
        } catch (cause) {
          report(cause);
        } finally {
          if (valid()) setLoadingMore(false);
        }
      },
    };
    replace([]);
    setLoading(true);
    setError(null);
    setHasMore(false);
    setSending(false);
    setLoadingMore(false);
    setFocusedChat(chatId ?? null);
    const offResync = chatId ? onResync(chatId, () => void resync()) : () => {};
    if (chatId) ws?.subscribe({ chats: [chatId] });
    const offEvent = ws?.onEvent((event) => {
      if (event.chat_id !== chatId) return;
      if (event.type === 'message.created' && !inScope(event.payload.message as Message)) return;
      // A thread receives the whole chat's events, but only updates its own rows.
      const result = applyEvent(current.current, event);
      update(() => result.messages.filter(inScope));
      if (result.gap) void resync();
    });
    void (async () => {
      if (host && chatId) {
        try {
          const saved = await cache.get<Message[]>(host.id, cacheKey);
          if (valid() && saved) update((held) => mergeMessages(saved, held));
        } catch (cause) {
          report(cause);
        }
      }
      await page();
      await resync();
    })()
      .catch(report)
      .finally(() => {
        if (valid()) setLoading(false);
      });
    return () => {
      stopped = true;
      void writer?.close();
      offResync();
      offEvent?.();
      if (chatId) ws?.unsubscribe({ chats: [chatId] });
      setFocusedChat(null);
    };
  }, [chatId, threadRootId, client, ws, host?.id, cache]);

  return {
    messages,
    loading,
    error,
    hasMore,
    sending,
    loadingMore,
    refetch: () => actions.current.refetch(),
    loadMore: () => (loadingMore ? Promise.resolve() : actions.current.loadMore()),
    async send(body: components['schemas']['PostMessage']) {
      if (!client || !chatId) throw new Error('Reconnect before sending.');
      const token = generation.current;
      setSending(true);
      try {
        const response = await unwrap(
          client.POST('/api/v1/chats/{id}/messages', {
            params: { path: { id: chatId } },
            body: { ...body, ...(threadRootId ? { threadRootId } : {}) },
          }),
        );
        if (token === generation.current) replace(mergeMessages(current.current, [response]));
      } finally {
        if (token === generation.current) setSending(false);
      }
    },
  };
}
