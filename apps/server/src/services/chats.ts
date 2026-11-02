import type { TranscriptMessage } from '@openbots/agent';
import { botPair } from '@openbots/router';
import { handleFromName, type MessagePart } from '@openbots/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { assertChatOwner, ownedBotIds } from '../ownership.js';
import { organizationSettings } from '../workspace.js';
import { postMessage, type ChatRow } from './messages.js';

// Group and Bot-to-Bot chats (plan 4.2, 7; C4, C6, B8). A group is the owner
// plus two to six of their Bots (the cap is the admin-adjustable
// `botsPerGroup`); Bots join at creation, from `POST /chats/:id/members`, or
// when the owner @mentions one mid-conversation. A `bot_to_bot` chat is one
// per unordered Bot pair, created by the first `message_bot` between them.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ChatsDeps = Pick<AppDeps, 'db' | 'infra' | 'logger' | 'config'>;
type BotRow = typeof schema.bots.$inferSelect;

export const MIN_GROUP_BOTS = 2;

export const groupSize = (max: number) =>
  new DomainError(400, 'GROUP_SIZE', `A group chat holds ${MIN_GROUP_BOTS} to ${max} Bots`);
export const groupFull = (max: number) =>
  new DomainError(409, 'GROUP_FULL', `A group chat holds at most ${max} Bots`);
export const groupTooSmall = () =>
  new DomainError(409, 'GROUP_TOO_SMALL', `A group chat keeps at least ${MIN_GROUP_BOTS} Bots`);
export const notAGroup = () =>
  new DomainError(400, 'NOT_A_GROUP', 'Members can only change in a group chat');

async function botsPerGroup(deps: ChatsDeps, workspaceId: string) {
  return (await organizationSettings(deps, workspaceId)).limits.botsPerGroup;
}

/** The ids of the chat's Bots: its one Bot, its pair, or its members in join order. */
export async function chatBotIds(db: Db, chat: ChatRow): Promise<string[]> {
  if (chat.type === 'bot_dm') return chat.botId ? [chat.botId] : [];
  if (chat.type === 'bot_to_bot') return [chat.botId!, chat.peerBotId!];
  const rows = await db
    .select({ id: schema.chatMembers.memberId })
    .from(schema.chatMembers)
    .where(and(eq(schema.chatMembers.chatId, chat.id), eq(schema.chatMembers.memberType, 'bot')))
    .orderBy(asc(schema.chatMembers.joinedAt), asc(schema.chatMembers.id));
  return rows.map((r) => r.id);
}

/** The chat's Bots as rows, in `chatBotIds` order. */
export async function chatBots(db: Db, chat: ChatRow): Promise<BotRow[]> {
  const ids = await chatBotIds(db, chat);
  if (!ids.length) return [];
  const rows = await db.select().from(schema.bots).where(inArray(schema.bots.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The Bot a group thread is about (C7): the member Bot that wrote its root.
 * A result, an approval request and a question each sit in their Bot's own
 * message. Null at the top level, outside a group, for the owner's root, or
 * when that Bot has left the chat.
 */
export async function threadBotId(
  db: Db,
  chat: ChatRow,
  thread: string | null,
): Promise<string | null> {
  if (!thread || chat.type !== 'group') return null;
  const [root] = await db
    .select({ authorId: schema.messages.authorId })
    .from(schema.messages)
    .innerJoin(
      schema.chatMembers,
      and(
        eq(schema.chatMembers.chatId, schema.messages.chatId),
        eq(schema.chatMembers.memberType, 'bot'),
        eq(schema.chatMembers.memberId, schema.messages.authorId),
      ),
    )
    .where(
      and(
        eq(schema.messages.id, thread),
        eq(schema.messages.chatId, chat.id),
        eq(schema.messages.authorType, 'bot'),
      ),
    );
  return root?.authorId ?? null;
}

export async function getChat(db: Db, chatId: string): Promise<ChatRow> {
  const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, chatId));
  if (!chat) throw notFound('Chat not found');
  return chat;
}

/** One millisecond apart, so Bots added together keep the order they were given in. */
function joinTimes(n: number): Date[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => new Date(now + i));
}

/** Serializes membership changes in a chat, so the cap holds. */
async function lockChat(db: Db, chatId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-members:${chatId}`}))`);
}

