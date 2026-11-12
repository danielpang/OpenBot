import {
  parseMentions,
  wsEvent,
  type MessagePart,
  type PartDelta,
  type TextDelta,
} from '@openbots/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { nextSeq, schema, type Db } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { assertBotOwner, assertChatOwner } from '../ownership.js';
import { toMessage, type Message } from '../schemas.js';
import { clearBlockedOnOpen } from './bot-state.js';
import { chatBotIds } from './chats.js';
import { computerAvailable, wakeComputer } from './computer.js';
import { noteAttachmentChat, ownedAttachments } from './files.js';
import { runUserMessageHooks } from './hooks.js';
import { referableSkill } from './skills.js';

// Chats and messages (plan 4.2, 5.5; C1, C2, W3). Every message gets its seq
// from `nextSeq()` in the transaction that inserts it and is announced with
// `message.created`. Bot replies stream: `createStreaming` inserts an empty
// `streaming` message, `appendPart` folds parts and text deltas into it and
// publishes them as numbered `message.delta` events, `finalize` closes it with
// `message.completed`. `discardIfEmpty` deletes one that never showed anything
// instead, with `message.deleted`, when its run went on elsewhere or ended.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type MessagesDeps = Pick<AppDeps, 'db' | 'infra' | 'logger'>;

export type ChatRow = typeof schema.chats.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
type NewMessage = Omit<typeof schema.messages.$inferInsert, 'seq' | 'workspaceId'>;

export const MESSAGE_PAGE_DEFAULT = 50;
export const MESSAGE_PAGE_MAX = 200;

/** Streamed text is written and published at most this often, or at a part boundary. */
export const DELTA_FLUSH_MS = 250;

// Chats

/** The Bot's one transcript (B4), created if missing. Opening it clears `blocked` (plan 6.1). */
export async function openBotChat(
  deps: MessagesDeps,
  owner: Owner,
  botId: string,
): Promise<ChatRow> {
  await assertBotOwner(deps.db, owner, botId);
  const find = () =>
    deps.db
      .select()
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, owner.id),
          eq(schema.chats.workspaceId, owner.workspaceId),
          eq(schema.chats.botId, botId),
          eq(schema.chats.type, 'bot_dm'),
        ),
      );
  let [chat] = await find();
  if (!chat) {
    await deps.db
      .insert(schema.chats)
      .values({ workspaceId: owner.workspaceId, ownerId: owner.id, type: 'bot_dm', botId })
      .onConflictDoNothing();
    [chat] = await find();
  }
  await clearBlockedOnOpen(deps, botId);
  return chat!;
}

/** Group and Bot-to-Bot chats the owner can see (C5, C6); none exist before Phase 5. */
export async function listChats(db: Db, owner: Owner): Promise<ChatRow[]> {
  return db
    .select()
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.ownerId, owner.id),
        eq(schema.chats.workspaceId, owner.workspaceId),
        inArray(schema.chats.type, ['group', 'bot_to_bot']),
      ),
    )
    .orderBy(desc(schema.chats.updatedAt));
}

// Reading

export interface ListMessagesOptions {
  /** Only messages with a seq below this. */
  before?: number;
  limit?: number;
  /** A thread: its root and replies. Without it, top-level messages only. */
  thread?: string;
}

/** A page of messages, newest first. */
export async function listMessages(
  db: Db,
  owner: Owner,
  chatId: string,
  { before, limit = MESSAGE_PAGE_DEFAULT, thread }: ListMessagesOptions = {},
): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertChatOwner(db, owner, chatId);
  const m = schema.messages;
  const where: (SQL | undefined)[] = [eq(m.chatId, chatId)];
  if (before !== undefined) where.push(lt(m.seq, before));
  where.push(thread ? or(eq(m.threadRootId, thread), eq(m.id, thread)) : isNull(m.threadRootId));
  const rows = await db
    .select()
    .from(m)
    .where(and(...where))
    .orderBy(desc(m.seq))
    .limit(limit + 1);
  const messages = await withReadOverlays(db, rows.slice(0, limit).map(toMessage));
  return { messages, hasMore: rows.length > limit };
}

