import { unwrap, type components } from '@openbots/api-client';
import { useQuery } from '@tanstack/react-query';
import { useMobile } from '../api/provider';

export type Bot = components['schemas']['Bot'];
export type Chat = components['schemas']['Chat'];
export type Message = components['schemas']['Message'];
export function useBots() {
  const { client: api, transport } = useMobile();
  return useQuery({
    queryKey: ['bots'],
    enabled: !!api && !!transport,
    queryFn: () => unwrap(api!.GET('/api/v1/bots')),
    select: (result) => result.items,
  });
}
export function useChats() {
  const { client: api, transport } = useMobile();
  return useQuery({
    queryKey: ['chats'],
    enabled: !!api && !!transport,
    queryFn: () => unwrap(api!.GET('/api/v1/chats')),
    select: (result) => result.items,
  });
}
export function useApprovals() {
  const { client, transport } = useMobile();
  return useQuery({
    queryKey: ['approvals'],
    enabled: !!client && !!transport,
    queryFn: async () => {
      if (!client) return [];
      const result = await client.GET('/api/v1/approvals');
      if (result.response.status === 404) return [];
      return (await unwrap(Promise.resolve(result))).items;
    },
  });
}
export function groupTitle(chat: Chat, bots: readonly Bot[] = []) {
  return (
    chat.title?.trim() ||
    chat.botIds
      .map((id) => bots.find((bot) => bot.id === id)?.name)
      .filter(Boolean)
      .join(', ') ||
    'Group'
  );
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
