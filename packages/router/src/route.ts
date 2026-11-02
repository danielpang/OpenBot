// Who replies (plan 7; C4 to C6). A pure function of the chat's Bots and the
// message, so the server, the tests and any later client agree on it:
//
// - `bot_dm`: anything not from the Bot starts a `message` run for it.
// - `bot_to_bot`: a message from one Bot of the pair wakes the other (`bot_dm`).
// - `group`: a mention or `@everyone` addresses Bots directly (`mention`), and
//   then only the addressed Bots answer (C5: "@bot directs only the mentioned
//   Bots"). An owner's reply that mentions nobody in a thread about one Bot's
//   item (its result, approval request or question) addresses that Bot alone
//   (C7). A message that addresses nobody: from a Bot it reaches nobody
//   (Bots reach Bots only by mention or DM); from the owner it goes to every
//   Bot whose `shouldReply` says yes (`bot_message`), and to a Bot already at
//   work in that thread (or top level) without asking. Messages from the
//   system, webhooks and Routines wake nobody in a group or a Bot-to-Bot chat,
//   so an event row never starts work.
//
// `addressedBots` is the one addressing rule: routing uses it to pick the
// Bots, and a running Bot's steering (plan 5.2) uses `isForBot` to take only
// the owner messages routing would give it.

export type ChatType = 'bot_dm' | 'group' | 'bot_to_bot';
export type AuthorType = 'user' | 'bot' | 'system' | 'webhook' | 'routine';
export type RouteTrigger = 'message' | 'mention' | 'bot_message' | 'bot_dm';

export interface RouteChat {
  type: ChatType;
  /** The chat's Bots: the one Bot of a `bot_dm`, the pair of a `bot_to_bot`, a group's members. */
  botIds: string[];
}

export interface RouteMessage {
  authorType: AuthorType;
  authorId: string | null;
  /** Mentioned Bot ids. */
  mentions: string[];
  mentionEveryone: boolean;
}

export interface RouteTarget {
  botId: string;
  trigger: RouteTrigger;
}

/** Whether a Bot should answer a group message nobody addressed (C5). */
export type ShouldReplyFn = (botId: string) => Promise<boolean>;

export interface RouteContext {
  /**
   * The member Bot a thread is about, for a message in that thread: the
   * author of its root (a result, an approval request or a question). Null at
   * the top level, for the owner's own root, or when that Bot left the chat.
   */
  threadBotId?: string | null;
  /**
   * Bots with a run going in the message's thread (or top level), or waiting
   * there on a question. An owner message that addresses nobody is theirs
   * without asking, as their steering takes it (plan 5.2).
   */
  atWork?: string[];
}

/**
 * The Bots a group message addresses, out of `botIds` (C5, C7): every one for
 * `@everyone`, the mentioned ones (none when it mentions only Bots outside
 * the chat), the thread's Bot (see `RouteContext`) for a reply that mentions
 * nobody, and `null` when it addresses nobody, so the Bots decide.
 */
export function addressedBots(
  botIds: string[],
  message: Pick<RouteMessage, 'mentions' | 'mentionEveryone'>,
  threadBotId: string | null = null,
): string[] | null {
  if (message.mentionEveryone) return botIds;
  if (message.mentions.length > 0) return botIds.filter((id) => message.mentions.includes(id));
  return threadBotId ? [threadBotId] : null;
}

/**
 * Whether an owner message in a group is for a Bot that is already at work in
 * the message's thread (or top level): it addresses that Bot, or addresses
 * nobody. Steering (plan 5.2) and the follow-up after a run take only these,
 * as routing gives them only these.
 */
export function isForBot(
  botId: string,
  message: Pick<RouteMessage, 'mentions' | 'mentionEveryone'>,
  threadBotId: string | null = null,
): boolean {
  const addressed = addressedBots([botId], message, threadBotId);
  return addressed === null || addressed.includes(botId);
}

export async function routeTargets(
  chat: RouteChat,
  message: RouteMessage,
  shouldReply: ShouldReplyFn,
  context: RouteContext = {},
): Promise<RouteTarget[]> {
  const byBot = message.authorType === 'bot';
  if (chat.type === 'bot_dm') {
    const [bot] = chat.botIds;
    return bot && !byBot ? [{ botId: bot, trigger: 'message' }] : [];
  }
  if (chat.type === 'bot_to_bot') {
    if (!byBot || !message.authorId || !chat.botIds.includes(message.authorId)) return [];
    const other = chat.botIds.find((id) => id !== message.authorId);
    return other ? [{ botId: other, trigger: 'bot_dm' }] : [];
  }
  if (!byBot && message.authorType !== 'user') return [];

  const bots = chat.botIds.filter((botId) => !(byBot && message.authorId === botId));
  // A thread's Bot is the owner's to address; Bots reach Bots only by mention.
  const threadBotId =
    !byBot && context.threadBotId && bots.includes(context.threadBotId)
      ? context.threadBotId
      : null;
  const addressed = addressedBots(bots, message, threadBotId);
  if (addressed) return addressed.map((botId) => ({ botId, trigger: 'mention' as const }));
  if (byBot) return [];
  // One small call per Bot not already at work here, side by side.
  const atWork = context.atWork ?? [];
  const decided = await Promise.all(
    bots.map((botId) => atWork.includes(botId) || shouldReply(botId)),
  );
  return bots
    .filter((_, i) => decided[i])
    .map((botId) => ({ botId, trigger: 'bot_message' as const }));
}

/**
 * The stored order of a Bot pair: a `bot_to_bot` chat keeps the lower id in
 * `bot_id` and the higher in `peer_bot_id`, so each unordered pair has one row.
 */
export function botPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