/** Everything a read adds to stored messages: widget states, reactions and reply counts. */
export async function withReadOverlays(db: Db, messages: Message[]): Promise<Message[]> {
  return withReplyCounts(db, await withReactions(db, await withWidgetStates(db, messages)));
}

/**
 * Overlays `widget_states` onto the widget parts of messages being read, so a
 * transcript loaded after an answer shows it answered. The stored parts keep
 * their initial state; the run worker and the streaming primitives stay their
 * only writers.
 */
export async function withWidgetStates(db: Db, messages: Message[]): Promise<Message[]> {
  const ids = messages.filter((m) => m.parts.some((p) => p.type === 'widget')).map((m) => m.id);
  if (!ids.length) return messages;
  const w = schema.widgetStates;
  const states = await db
    .select({ messageId: w.messageId, partIndex: w.partIndex, state: w.state })
    .from(w)
    .where(inArray(w.messageId, ids));
  if (!states.length) return messages;
  const byKey = new Map(states.map((s) => [`${s.messageId}:${s.partIndex}`, s.state]));
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((part, i) => {
      const key = `${m.id}:${i}`;
      return part.type === 'widget' && byKey.has(key) ? { ...part, state: byKey.get(key) } : part;
    }),
  }));
}

/** Adds each message's reactions, oldest first, so chips survive a reload (C8). */
export async function withReactions(db: Db, messages: Message[]): Promise<Message[]> {
  if (!messages.length) return messages;
  const r = schema.reactions;
  const rows = await db
    .select({
      messageId: r.messageId,
      emoji: r.emoji,
      reactorType: r.reactorType,
      reactorId: r.reactorId,
    })
    .from(r)
    .where(
      inArray(
        r.messageId,
        messages.map((m) => m.id),
      ),
    )
    .orderBy(asc(r.createdAt), asc(r.id));
  const byMessage = new Map<string, NonNullable<Message['reactions']>>();
  for (const { messageId, ...reaction } of rows) {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), reaction]);
  }
  return messages.map((m) => ({ ...m, reactions: byMessage.get(m.id) ?? [] }));
}

/**
 * Adds `replyCount` to top-level messages (C7), with the seq of the newest
 * reply it counts so a client can add the replies that arrive after the read.
 */
export async function withReplyCounts(db: Db, messages: Message[]): Promise<Message[]> {
  const ids = messages.filter((m) => !m.threadRootId).map((m) => m.id);
  if (!ids.length) return messages;
  const m = schema.messages;
  const rows = await db
    .select({ rootId: m.threadRootId, replies: count(), lastSeq: max(m.seq) })
    .from(m)
    .where(inArray(m.threadRootId, ids))
    .groupBy(m.threadRootId);
  const byRoot = new Map(rows.map((r) => [r.rootId, r]));
  return messages.map((message) => {
    if (message.threadRootId) return message;
    const replies = byRoot.get(message.id);
    return {
      ...message,
      replyCount: replies?.replies ?? 0,
      lastReplySeq: replies?.lastSeq ?? null,
    };
  });
}

// Writing

/** Assigns the seq, stores the message and publishes `message.created`. */
async function insertMessage(
  deps: MessagesDeps,
  chat: Pick<ChatRow, 'id' | 'workspaceId'>,
  values: NewMessage,
): Promise<Message> {
  const row = await deps.db.transaction((tx) => storeMessage(tx, chat, values));
  return announceMessage(deps, row);
}

/**
 * Assigns the seq and stores the message inside the caller's transaction, for
 * a message that must commit together with other writes; `announceMessage`
 * publishes it once that transaction has committed.
 */
export async function storeMessage(
  tx: Db,
  chat: Pick<ChatRow, 'id' | 'workspaceId'>,
  values: Omit<NewMessage, 'chatId'>,
): Promise<MessageRow> {
  const seq = await nextSeq(tx, chat.id);
  const [inserted] = await tx
    .insert(schema.messages)
    .values({ ...values, chatId: chat.id, workspaceId: chat.workspaceId, seq })
    .returning();
  return inserted!;
}

