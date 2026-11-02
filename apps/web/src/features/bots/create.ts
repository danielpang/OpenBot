import { unwrap, type components } from '@openbots/api-client';
import { newBotAvatar, type AvatarParams, type GeneratedAvatar } from '@openbots/avatars';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { botsQuery } from './queries.js';

// Creating a Bot (B2): a name and an icon, nothing else. Everything else has
// defaults and is editable in Settings. The server opens the new Bot's chat
// with its own message asking what to work on, so the owner's answer is how
// it learns its job.

type CreateBot = components['schemas']['CreateBot'];

/** A new Bot's starting icon: one of Moon, Box or Egg, unlike the rest of the roster. */
export function startingAvatar(
  taken: readonly AvatarParams[] = [],
  seed: string = crypto.randomUUID(),
): GeneratedAvatar {
  return newBotAvatar(seed, taken);
}

/** The `POST /bots` body: the name and the picked icon. */
export function createBotBody(name: string, avatar: GeneratedAvatar): CreateBot {
  return { name: name.trim(), avatar };
}

export interface NewBot {
  name: string;
  avatar: GeneratedAvatar;
}

export function useCreateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, avatar }: NewBot) =>
      unwrap(api.POST('/api/v1/bots', { body: createBotBody(name, avatar) })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  });
}
