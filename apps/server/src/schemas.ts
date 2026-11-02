import { z } from '@hono/zod-openapi';
import {
  DEFAULT_LIMITS,
  MessageAuthorTypeSchema,
  MessagePartSchema,
  MessageStatusSchema,
  type MessagePart,
} from '@openbots/shared';
import type { schema } from './db/client.js';

// zod schemas shared by more than one route file.

export const RoleSchema = z.enum(['owner', 'admin', 'member']).openapi('Role');

const limitCount = z.number().int().positive();

export const LimitsSchema = z
  .object(
    Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, limitCount])) as {
      [K in keyof typeof DEFAULT_LIMITS]: typeof limitCount;
    },
  )
  .openapi('Limits');

/** One reaction on a message (C8); `reaction.added` and `reaction.removed` add its `messageId`. */
export const MessageReactionSchema = z
  .object({
    emoji: z.string(),
    reactorType: z.enum(['user', 'bot']),
    reactorId: z.uuid(),
  })
  .openapi('MessageReaction');

/** A transcript message (plan 4.2); the WS `message.created` payload carries the same shape. */
export const MessageSchema = z
  .object({
    id: z.uuid(),
    chatId: z.uuid(),
    seq: z.number().int(),
    threadRootId: z.uuid().nullable(),
    authorType: MessageAuthorTypeSchema,
    authorId: z.uuid().nullable(),
    // Shared schemas predate zod-openapi's extension; `describe` returns a copy that has `.openapi`.
    parts: z.array(
      MessagePartSchema.describe('One of the ordered message parts').openapi('MessagePart'),
    ),
    mentions: z.array(z.uuid()),
    mentionEveryone: z.boolean(),
    runId: z.uuid().nullable(),
    status: MessageStatusSchema,
    deltaSeq: z.number().int().openapi({
      description: 'The last `message.delta` included in `parts`; skip deltas at or below it',
    }),
    updatedSeq: z.number().int().openapi({
      description:
        'The chat seq of its last change (insert, completion, mentions, a widget state or a reaction); resync pages by it',
    }),
    createdAt: z.iso.datetime(),
    reactions: z.array(MessageReactionSchema).optional().openapi({
      description: 'Its reactions, oldest first; on messages read from a page or resync',
    }),
    replyCount: z.number().int().nonnegative().optional().openapi({
      description: 'Thread replies to it; on top-level messages read from a page or resync',
    }),
    lastReplySeq: z.number().int().nullable().optional().openapi({
      description:
        'The seq of the newest reply `replyCount` includes; replies above it arrived since the read',
    }),
  })
  .openapi('Message');

export type Message = z.infer<typeof MessageSchema>;

export function toMessage(row: typeof schema.messages.$inferSelect): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    seq: row.seq,
    threadRootId: row.threadRootId,
    authorType: row.authorType,
    authorId: row.authorId,
    parts: row.parts as MessagePart[],
    mentions: row.mentions,
    mentionEveryone: row.mentionEveryone,
    runId: row.runId,
    status: row.status,
    deltaSeq: row.deltaSeq,
    updatedSeq: row.updatedSeq,
    createdAt: row.createdAt.toISOString(),
  };
}