/** Publishes `message.created` for a stored message. */
export async function announceMessage(deps: MessagesDeps, row: MessageRow): Promise<Message> {
  const message = toMessage(row);
  await publishEvent(
    deps.infra.bus,
    wsEvent('message.created', { message }, scopeOf(row, row.authorType === 'bot')),
  );
  return message;
}

function scopeOf(row: Pick<MessageRow, 'chatId' | 'seq' | 'authorId'>, byBot: boolean) {
  return {
    chat_id: row.chatId,
    seq: row.seq,
    ...(byBot && row.authorId ? { bot_id: row.authorId } : {}),
  };
}

export interface UserMessageInput {
  text?: string;
  /** Uploaded file ids; images become `image` parts, the rest `file` parts. */
  attachments?: string[];
  mentionEveryone?: boolean;
  threadRootId?: string;
  skillId?: string;
}

export const emptyMessage = () =>
  new DomainError(400, 'EMPTY_MESSAGE', 'A message needs text, an attachment or a Skill');

export const invalidThread = () =>
  new DomainError(400, 'INVALID_THREAD', 'The thread root is not a top-level message in this chat');

/** An owner's message (C1): parts built from the input, `@handle` mentions resolved to Bot ids. */
export async function postUserMessage(
  deps: AppDeps,
  owner: Owner,
  chatId: string,
  input: UserMessageInput,
): Promise<Message> {
  const { db } = deps;
  await assertChatOwner(db, owner, chatId);
  const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, chatId));
  const text = input.text?.trim() ? input.text : undefined;
  const fileIds = [...new Set(input.attachments ?? [])];
  if (!text && !fileIds.length && !input.skillId) throw emptyMessage();

  if (input.threadRootId) {
    const [root] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.id, input.threadRootId),
          eq(schema.messages.chatId, chatId),
          isNull(schema.messages.threadRootId),
        ),
      );
    if (!root) throw invalidThread();
  }

  const parts: MessagePart[] = [];
  if (input.skillId) {
    // Only a Skill that is on for one of the chat's Bots (S2).
    const skill = await referableSkill(db, owner, input.skillId, await chatBotIds(db, chat!));
    parts.push({ type: 'skill_ref', skill_id: skill.id, name: skill.name });
  }
  if (text) parts.push({ type: 'text', text });
  if (fileIds.length) {
    // Only the owner's attachments: an Artifact blob, webhook body or avatar is not found.
    const files = await ownedAttachments(db, owner, fileIds);
    if (files.length !== fileIds.length) throw notFound('File not found');
    const byId = new Map(files.map((f) => [f.id, f]));
    for (const id of fileIds) {
      const f = byId.get(id)!;
      const type = f.mime.startsWith('image/') && f.mime !== 'image/svg+xml' ? 'image' : 'file';
      parts.push({ type, file_id: f.id, name: f.name, mime: f.mime, size: f.size });
    }
  }

  const mentioned = parseMentions(text ?? '');
  const mentions = mentioned.handles.length
    ? (
        await db
          .select({ id: schema.bots.id })
          .from(schema.bots)
          .where(
            and(
              eq(schema.bots.ownerId, owner.id),
              eq(schema.bots.workspaceId, owner.workspaceId),
              inArray(schema.bots.handle, mentioned.handles),
            ),
          )
      ).map((b) => b.id)
    : [];

  const message = await insertMessage(deps, chat!, {
    chatId,
    threadRootId: input.threadRootId ?? null,
    authorType: 'user',
    authorId: owner.id,
    parts,
    mentions,
    mentionEveryone: Boolean(input.mentionEveryone) || mentioned.everyone,
  });
  await noteAttachmentChat(db, fileIds, chatId);
  wakeForMessage(deps, owner, chat!);
  await runUserMessageHooks(deps, message);
  return message;
}