/** `POST /chats` (C4): a group of the owner and 2 to `botsPerGroup` of their Bots. */
export async function createGroup(
  deps: ChatsDeps,
  owner: Owner,
  input: { botIds: string[]; title?: string | null },
): Promise<ChatRow> {
  const botIds = [...new Set(input.botIds)];
  const max = await botsPerGroup(deps, owner.workspaceId);
  if (botIds.length < MIN_GROUP_BOTS || botIds.length > max) throw groupSize(max);
  const owned = await ownedBotIds(deps.db, owner, botIds);
  if (owned.size !== botIds.length) throw notFound('Bot not found');
  return deps.db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(schema.chats)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        type: 'group',
        title: input.title?.trim() || null,
      })
      .returning();
    const joinedAt = joinTimes(botIds.length);
    await tx.insert(schema.chatMembers).values([
      { workspaceId: owner.workspaceId, chatId: chat!.id, memberType: 'user', memberId: owner.id },
      ...botIds.map((memberId, i) => ({
        workspaceId: owner.workspaceId,
        chatId: chat!.id,
        memberType: 'bot' as const,
        memberId,
        joinedAt: joinedAt[i],
      })),
    ]);
    return chat!;
  });
}

/**
 * Adds Bots to a group (C4) and posts a "joined" event row for each new one.
 * Already-present Bots are ignored; going over the cap adds none.
 */
export async function addMembers(
  deps: ChatsDeps,
  owner: Owner,
  chatId: string,
  botIds: string[],
): Promise<string[]> {
  await assertChatOwner(deps.db, owner, chatId);
  const chat = await getChat(deps.db, chatId);
  if (chat.type !== 'group') throw notAGroup();
  const wanted = [...new Set(botIds)];
  const owned = await ownedBotIds(deps.db, owner, wanted);
  if (owned.size !== wanted.length) throw notFound('Bot not found');
  const max = await botsPerGroup(deps, owner.workspaceId);
  const added = await deps.db.transaction(async (tx) => {
    await lockChat(tx, chatId);
    const present = new Set(await chatBotIds(tx, chat));
    const fresh = wanted.filter((id) => !present.has(id));
    if (present.size + fresh.length > max) throw groupFull(max);
    if (fresh.length) {
      const joinedAt = joinTimes(fresh.length);
      await tx.insert(schema.chatMembers).values(
        fresh.map((memberId, i) => ({
          workspaceId: chat.workspaceId,
          chatId,
          memberType: 'bot' as const,
          memberId,
          joinedAt: joinedAt[i],
        })),
      );
    }
    return fresh;
  });
  await announceMembers(deps, chat, added, 'joined');
  return added;
}

/** Removes a Bot from a group; a group keeps at least two. */
export async function removeMember(
  deps: ChatsDeps,
  owner: Owner,
  chatId: string,
  botId: string,
): Promise<void> {
  await assertChatOwner(deps.db, owner, chatId);
  const chat = await getChat(deps.db, chatId);
  if (chat.type !== 'group') throw notAGroup();
  const removed = await deps.db.transaction(async (tx) => {
    await lockChat(tx, chatId);
    const present = await chatBotIds(tx, chat);
    if (!present.includes(botId)) throw notFound('Bot not found in this chat');
    if (present.length <= MIN_GROUP_BOTS) throw groupTooSmall();
    await tx
      .delete(schema.chatMembers)
      .where(
        and(
          eq(schema.chatMembers.chatId, chatId),
          eq(schema.chatMembers.memberType, 'bot'),
          eq(schema.chatMembers.memberId, botId),
        ),
      );
    return [botId];
  });
  await announceMembers(deps, chat, removed, 'left');
}

async function announceMembers(
  deps: ChatsDeps,
  chat: ChatRow,
  botIds: string[],
  change: 'joined' | 'left',
) {
  if (!botIds.length) return;
  const bots = await deps.db
    .select({ id: schema.bots.id, handle: schema.bots.handle })
    .from(schema.bots)
    .where(inArray(schema.bots.id, botIds));
  for (const bot of bots) {
    await postMessage(deps, chat.id, {
      authorType: 'system',
      parts: [
        {
          type: 'event',
          kind: change === 'joined' ? 'member_joined' : 'member_left',
          text: `@${bot.handle} ${change} the chat`,
          data: { botId: bot.id },
        },
      ],
    });
  }
}

/**
 * Bots the owner @mentioned in a group they are not in yet (C4): added when
 * the group has room; otherwise an event row says why not.
 */
