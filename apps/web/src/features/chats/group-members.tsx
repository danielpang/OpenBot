import { Avatar } from '@openbots/avatars/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@openbots/ui';
import type { Bot } from '../bots/queries.js';
import { GROUP_MIN } from './api.js';

// A group's members menu (C4): the Bots in the group, each of which can be
// removed while two or more stay. Bots join by being mentioned with `@`.

export function GroupMembers({
  members,
  onRemove,
  removing,
  defaultOpen,
}: {
  members: readonly Bot[];
  onRemove(bot: Bot): void;
  /** The Bot being removed, while the request runs. */
  removing?: string | null;
  /** For tests: render with the menu open. */
  defaultOpen?: boolean;
}) {
  const atMinimum = members.length <= GROUP_MIN;
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        className="ml-auto flex items-center gap-1 rounded-md p-1 hover:bg-accent"
        aria-label="Bots in the group"
      >
        {members.map((bot) => (
          <Avatar
            key={bot.id}
            params={bot.avatar}
            state={bot.state.state}
            size={24}
            label={bot.name}
          />
        ))}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Bots in the group</DropdownMenuLabel>
        {members.map((bot) => (
          <DropdownMenuItem
            key={bot.id}
            disabled={atMinimum || removing === bot.id}
            onSelect={() => onRemove(bot)}
          >
            <Avatar params={bot.avatar} state={bot.state.state} size={20} label={bot.name} />
            <span className="min-w-0 flex-1 truncate">
              {bot.name} <span className="text-muted-foreground">@{bot.handle}</span>
            </span>
            <span className="text-xs text-destructive">Remove</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {atMinimum
            ? `A group keeps at least ${GROUP_MIN} Bots. Mention another Bot with @ to add it.`
            : 'Mention a Bot with @ to add it.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