/**
 * An owner's message to their Bots wakes the owner's computer in the chat's
 * organization, or marks it used while it runs, so a conversation keeps it
 * awake (plan 9.5). It runs in the background: the message and the Bots'
 * replies never wait for it. Bot, webhook and Routine messages do not come
 * through here; their runs start the computer when a computer tool needs it.
 */
function wakeForMessage(deps: AppDeps, owner: Owner, chat: ChatRow) {
  if (!computerAvailable(deps)) return;
  const workspaceId = chat.workspaceId;
  inWorkspace(workspaceId, async () => {
    if (!(await chatBotIds(deps.db, chat)).length) return;
    await wakeComputer(deps, { id: owner.id, workspaceId }, { touch: true });
  }).catch((error: unknown) =>
    deps.logger.warn({ err: error, chatId: chat.id }, 'computer wake failed'),
  );
}

/** A complete message from the system, a webhook or a Routine, e.g. a W3 event row. */
export async function postMessage(
  deps: MessagesDeps,
  chatId: string,
  values: Omit<NewMessage, 'chatId'> & { parts: MessagePart[] },
): Promise<Message> {
  const [chat] = await deps.db.select().from(schema.chats).where(eq(schema.chats.id, chatId));
  if (!chat) throw notFound('Chat not found');
  return insertMessage(deps, chat, { ...values, chatId });
}

/**
 * Records whom a finished Bot message mentions (plan 7). Owner messages get
 * theirs when posted; a Bot's are known only once its text is complete.
 */
export async function setMentions(
  db: Db,
  messageId: string,
  mentions: string[],
  mentionEveryone: boolean,
): Promise<Message> {
  const [row] = await db
    .update(schema.messages)
    .set({ mentions, mentionEveryone })
    .where(eq(schema.messages.id, messageId))
    .returning();
  if (!row) throw notFound('Message not found');
  return toMessage(row);
}

// Streaming (plan 5.5)

