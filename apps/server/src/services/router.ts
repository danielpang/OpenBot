import { toModelMessages, type BotMessenger } from '@openbots/agent';
import {
  chainLimitsFor,
  loopStoppedDetail,
  routeTargets,
  SHOULD_REPLY_WINDOW,
  shouldReply,
  withinChainLimits,
  type RouteTrigger,
} from '@openbots/router';
import { ModelConfigSchema, parseMentions, PRIORITY, type MessagePart } from '@openbots/shared';
import type { LanguageModel } from 'ai';
import { and, count, desc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { toMessage, type Message } from '../schemas.js';
import {
  addMentionedBots,
  botPairChat,
  chatBots,
  chatHandles,
  getChat,
  threadBotId,
  transcriptMessage,
} from './chats.js';
import { postMessage, setMentions, type ChatRow } from './messages.js';
import { providerRegistry, smallModelFor } from './providers.js';
import { botsAtWork, dropQueuedHandoffs, startRoutedRun, type RoutedRunOutcome } from './runs.js';

// The router (plan 7; C4 to C6). `routeMessage` decides who answers a message
// in a group or Bot-to-Bot chat with `routeTargets` from @openbots/router, asks
// each undecided Bot's small model (`shouldReply`), applies the loop guards and
// starts the runs. When no Bot could decide (the small model fails or cannot
// be resolved), an event row says so, at most once an hour per chat. Owner messages arrive through the `onUserMessage` hook
// (runs.ts); a Bot's finished reply through `routeBotReply` (the run worker);
// `message_bot` posts into the pair's chat and routes at once.

type RouterDeps = Pick<AppDeps, 'db' | 'infra' | 'logger' | 'config'>;
type BotRow = typeof schema.bots.$inferSelect;

export interface RouterOptions {
  /**
   * The model a Bot's `shouldReply` runs on. Defaults to its provider's small
   * model (plan 5.9), or the Bot's own model when the provider has none.
   */
  replyModel?: (bot: BotRow) => Promise<LanguageModel | null>;
}

export interface RoutedTarget {
  botId: string;
  trigger: RouteTrigger;
  outcome: RoutedRunOutcome['kind'] | 'stopped';
  runId: string | null;
}

/** How often a chat shows that its Bots could not decide who replies. */
const UNDECIDED_NOTICE = { window: 60 * 60, max: 1 };

export async function routeMessage(
  deps: RouterDeps,
  message: Message,
  options: RouterOptions = {},
): Promise<RoutedTarget[]> {
  const chat = await getChat(deps.db, message.chatId);
  // A Bot's transcript is the run hooks' (plan 5.1, 5.2).
  if (chat.type === 'bot_dm') return [];
  if (message.authorType === 'user') await addMentionedBots(deps, chat, message.mentions);
  const bots = await chatBots(deps.db, chat);

  let recent: Promise<{ owner: string; lines: string[] }> | null = null;
  const undecided = { asked: 0, failed: 0 };
  const decide = async (botId: string) => {
    undecided.asked += 1;
    const bot = bots.find((b) => b.id === botId)!;
    const model = await replyModelFor(deps, bot, options);
    if (!model) {
      undecided.failed += 1;
      return false;
    }
    recent ??= recentLines(deps.db, chat, bots, message.threadRootId);
    const { owner, lines } = await recent;
    const decision = await shouldReply({
      model,
      bot: { handle: bot.handle, name: bot.name, label: bot.label, description: bot.description },
      roster: [
        { handle: owner, kind: 'owner' },
        ...bots
          .filter((b) => b.id !== bot.id)
          .map((b) => ({ handle: b.handle, label: b.label, kind: 'bot' as const })),
      ],
      recent: lines,
    });
    if (decision.error) {
      undecided.failed += 1;
      deps.logger.warn({ botId, chatId: chat.id, error: decision.error }, 'shouldReply failed');
    } else {
      deps.logger.debug({ botId, chatId: chat.id, ...decision }, 'shouldReply');
    }
    return decision.reply;
  };
  // An owner's message may be for the Bot whose thread it is in (C7), or for
  // a Bot already at work there (plan 5.2), as their steering agrees.
  const byOwner = message.authorType === 'user' && chat.type === 'group';
  // The owner has moved on: handoffs still queued from earlier Bot chains in
  // this thread would answer an older message, so they are dropped before
  // routing (their Bots are then no longer at work here). The row saying so
  // is posted after it, so `shouldReply` still sees the owner's message last.
  const dropped = byOwner ? await dropQueuedHandoffs(deps, chat.id, message.threadRootId) : [];
  const targets = await routeTargets(
    { type: chat.type, botIds: bots.map((b) => b.id) },
    message,
    decide,
    byOwner
      ? {
          threadBotId: await threadBotId(deps.db, chat, message.threadRootId),
          atWork: await botsAtWork(deps.db, chat.id, message.threadRootId),
        }
      : {},
  );
  if (undecided.asked > 0 && undecided.failed === undecided.asked) {
    await postUndecidedNotice(deps, chat);
  }
  if (dropped.length) await postDroppedNotice(deps, chat, message, dropped);
  if (!targets.length) return [];

  // Loop guards (plan 7): one link deeper than the run that wrote the message,
  // and a rolling budget for runs a Bot's message starts.
  const parentRunId = message.runId;
  const [parent] = parentRunId
    ? await deps.db
        .select({ depth: schema.runs.depth })
        .from(schema.runs)
        .where(eq(schema.runs.id, parentRunId))
    : [];
  const depth = (parent?.depth ?? 0) + 1;
  const botTriggered = message.authorType === 'bot';
  const limits = chainLimitsFor(chat.settings);
  let recentBotRuns = botTriggered
    ? await botRunsSince(deps.db, chat.id, new Date(Date.now() - limits.budgetWindowMs))
    : 0;

  const routed: RoutedTarget[] = [];
  let stopped: 'depth' | 'budget' | null = null;
  for (const target of targets) {
    const check = withinChainLimits({ depth, botTriggered, recentBotRuns }, limits);
    if (!check.ok) {
      stopped ??= check.reason;
      routed.push({ ...target, outcome: 'stopped', runId: null });
      continue;
    }
    const started = await startRoutedRun(
      deps,
      {
        botId: target.botId,
        chatId: chat.id,
        trigger: target.trigger,
        // Work a Bot asks for never jumps ahead of the owner (plan 5.1).
        ...(botTriggered ? { priority: PRIORITY.normal } : {}),
        parentRunId,
        depth,
        // A message in a thread is answered in that thread (C7), and a Bot's
        // message starts a run under the rules for Bot-started runs (P2).
        ...(message.threadRootId || botTriggered
          ? {
              input: {
                ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
                ...(botTriggered && message.authorId ? { fromBotId: message.authorId } : {}),
              },
            }
          : {}),
      },
      { ownerMessage: botTriggered ? null : message },
    );
    if (botTriggered && started.kind === 'enqueued') recentBotRuns += 1;
    routed.push({ ...target, outcome: started.kind, runId: started.runId });
  }
  if (stopped) {
    await postMessage(deps, chat.id, {
      authorType: 'system',
      runId: parentRunId,
      parts: [
        {
          type: 'event',
          kind: 'loop_stopped',
          text: loopStoppedDetail(stopped, limits),
          data: {
            reason: stopped,
            depth,
            botIds: routed.filter((r) => r.outcome === 'stopped').map((r) => r.botId),
          },
        },
      ],
    });
  }
  return routed;
}

/**
 * Tells the owner that no Bot could decide whether to answer, which would
 * otherwise mute a group without a word (a missing or broken small model).
 * Rate-limited per chat; the limiter failing only skips the row.
 */
async function postUndecidedNotice(deps: RouterDeps, chat: ChatRow) {
  try {
    const { allowed } = await deps.infra.limiter.consume(
      `reply-undecided:${chat.id}`,
      UNDECIDED_NOTICE,
    );
    if (!allowed) return;
  } catch (error) {
    deps.logger.warn({ err: error, chatId: chat.id }, 'reply notice limiter failed');
    return;
  }
  const fix = 'Check the small model in Settings > Models.';
  await postMessage(deps, chat.id, {
    authorType: 'system',
    parts: [
      {
        type: 'event',
        kind: 'reply_undecided',
        text: `The Bots couldn't decide who should reply. ${fix}`,
        data: { fix, link: '/settings/models' },
      },
    ],
  });
}

/** Says in a compact event row that an owner message dropped queued handoffs. */
async function postDroppedNotice(
  deps: RouterDeps,
  chat: ChatRow,
  message: Message,
  dropped: { id: string; botId: string }[],
) {
  const n = dropped.length;
  await postMessage(deps, chat.id, {
    authorType: 'system',
    threadRootId: message.threadRootId,
    parts: [
      {
        type: 'event',
        kind: 'handoffs_dropped',
        text: `Dropped ${n} queued Bot ${n === 1 ? 'handoff' : 'handoffs'}: you sent a newer message.`,
        data: {
          runIds: dropped.map((r) => r.id),
          botIds: [...new Set(dropped.map((r) => r.botId))],
        },
      },
    ],
  });
}

/** Runs a Bot's message started in the chat since `since` (they have a parent run). */
async function botRunsSince(db: Db, chatId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.chatId, chatId),
        isNotNull(schema.runs.parentRunId),
        gt(schema.runs.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The end of the chat (or of the thread, with its root), oldest first,
 * author-prefixed, with every Bot seen from outside.
 */
async function recentLines(db: Db, chat: ChatRow, bots: BotRow[], thread: string | null) {
  const rows = (
    await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.chatId, chat.id),
          thread
            ? or(eq(schema.messages.threadRootId, thread), eq(schema.messages.id, thread))
            : isNull(schema.messages.threadRootId),
        ),
      )
      .orderBy(desc(schema.messages.seq))
      .limit(SHOULD_REPLY_WINDOW)
  ).reverse();
  const handles = await chatHandles(db, chat, [
    ...bots.map((b) => b.id),
    ...rows.map((r) => r.authorId),
  ]);
  const lines = toModelMessages(rows.map((r) => transcriptMessage(r, null, handles))).map((m) =>
    typeof m.content === 'string' ? m.content : '',
  );
  return { owner: handles.owner, lines };
}

