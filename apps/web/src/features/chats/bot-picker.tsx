import { Avatar } from '@openbots/avatars/react';
import { cn } from '@openbots/ui';
import type { Bot } from '../bots/queries.js';
import { GROUP_MIN } from './api.js';

// Picking the Bots of a new group (C4, PRD section 5 "New chat"): two to the
// group limit (six by default, B8). Once the limit is reached the other Bots
// cannot be ticked until one is unticked.

export interface PickState {
  /** Enough Bots to start the group. */
  ready: boolean;
  /** Room for another Bot. */
  room: boolean;
  hint: string;
}

export function pickState(count: number, limit: number): PickState {
  const ready = count >= GROUP_MIN && count <= limit;
  const room = count < limit;
  const hint =
    count === 0
      ? `Pick ${GROUP_MIN} to ${limit} Bots.`
      : count < GROUP_MIN
        ? `Pick at least ${GROUP_MIN - count} more.`
        : room
          ? `${count} picked; up to ${limit}.`
          : `${count} picked, the most a group holds.`;
  return { ready, room, hint };
}

export function BotPicker({
  bots,
  selected,
  limit,
  onChange,
}: {
  bots: readonly Bot[];
  selected: readonly string[];
  limit: number;
  onChange(selected: string[]): void;
}) {
  const { room, hint } = pickState(selected.length, limit);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">Bots in the group</legend>
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {bots.map((bot) => {
          const checked = selected.includes(bot.id);
          const disabled = !checked && !room;
          return (
            <li key={bot.id}>
              <label
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
                  disabled && 'opacity-50 hover:bg-transparent',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, bot.id]
                        : selected.filter((id) => id !== bot.id),
                    )
                  }
                />
                <Avatar params={bot.avatar} size={20} />
                <span className="truncate">{bot.name}</span>
                {bot.label && (
                  <span className="truncate text-xs text-muted-foreground">{bot.label}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" role="status">
        {hint}
      </p>
    </fieldset>
  );
}