interface Stream {
  messageId: string;
  chatId: string;
  seq: number;
  botId: string | null;
  parts: MessagePart[];
  deltaSeq: number;
  /** The text or reasoning part text deltas currently extend. */
  open: number | null;
  /** Deltas since the last flush. */
  pending: PartDelta[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Flushes run one after another so writes and events stay in deltaSeq order. */
  chain: Promise<void>;
  /** Deleted by `discardIfEmpty`: takes no more parts and writes nothing. */
  discarded?: boolean;
}

// Streams live in the process running the run. A stream missing here (another
// process, a restart) is reloaded from its row, which holds everything flushed.
const streams = new Map<string, Stream>();

export interface CreateStreamingInput {
  chatId: string;
  botId: string;
  runId?: string | null;
  threadRootId?: string | null;
}

/** Inserts an empty `streaming` Bot message and publishes `message.created`. */
export async function createStreaming(
  deps: MessagesDeps,
  { chatId, botId, runId = null, threadRootId = null }: CreateStreamingInput,
): Promise<Message> {
  const message = await postMessage(deps, chatId, {
    authorType: 'bot',
    authorId: botId,
    runId,
    threadRootId,
    parts: [],
    status: 'streaming',
  });
  streams.set(message.id, {
    messageId: message.id,
    chatId,
    seq: message.seq,
    botId,
    parts: [],
    deltaSeq: 0,
    open: null,
    pending: [],
    timer: null,
    chain: Promise.resolve(),
  });
  return message;
}

async function streamFor(deps: MessagesDeps, messageId: string): Promise<Stream> {
  const known = streams.get(messageId);
  if (known) return known;
  const [row] = await deps.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  if (!row) throw notFound('Message not found');
  if (row.status !== 'streaming') throw new Error(`Message ${messageId} is not streaming`);
  const stream: Stream = {
    messageId,
    chatId: row.chatId,
    seq: row.seq,
    botId: row.authorType === 'bot' ? row.authorId : null,
    parts: row.parts as MessagePart[],
    deltaSeq: row.deltaSeq,
    open: null,
    pending: [],
    timer: null,
    chain: Promise.resolve(),
  };
  streams.set(messageId, stream);
  return stream;
}

function isTextDelta(input: MessagePart | TextDelta): input is TextDelta {
  return input.type === 'text_delta' || input.type === 'reasoning_delta';
}

/**
 * Adds a whole part or a text delta to a streaming message. Text deltas extend
 * the open text or reasoning part and are flushed within `DELTA_FLUSH_MS`; a
 * whole part, or a delta of the other kind, is a part boundary and flushes at
 * once. Resolves when a whole part is stored and published.
 */
export async function appendPart(
  deps: MessagesDeps,
  messageId: string,
  input: MessagePart | TextDelta,
): Promise<void> {
  const stream = await streamFor(deps, messageId);
  if (stream.discarded) throw notFound('Message not found');
  if (!isTextDelta(input)) {
    stream.open = null;
    stream.parts.push(input);
    stream.pending.push({
      partIndex: stream.parts.length - 1,
      type: input.type,
      text: '',
      part: input,
    });
    return flush(deps, stream);
  }

  const type = input.type === 'text_delta' ? 'text' : 'reasoning';
  const open = stream.open === null ? undefined : stream.parts[stream.open];
  if (open?.type === type) {
    open.text += input.text;
    const last = stream.pending.at(-1);
    if (last && last.partIndex === stream.open && !last.part) last.text += input.text;
    else stream.pending.push({ partIndex: stream.open!, type, text: input.text });
  } else {
    if (stream.pending.length) flushLater(deps, stream, 0);
    stream.open = stream.parts.length;
    stream.parts.push({ type, text: input.text });
    stream.pending.push({ partIndex: stream.open, type, text: input.text });
  }
  if (!stream.timer) flushLater(deps, stream, DELTA_FLUSH_MS);
}

function flushLater(deps: MessagesDeps, stream: Stream, ms: number) {
  const run = () =>
    flush(deps, stream).catch((error: unknown) =>
      deps.logger.error({ err: error, messageId: stream.messageId }, 'message delta flush failed'),
    );
  if (ms) stream.timer = setTimeout(run, ms);
  else void run();
}

/** Writes the stream's parts and publishes what changed since the last flush. */
function flush(deps: MessagesDeps, stream: Stream): Promise<void> {
  if (stream.timer) clearTimeout(stream.timer);
  stream.timer = null;
  if (!stream.pending.length) return stream.chain;
  const deltaSeq = ++stream.deltaSeq;
  const deltas = stream.pending;
  // Each write stores the whole snapshot, so a failed write is repaired by the next.
  const parts = structuredClone(stream.parts);
  stream.pending = [];
  stream.chain = stream.chain
    .catch(() => {})
    .then(async () => {
      if (stream.discarded) return;
      const written = await deps.db
        .update(schema.messages)
        .set({ parts, deltaSeq })
        .where(eq(schema.messages.id, stream.messageId))
        .returning({ id: schema.messages.id });
      // Deleted meanwhile (`discardIfEmpty` in another process): nobody shows it any more.
      if (!written.length) return;
      await publishEvent(
        deps.infra.bus,
        wsEvent('message.delta', { messageId: stream.messageId, deltaSeq, deltas }, scope(stream)),
      );
    });
  return stream.chain;
}

function scope(stream: Stream) {
  return {
    chat_id: stream.chatId,
    seq: stream.seq,
    ...(stream.botId ? { bot_id: stream.botId } : {}),
  };
}

export interface FinalizeInput {
  usage?: { inputTokens: number; outputTokens: number };
  status?: 'complete' | 'failed';
}

/** Flushes what is left, marks the message complete or failed and publishes `message.completed`. */
export async function finalize(
  deps: MessagesDeps,
  messageId: string,
  { usage, status = 'complete' }: FinalizeInput = {},
): Promise<Message> {
  const stream = await streamFor(deps, messageId);
  await flush(deps, stream);
  streams.delete(messageId);
  const [row] = await deps.db
    .update(schema.messages)
    .set({ parts: stream.parts, deltaSeq: stream.deltaSeq, status })
    .where(eq(schema.messages.id, messageId))
    .returning();
  // Deleted meanwhile: a takeover in another process discarded it (`discardIfEmpty`).
  if (!row) throw notFound('Message not found');
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'message.completed',
      { messageId, status, deltaSeq: stream.deltaSeq, ...(usage ? { usage } : {}) },
      scope(stream),
    ),
  );
  return toMessage(row);
}

