import { unwrap, type components } from '@openbots/api-client';
import { DEFAULT_LIMITS } from '@openbots/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import type { Bot } from '../bots/queries.js';

// Group chats (C4) and Bot-to-Bot chats (C6): `GET /chats` lists both (a
// Bot's own transcript is not listed), `POST /chats` starts a group, and
// `DELETE /chats/:id/members/:botId` takes a Bot out of one.

export type Chat = components['schemas']['Chat'];

/** The smallest group; the largest is the workspace's `botsPerGroup` (B8). */
export const GROUP_MIN = 2;

export const chatsQuery = queryOptions({
  queryKey: ['chats'],
  queryFn: () => unwrap(api.GET('/api/v1/chats')),
});

/** The group limit from `/me`, or the default before it loads. */
export function groupLimit(limits: { botsPerGroup?: number } | null | undefined): number {
  return limits?.botsPerGroup ?? DEFAULT_LIMITS.botsPerGroup;
}

export function groupsOf(chats: readonly Chat[] | undefined): Chat[] {
  return chats?.filter((c) => c.type === 'group') ?? [];
}

/** A Bot's chats with other Bots, each with the other Bot's id. */
export function botChatsOf(
  chats: readonly Chat[] | undefined,
  botId: string,
): { chat: Chat; peerId: string }[] {
  return (chats ?? []).flatMap((chat) => {
    if (chat.type !== 'bot_to_bot') return [];
    if (chat.botId === botId && chat.peerBotId) return [{ chat, peerId: chat.peerBotId }];
    if (chat.peerBotId === botId && chat.botId) return [{ chat, peerId: chat.botId }];
    return [];
  });
}

/**
 * Whether a chat is missing from the loaded lists: neither a group or Bot to
 * Bot chat nor a Bot's own transcript. Unknown while either list is loading.
 */
export function isNewChat(
  chatId: string,
  chats: readonly Pick<Chat, 'id'>[] | undefined,
  bots: readonly Pick<Bot, 'chatId'>[] | undefined,
): boolean {
  if (!chats || !bots) return false;
  return !chats.some((c) => c.id === chatId) && !bots.some((b) => b.chatId === chatId);
}

/** A group's name: its title, or its Bots' names. */
export function groupTitle(chat: Chat, bots: readonly Pick<Bot, 'id' | 'name'>[] = []): string {
  if (chat.title?.trim()) return chat.title.trim();
  const byId = new Map(bots.map((b) => [b.id, b.name]));
  const names = chat.botIds.flatMap((id) => byId.get(id) ?? []);
  if (!names.length) return 'Group';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Starts a group and refreshes the chat list. */
export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { botIds: string[]; title?: string }) =>
      unwrap(api.POST('/api/v1/chats', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey }),
  });
}

/** Takes a Bot out of a group and refreshes the chat list (C4). */
export function useRemoveMember(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (botId: string) =>
      unwrap(
        api.DELETE('/api/v1/chats/{id}/members/{botId}', {
          params: { path: { id: chatId, botId } },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey }),
  });
}
