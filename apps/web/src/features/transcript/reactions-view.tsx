import { cn, SmilePlusIcon } from '@openbots/ui';
import { useState } from 'react';
import type { Reaction } from './api.js';
import { REACTION_EMOJI, type ReactionChip } from './reactions.js';

// Reactions under a message (C8): one chip per emoji with its count, the
// owner's own marked and taken back by a click, and a small picker of a few
// emoji behind "React". Who reacted shows on hover.

export function ReactionChips({
  chips,
  reactorName,
  onToggle,
}: {
  chips: ReactionChip[];
  reactorName(reaction: Reaction): string;
  onToggle?(emoji: string, on: boolean): void;
}) {
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Reactions">
      {chips.map((chip) => (
        <li key={chip.emoji}>
          <button
            type="button"
            aria-pressed={chip.mine}
            disabled={!onToggle}
            title={chip.reactors.map(reactorName).join(', ')}
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
              chip.mine ? 'border-foreground/30 bg-accent' : 'text-muted-foreground',
              onToggle && 'hover:bg-accent',
            )}
            onClick={() => onToggle?.(chip.emoji, !chip.mine)}
          >
            <span>{chip.emoji}</span>
            <span>{chip.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A message's hover actions are 28 px ghost icons. */
export const ACTION_ICON =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none [&_svg]:size-4 data-[state=open]:bg-accent data-[state=open]:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground';

/** The React icon and the picker it opens. */
export function ReactButton({ onPick }: { onPick(emoji: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-label="React"
        title="React"
        aria-expanded={open}
        className={ACTION_ICON}
        onClick={() => setOpen(!open)}
      >
        <SmilePlusIcon />
      </button>
      {open && (
        <span
          role="listbox"
          aria-label="Pick a reaction"
          className="absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-lg border bg-popover p-1 shadow-md"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`React with ${emoji}`}
              className="rounded px-1 text-base hover:bg-accent"
              onClick={() => {
                setOpen(false);
                onPick(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