/** Whether parts show a reader anything: a part other than empty text or reasoning. */
function showsSomething(parts: readonly MessagePart[]): boolean {
  return parts.some((p) => !((p.type === 'text' || p.type === 'reasoning') && p.text === ''));
}

/**
 * `showsSomething` in SQL, negated, for the `messages` row a statement works
 * on: no parts, or only empty text and reasoning ones; and no thread replies.
 */
const showsNothing = sql`not exists (
    select 1 from jsonb_array_elements("messages"."parts") as part
    where not (part ->> 'type' in ('text', 'reasoning') and coalesce(part ->> 'text', '') = '')
  )
  and not exists (
    select 1 from "messages" as reply where reply."thread_root_id" = "messages"."id"
  )`;

/** Rolls back a deletion that found text arriving in this process. */
class StreamedMeanwhile extends Error {}

export type DiscardOutcome = 'deleted' | 'finalized' | 'gone';

/**
 * Closes a streaming message whose run went on elsewhere or ended (K4): one
 * that never showed anything is deleted, with `message.deleted` and a row in
 * `message_deletions` for resync, instead of left as an empty reply; one that
 * did is finalized as `finalize` would. `gone` when nothing is left to close:
 * deleted or finalized already, or not this organization's.
 *
 * Text buffered in this process is flushed first. The delete is one
 * conditional statement, so a part another process flushed meanwhile keeps
 * the message, and it commits only if no text arrived in this process either.
 * A thread reply to the message keeps it too.
 */
export async function discardIfEmpty(
  deps: MessagesDeps,
  messageId: string,
  input: FinalizeInput = {},
): Promise<DiscardOutcome> {
  const local = streams.get(messageId);
  if (local) {
    await flush(deps, local);
    if (showsSomething(local.parts)) {
      await finalize(deps, messageId, input);
      return 'finalized';
    }
  }
  const m = schema.messages;
  let deleted: Pick<MessageRow, 'chatId' | 'seq' | 'threadRootId' | 'authorType' | 'authorId'>;
  try {
    const result = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(m)
        .where(and(eq(m.id, messageId), eq(m.status, 'streaming'), showsNothing))
        .returning();
      if (!row) {
        const [left] = await tx.select({ status: m.status }).from(m).where(eq(m.id, messageId));
        return { row: null, left };
      }
      // No await from this check to the flag, so no delta lands here in between.
      if (local && showsSomething(local.parts)) throw new StreamedMeanwhile();
      if (local) local.discarded = true;
      await tx.insert(schema.messageDeletions).values({
        messageId,
        workspaceId: row.workspaceId,
        chatId: row.chatId,
        messageSeq: row.seq,
        threadRootId: row.threadRootId,
        seq: sql`openbots_next_chat_seq(${row.chatId})`,
      });
      return { row, left: undefined };
    });
    dropStream(messageId);
    if (!result.row) {
      if (result.left?.status !== 'streaming') return 'gone';
      // Another process wrote parts this one never saw: close it from the row.
      await finalize(deps, messageId, input);
      return 'finalized';
    }
    deleted = result.row;
  } catch (error) {
    if (local) local.discarded = false;
    if (!(error instanceof StreamedMeanwhile)) throw error;
    await finalize(deps, messageId, input);
    return 'finalized';
  }
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'message.deleted',
      { messageId, chatId: deleted.chatId, threadRootId: deleted.threadRootId },
      scopeOf(deleted, deleted.authorType === 'bot'),
    ),
  );
  return 'deleted';
}

function dropStream(messageId: string) {
  const stream = streams.get(messageId);
  if (stream?.timer) clearTimeout(stream.timer);
  streams.delete(messageId);
}

// Reactions (C8)

export type ReactionRow = {
  messageId: string;
  emoji: string;
  reactorType: 'user' | 'bot';
  reactorId: string;
};

