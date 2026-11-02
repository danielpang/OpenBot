import { unwrap, type components } from '@openbots/api-client';
import type { AvatarParams } from '@openbots/avatars';
import type { WsEventOf } from '@openbots/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';

export type Bot = components['schemas']['Bot'];

export const botsQuery = queryOptions({
  queryKey: ['bots'],
  queryFn: () => unwrap(api.GET('/api/v1/bots')),
});

/**
 * Opening a Bot (B4). The server creates the transcript if it is missing and
 * clears a `blocked` Bot back to idle, so the Bot view fetches it afresh each
 * time a Bot is opened, never on hover.
 */
export const botChatQuery = (botId: string) =>
  queryOptions({
    queryKey: ['bot-chat', botId],
    queryFn: () => unwrap(api.GET('/api/v1/bots/{id}/chat', { params: { path: { id: botId } } })),
    staleTime: Infinity,
  });

export interface Roster {
  pinned: Bot[];
  bots: Bot[];
  hidden: Bot[];
}

/** Sidebar sections (B1): pinned first, then the rest, oldest first; hidden Bots kept apart. */
export function rosterSections(items: readonly Bot[]): Roster {
  const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    pinned: ordered.filter((bot) => bot.pinned && !bot.hidden),
    bots: ordered.filter((bot) => !bot.pinned && !bot.hidden),
    hidden: ordered.filter((bot) => bot.hidden),
  };
}

/** The other Bots' generated avatars, so a new or shuffled avatar does not look like one of them. */
export function takenAvatars(items: readonly Bot[], except?: string): AvatarParams[] {
  return items.flatMap((bot) =>
    bot.id !== except && bot.avatar.kind === 'generated' ? [bot.avatar] : [],
  );
}

/** Applies a `bot.state` event to the cached roster (I2, I3). */
export function applyBotState(items: readonly Bot[], event: WsEventOf<'bot.state'>): Bot[] {
  const { botId, state, currentAction, runId, currentTool = null } = event.payload;
  return items.map((bot) =>
    bot.id === botId
      ? {
          ...bot,
          state: {
            ...bot.state,
            state,
            currentAction,
            runId,
            currentTool,
            updatedAt: new Date(event.ts).toISOString(),
          },
        }
      : bot,
  );
}

/**
 * The roster's hover text (I3, plan 6.2): the current label while the Bot is
 * working, and what it waits on or what stopped it ("Waiting for approval:
 * send email", "GitHub needs login"), so hovering explains the avatar's
 * motion. Null while idle, thinking or done.
 */
export function hoverAction(state: Pick<Bot['state'], 'state' | 'currentAction'>): string | null {
  return state.state === 'working' || state.state === 'waiting' || state.state === 'blocked'
    ? state.currentAction
    : null;
}

type BotAction = 'pin' | 'unpin' | 'hide' | 'unhide';

type UpdateBot = components['schemas']['UpdateBot'];

export const updateBot = (id: string, body: UpdateBot) =>
  unwrap(api.PATCH('/api/v1/bots/{id}', { params: { path: { id } }, body }));

/** Roster and profile actions; every one refreshes the roster. */
export function useBotActions() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
  const toggle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: BotAction }) => {
      const params = { params: { path: { id } } };
      switch (action) {
        case 'pin':
          return unwrap(api.POST('/api/v1/bots/{id}/pin', params));
        case 'unpin':
          return unwrap(api.POST('/api/v1/bots/{id}/unpin', params));
        case 'hide':
          return unwrap(api.POST('/api/v1/bots/{id}/hide', params));
        case 'unhide':
          return unwrap(api.POST('/api/v1/bots/{id}/unhide', params));
      }
    },
    onSuccess,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/v1/bots/{id}/duplicate', { params: { path: { id } } })),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/bots/{id}', { params: { path: { id } } })),
    onSuccess,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateBot }) => updateBot(id, body),
    onSuccess,
  });
  return { toggle, duplicate, remove, update };
}
