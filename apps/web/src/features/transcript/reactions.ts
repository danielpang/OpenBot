import type { Message, Reaction } from './api.js';

// Reactions (C8): small acknowledgements on a message, from the owner or a
// Bot. A transcript holds them by message: seeded from the messages it reads,
// then kept current by `reaction.added` and `reaction.removed` events and the
// owner's own adds and removes.

/** Reactions by message id. */
export type Reactions = Record<string, Reaction[]>;

/** The picker's choices. */
export const REACTION_EMOJI = ['👍', '❤️', '🎉', '👀', '✅', '😄'] as const;

const same = (a: Reaction, b: Reaction) =>
  a.emoji === b.emoji && a.reactorType === b.reactorType && a.reactorId === b.reactorId;

export function withReaction(reactions: Reactions, reaction: Reaction): Reactions {
  const list = reactions[reaction.messageId] ?? [];
  if (list.some((r) => same(r, reaction))) return reactions;
  return { ...reactions, [reaction.messageId]: [...list, reaction] };
}

/** Takes the reactions read messages carry; a read is the server's state, so it replaces what was held. */
export function seedReactions(reactions: Reactions, messages: readonly Message[]): Reactions {
  const read = messages.filter((m) => m.reactions);
  if (!read.length) return reactions;
  const next = { ...reactions };
  for (const m of read) next[m.id] = m.reactions!.map((r) => ({ ...r, messageId: m.id }));
  return next;
}

export function withoutReaction(reactions: Reactions, reaction: Reaction): Reactions {
  const list = reactions[reaction.messageId];
  if (!list?.some((r) => same(r, reaction))) return reactions;
  return { ...reactions, [reaction.messageId]: list.filter((r) => !same(r, reaction)) };
}

export interface ReactionChip {
  emoji: string;
  count: number;
  /** The owner reacted with it, so clicking the chip takes it back. */
  mine: boolean;
  reactors: Reaction[];
}

/** One chip per emoji, in the order each was first used. */
export function reactionChips(list: readonly Reaction[] | undefined): ReactionChip[] {
  const chips = new Map<string, ReactionChip>();
  for (const reaction of list ?? []) {
    const chip = chips.get(reaction.emoji) ?? {
      emoji: reaction.emoji,
      count: 0,
      mine: false,
      reactors: [],
    };
    chips.set(reaction.emoji, chip);
    chip.count++;
    chip.reactors.push(reaction);
    if (reaction.reactorType === 'user') chip.mine = true;
  }
  return [...chips.values()];
}