async function ownedMessage(db: Db, owner: Owner, messageId: string) {
  const [row] = await db
    .select({ id: schema.messages.id, chatId: schema.messages.chatId, seq: schema.messages.seq })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.chats.id, schema.messages.chatId))
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.chats.ownerId, owner.id),
        eq(schema.chats.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Message not found');
  return row;
}

/** Adds the owner's reaction; publishes `reaction.added` only when it is new. */
export async function addReaction(
  deps: MessagesDeps,
  owner: Owner,
  messageId: string,
  emoji: string,
): Promise<{ reaction: ReactionRow; created: boolean }> {
  const message = await ownedMessage(deps.db, owner, messageId);
  const reaction: ReactionRow = { messageId, emoji, reactorType: 'user', reactorId: owner.id };
  const created = await insertReaction(deps, owner.workspaceId, message, reaction);
  return { reaction, created };
}

/** Stores a reaction and, when it is new, publishes `reaction.added`. */
async function insertReaction(
  deps: MessagesDeps,
  workspaceId: string,
  message: { chatId: string; seq: number },
  reaction: ReactionRow,
): Promise<boolean> {
  const inserted = await deps.db
    .insert(schema.reactions)
    .values({ ...reaction, workspaceId })
    .onConflictDoNothing()
    .returning({ id: schema.reactions.id });
  if (inserted.length) {
    await publishEvent(
      deps.infra.bus,
      wsEvent('reaction.added', reaction, {
        chat_id: message.chatId,
        seq: message.seq,
        ...(reaction.reactorType === 'bot' ? { bot_id: reaction.reactorId } : {}),
      }),
    );
  }
  return inserted.length > 0;
}

/**
 * A Bot's reactions in a run's chat (C8, the `react` tool). The default
 * target is the latest message there, in the run's thread when it has one,
 * that the Bot did not write; an explicit message must be in the same chat.
 */
export function botReactor(
  deps: MessagesDeps,
  run: { chatId: string; threadRootId: string | null },
  bot: { id: string; workspaceId: string },
) {
  return {
    react: async ({ emoji, messageId }: { emoji: string; messageId?: string }) => {
      const m = schema.messages;
      const [target] = await deps.db
        .select({ id: m.id, chatId: m.chatId, seq: m.seq })
        .from(m)
        .where(
          messageId
            ? and(eq(m.id, messageId), eq(m.chatId, run.chatId))
            : and(
                eq(m.chatId, run.chatId),
                run.threadRootId
                  ? or(eq(m.threadRootId, run.threadRootId), eq(m.id, run.threadRootId))
                  : isNull(m.threadRootId),
                or(isNull(m.authorId), ne(m.authorId, bot.id)),
              ),
        )
        .orderBy(desc(m.seq))
        .limit(1);
      if (!target) {
        throw new Error(messageId ? 'That message is not in this chat' : 'No message to react to');
      }
      const created = await insertReaction(deps, bot.workspaceId, target, {
        messageId: target.id,
        emoji,
        reactorType: 'bot',
        reactorId: bot.id,
      });
      return { messageId: target.id, created };
    },
  };
}

/** Removes the owner's reaction, if there was one, and publishes `reaction.removed`. */
export async function removeReaction(
  deps: MessagesDeps,
  owner: Owner,
  messageId: string,
  emoji: string,
): Promise<void> {
  const message = await ownedMessage(deps.db, owner, messageId);
  const deleted = await deps.db
    .delete(schema.reactions)
    .where(
      and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.reactorType, 'user'),
        eq(schema.reactions.reactorId, owner.id),
        eq(schema.reactions.emoji, emoji),
      ),
    )
    .returning({ id: schema.reactions.id });
  if (!deleted.length) return;
  const reaction: ReactionRow = { messageId, emoji, reactorType: 'user', reactorId: owner.id };
  await publishEvent(
    deps.infra.bus,
    wsEvent('reaction.removed', reaction, { chat_id: message.chatId, seq: message.seq }),
  );
}