export async function addMentionedBots(
  deps: ChatsDeps,
  chat: ChatRow,
  mentions: string[],
): Promise<void> {
  if (chat.type !== 'group' || !mentions.length) return;
  const present = new Set(await chatBotIds(deps.db, chat));
  const missing = mentions.filter((id) => !present.has(id));
  if (!missing.length) return;
  const owner = { id: chat.ownerId, workspaceId: chat.workspaceId };
  try {
    await addMembers(deps, owner, chat.id, missing);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'GROUP_FULL') throw error;
    await postMessage(deps, chat.id, {
      authorType: 'system',
      parts: [
        { type: 'event', kind: 'group_full', text: error.message, data: { botIds: missing } },
      ],
    });
  }
}

/** The pair's `bot_to_bot` chat (C6), created on first use; owned by the Bots' owner. */
export async function botPairChat(db: Db, a: BotRow, b: BotRow): Promise<ChatRow> {
  const [botId, peerBotId] = botPair(a.id, b.id);
  const find = () =>
    db
      .select()
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.type, 'bot_to_bot'),
          eq(schema.chats.botId, botId),
          eq(schema.chats.peerBotId, peerBotId),
        ),
      );
  let [chat] = await find();
  if (!chat) {
    await db
      .insert(schema.chats)
      .values({
        workspaceId: a.workspaceId,
        ownerId: a.ownerId,
        type: 'bot_to_bot',
        botId,
        peerBotId,
      })
      .onConflictDoNothing();
    [chat] = await find();
  }
  return chat!;
}

// Transcripts as a Bot reads them (plan 5.3)

/** Who is who in a chat, by handle: the owner and every Bot that has written there. */
export interface ChatHandles {
  owner: string;
  /** Bot id to handle. */
  bots: Map<string, string>;
}

/** Handles for the chat's owner and the given Bots (members, and authors who may have left). */
export async function chatHandles(
  db: Db,
  chat: ChatRow,
  botIds: Iterable<string | null> = [],
): Promise<ChatHandles> {
  const [owner] = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, chat.ownerId));
  const ids = [...new Set(botIds)].filter((id): id is string => Boolean(id));
  const bots = ids.length
    ? await db
        .select({ id: schema.bots.id, handle: schema.bots.handle })
        .from(schema.bots)
        .where(inArray(schema.bots.id, ids))
    : [];
  return {
    owner: handleFromName(owner?.name ?? 'owner') || 'owner',
    bots: new Map(bots.map((b) => [b.id, b.handle])),
  };
}

/** A transcript row with its author as the agent's prefix wants it; `self` marks the reader's own. */
export function transcriptMessage(
  row: typeof schema.messages.$inferSelect,
  self: Pick<BotRow, 'id' | 'handle'> | null,
  handles: ChatHandles,
): TranscriptMessage {
  const parts = row.parts as MessagePart[];
  switch (row.authorType) {
    case 'user':
      return { seq: row.seq, author: { kind: 'owner', handle: handles.owner }, parts };
    case 'bot':
      return row.authorId === self?.id
        ? { seq: row.seq, author: { kind: 'bot', handle: self.handle, self: true }, parts }
        : {
            seq: row.seq,
            author: { kind: 'bot', handle: handles.bots.get(row.authorId ?? '') ?? 'a-bot' },
            parts,
          };
    default:
      return { seq: row.seq, author: { kind: row.authorType }, parts };
  }
}

/** `chatBotIds` for many chats at once, for listings. */
export async function botIdsByChat(db: Db, chats: ChatRow[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const groups = chats.filter((c) => c.type === 'group').map((c) => c.id);
  const rows = groups.length
    ? await db
        .select({ chatId: schema.chatMembers.chatId, id: schema.chatMembers.memberId })
        .from(schema.chatMembers)
        .where(
          and(inArray(schema.chatMembers.chatId, groups), eq(schema.chatMembers.memberType, 'bot')),
        )
        .orderBy(asc(schema.chatMembers.joinedAt), asc(schema.chatMembers.id))
    : [];
  for (const chat of chats) {
    if (chat.type === 'group') out.set(chat.id, []);
    else
      out.set(
        chat.id,
        [chat.botId, chat.peerBotId].filter((id): id is string => Boolean(id)),
      );
  }
  for (const row of rows) out.get(row.chatId)!.push(row.id);
  return out;
}