async function replyModelFor(
  deps: RouterDeps,
  bot: BotRow,
  options: RouterOptions,
): Promise<LanguageModel | null> {
  if (options.replyModel) return options.replyModel(bot);
  const config = ModelConfigSchema.safeParse(bot.modelConfig);
  if (!config.success) return null;
  try {
    const small = await smallModelFor(deps, config.data.provider_id);
    const resolved = await providerRegistry(deps).resolve(
      small ? { provider_id: config.data.provider_id, model_id: small.modelId } : config.data,
    );
    return resolved.model;
  } catch (error) {
    deps.logger.warn({ err: error, botId: bot.id }, 'no model for shouldReply');
    return null;
  }
}

/**
 * A Bot's finished reply in a group or Bot-to-Bot chat (plan 7): its
 * `@handle` mentions of the chat's other Bots are stored on the message, then
 * it is routed. A reply without text wakes nobody, which is how a Bot ends a
 * Bot-to-Bot exchange.
 */
export async function routeBotReply(
  deps: RouterDeps,
  messageId: string,
  options: RouterOptions = {},
): Promise<RoutedTarget[]> {
  const [row] = await deps.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  if (row?.authorType !== 'bot' || row.status !== 'complete') return [];
  const chat = await getChat(deps.db, row.chatId);
  if (chat.type === 'bot_dm') return [];
  const text = (row.parts as MessagePart[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  if (!text.trim()) return [];
  const { handles, everyone } = parseMentions(text);
  const bots = await chatBots(deps.db, chat);
  const mentions = bots
    .filter((b) => b.id !== row.authorId && handles.includes(b.handle.toLowerCase()))
    .map((b) => b.id);
  const message =
    mentions.length || everyone
      ? await setMentions(deps.db, row.id, mentions, everyone)
      : toMessage(row);
  return routeMessage(deps, message, options);
}

/**
 * `message_bot` for a run (C6): the text goes into the pair's `bot_to_bot`
 * chat as the sender's message, which wakes the receiver at priority 2.
 */
export function botMessenger(
  deps: RouterDeps,
  run: { id: string },
  sender: BotRow,
  options: RouterOptions = {},
): BotMessenger {
  return {
    send: async ({ handle, text }) => {
      const [receiver] = await deps.db
        .select()
        .from(schema.bots)
        .where(
          and(
            eq(schema.bots.workspaceId, sender.workspaceId),
            eq(schema.bots.ownerId, sender.ownerId),
            eq(schema.bots.handle, handle),
          ),
        );
      if (!receiver || receiver.id === sender.id) {
        throw new Error(`There is no other Bot called @${handle}`);
      }
      const chat = await botPairChat(deps.db, sender, receiver);
      const message = await postMessage(deps, chat.id, {
        authorType: 'bot',
        authorId: sender.id,
        runId: run.id,
        parts: [{ type: 'text', text }],
        mentions: [receiver.id],
      });
      const [routed] = await routeMessage(deps, message, options);
      return {
        chatId: chat.id,
        messageId: message.id,
        woke: routed !== undefined && routed.outcome !== 'stopped',
      };
    },
  };
}
