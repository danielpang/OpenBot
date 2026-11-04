import { unwrap } from '@openbots/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMobile } from '../api/provider';
import { syncPendingInput, pendingWidgets, type InboxSnapshot } from '../transcript/inbox-model';
import { useApprovals, useBots, useChats } from './data';

/** Resync includes every thread. The first load scans all changes; subsequent
 * loads keep a cursor and only fetch changed rows, including deletions. */
export function useInbox() {
  const { client, cache, host } = useMobile();
  const queryClient = useQueryClient();
  const bots = useBots();
  const chats = useChats();
  const approvals = useApprovals();
  const chatIds = [
    ...new Set([
      ...(bots.data ?? []).map((bot) => bot.chatId),
      ...(chats.data ?? []).map((chat) => chat.id),
    ]),
  ].sort();
  const widgets = useQuery({
    queryKey: ['inbox', chatIds],
    enabled: !!client && bots.isSuccess && chats.isSuccess,
    queryFn: async ({ signal }) => {
      const all = [];
      let offline = false;
      for (let i = 0; i < chatIds.length; i += 4) {
        const batch = await Promise.all(
          chatIds.slice(i, i + 4).map(async (chatId) => {
            const key = ['inbox-snapshot', chatId];
            const saved =
              queryClient.getQueryData<InboxSnapshot>(key) ??
              (host ? await cache.get<InboxSnapshot>(host.id, `inbox:${chatId}`) : null);
            try {
              const snapshot = await syncPendingInput(
                (since) =>
                  unwrap(
                    client!.GET('/api/v1/chats/{id}/resync', {
                      params: { path: { id: chatId }, query: { since } },
                      signal,
                    }),
                  ),
                saved ?? undefined,
              );
              queryClient.setQueryData(key, snapshot);
              if (host) await cache.set(host.id, `inbox:${chatId}`, snapshot).catch(() => {});
              return snapshot.messages;
            } catch (error) {
              if (!saved) throw error;
              offline = true;
              return saved.messages;
            }
          }),
        );
        all.push(...batch.flat());
      }
      return { items: pendingWidgets(all), offline };
    },
  });
  return {
    approvals: approvals.data ?? [],
    widgets: widgets.data?.items ?? [],
    count: (approvals.data?.length ?? 0) + (widgets.data?.items.length ?? 0),
    loading: approvals.isLoading || widgets.isLoading,
    error:
      approvals.error ??
      widgets.error ??
      bots.error ??
      chats.error ??
      (widgets.data?.offline
        ? new Error('Showing saved requests. Reconnect before responding.')
        : null),
    refetch: () => {
      void approvals.refetch();
      void widgets.refetch();
    },
  };
}
