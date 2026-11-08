import { unwrap, type components } from '@openbots/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useApi, useMobile } from '../api/provider';
import type { CodingSessionEntry } from '@openbots/shared';

export type CodingSession = components['schemas']['CodingSession'];

export function useCodingUpdates() {
  const { ws } = useMobile();
  const cache = useQueryClient();
  useEffect(
    () =>
      ws?.onEvent((event) => {
        if (event.type.startsWith('approval.'))
          void cache.invalidateQueries({ queryKey: ['approvals'] });
        if (event.type.startsWith('coding_session.')) {
          void cache.invalidateQueries({ queryKey: ['coding-sessions'] });
        }
      }),
    [ws, cache],
  );
}

export function useCodingSessions(botId?: string) {
  const api = useApi();
  useCodingUpdates();
  return useQuery({
    queryKey: ['coding-sessions', 'list', botId],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/api/v1/coding-sessions', {
            params: { query: { limit: 100, ...(botId ? { botId } : {}) } },
          }),
        )
      ).sessions.filter((session) => !botId || session.botId === botId),
    refetchInterval: 5000,
  });
}

export function useCodingTranscript(id: string) {
  const api = useApi();
  const cache = useQueryClient();
  const queryKey = ['coding-sessions', id, 'events'];
  return useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<CodingSessionEntry[]> => {
      // Only advance after a complete read; retries cannot skip a failed page.
      const entries = [...(cache.getQueryData<CodingSessionEntry[]>(queryKey) ?? [])];
      let more = true;
      while (more) {
        const page = await unwrap(
          api.GET('/api/v1/coding-sessions/{id}/events', {
            params: { path: { id }, query: { after: entries.at(-1)?.seq ?? 0, limit: 200 } },
            signal,
          }),
        );
        entries.push(...page.entries);
        more = page.hasMore && page.entries.length > 0;
      }
      return entries;
    },
    refetchInterval: 3000,
  });
}
