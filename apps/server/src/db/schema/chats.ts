import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bots } from './bots.js';
import { createdAt, id, timestamptz, updatedAt } from './columns.js';
import { runs } from './runs.js';
import { workspaceId } from './workspace.js';

// Plan 4.2: Chats and messages (C1 to C9).

export const chatType = pgEnum('chat_type', ['bot_dm', 'group', 'bot_to_bot']);

/** A chat member, reactor, or other "user or Bot" reference. */
export const participantType = pgEnum('participant_type', ['user', 'bot']);

export const messageAuthorType = pgEnum('message_author_type', [
  'user',
  'bot',
  'system',
  'webhook',
  'routine',
]);

export const messageStatus = pgEnum('message_status', ['complete', 'streaming', 'failed']);

export const chats = pgTable(
  'chats',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    type: chatType('type').notNull(),
    /**
     * `bot_dm`: the Bot whose transcript this is. `bot_to_bot`: the lower of the
     * two Bot ids, with the higher in `peer_bot_id`, so each unordered pair has
     * one row. Null for groups.
     */
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    peerBotId: uuid('peer_bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    title: text('title'),
    settings: jsonb('settings').notNull().default({}),
    summary: text('summary'),
    summaryThroughSeq: bigint('summary_through_seq', { mode: 'number' }),
    /**
     * Last seq handed out in this chat, for `messages.seq` and
     * `messages.updated_seq`; advanced by `nextSeq()` and the
     * `messages_updated_seq` triggers.
     */
    chatSeq: bigint('chat_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // B4: one transcript per (owner, Bot).
    uniqueIndex('chats_bot_dm_unique')
      .on(t.ownerId, t.botId)
      .where(sql`${t.type} = 'bot_dm'`),
    // C6: one chat per unordered Bot pair.
    uniqueIndex('chats_bot_to_bot_unique')
      .on(t.botId, t.peerBotId)
      .where(sql`${t.type} = 'bot_to_bot'`),
    check(
      'chats_bots_match_type',
      sql`case ${t.type}
        when 'bot_dm' then ${t.botId} is not null and ${t.peerBotId} is null
        when 'bot_to_bot' then ${t.botId} is not null and ${t.peerBotId} is not null and ${t.botId} < ${t.peerBotId}
        else ${t.botId} is null and ${t.peerBotId} is null
      end`,
    ),
  ],
);

/** Group cap is enforced in code (B8). */
export const chatMembers = pgTable(
  'chat_members',
  {
    id: id(),
    workspaceId: workspaceId(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    memberType: participantType('member_type').notNull(),
    memberId: uuid('member_id').notNull(),
    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.chatId, t.memberType, t.memberId)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    workspaceId: workspaceId(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** Per-chat, monotonic; from `nextSeq()` in the inserting transaction. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    threadRootId: uuid('thread_root_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'cascade',
    }),
    authorType: messageAuthorType('author_type').notNull(),
    authorId: uuid('author_id'),
    /** Ordered text, image, file, tool_call, tool_result, reasoning, widget, event, artifact, skill_ref parts. */
    parts: jsonb('parts').notNull().default([]),
    mentions: uuid('mentions').array().notNull().default([]),
    mentionEveryone: boolean('mention_everyone').notNull().default(false),
    runId: uuid('run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    status: messageStatus('status').notNull().default('complete'),
    /** The last `message.delta` folded into `parts` while streaming (plan 5.5). */
    deltaSeq: integer('delta_seq').notNull().default(0),
    /**
     * A chat seq taken when the message last changed for a reader (plan 14.2):
     * `seq` on insert, then a fresh one from the chat's counter when it
     * completes or its mentions, widget states or reactions change. Database
     * triggers keep it (migration `messages_updated_seq`), so every writer
     * counts; resync returns the messages changed after a client's seq.
     */
    updatedSeq: bigint('updated_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // The unique index also serves reads by (chat_id, seq): pages.
    unique().on(t.chatId, t.seq),
    index('messages_chat_updated_seq').on(t.chatId, t.updatedSeq),
    index('messages_thread_seq')
      .on(t.threadRootId, t.seq)
      .where(sql`${t.threadRootId} is not null`),
  ],
);

/**
 * Messages deleted from a chat, for resync (plan 14.2): a streaming Bot
 * message removed before it showed anything, because its worker lost the
 * run to another (K4) or the run ended first (`discardIfEmpty`). `seq` is
 * the chat seq taken when it was deleted, so a client that missed
 * `message.deleted` drops the message on its next resync.
 */
export const messageDeletions = pgTable(
  'message_deletions',
  {
    messageId: uuid('message_id').primaryKey(),
    workspaceId: workspaceId(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** The deleted message's own seq and thread, for correcting a thread's reply count. */
    messageSeq: bigint('message_seq', { mode: 'number' }).notNull(),
    threadRootId: uuid('thread_root_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('message_deletions_chat_seq').on(t.chatId, t.seq)],
);

export const reactions = pgTable(
  'reactions',
  {
    id: id(),
    workspaceId: workspaceId(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    reactorType: participantType('reactor_type').notNull(),
    reactorId: uuid('reactor_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.messageId, t.reactorType, t.reactorId, t.emoji)],
);

/** Interactive widget state and which run is waiting on it (W2). */
export const widgetStates = pgTable(
  'widget_states',
  {
    id: id(),
    workspaceId: workspaceId(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    partIndex: integer('part_index').notNull(),
    state: jsonb('state').notNull().default({}),
    pendingRunId: uuid('pending_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.messageId, t.partIndex)],
);
