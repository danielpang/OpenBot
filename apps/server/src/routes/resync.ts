import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { assertChatOwner } from '../ownership.js';
import { MessageSchema, toMessage } from '../schemas.js';
import { withReadOverlays } from '../services/messages.js';

// Catch-up after a WebSocket reconnect (plan 14.2): every message in the chat
// that is new or changed since the last seq the client saw, in the order it
// last changed. A change (completing, a widget state, a reaction) takes a
// fresh chat seq into `updated_seq`, so a message the client already holds
// comes back when it changed while the client was away. A deleted message
// (an empty Bot reply a lost run left, `discardIfEmpty`) comes back under
// `deleted`, from the seq its deletion took, so the client drops it.

const RESYNC_PAGE = 500;

export const ResyncSchema = z
  .object({
    messages: z.array(MessageSchema),
    /** More messages remain; call again with the last `updatedSeq` returned. */
    hasMore: z.boolean(),
    /**
     * Messages deleted after `since`, which the client should drop: each one's
     * id, its own seq and the thread it was a reply in (for the root's reply
     * count). Every page lists them all.
     */
    deleted: z.array(
      z.object({
        id: z.uuid(),
        seq: z.number().int(),
        threadRootId: z.uuid().nullable(),
      }),
    ),
  })
  .openapi('Resync');

export const resyncRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/chats/{id}/resync',
    tags: ['realtime'],
    summary: 'Messages in a chat new or changed after a seq, for catching up after a reconnect',
    middleware: [requireUser] as const,
    security: authenticated,
    request: {
      params: z.object({ id: z.uuid() }),
      query: z.object({
        since: z.coerce.number().int().nonnegative().default(0).openapi({
          description: 'The highest seq the client has; 0 for everything',
        }),
      }),
    },
    responses: {
      200: {
        description:
          'Messages with `updatedSeq` greater than `since`, in `updatedSeq` order, and those deleted since',
        content: { 'application/json': { schema: ResyncSchema } },
      },
      ...authProblems,
      404: problemResponse('No such chat'),
    },
  }),
  async (c) => {
    const { db } = c.var.deps;
    const { id } = c.req.valid('param');
    const { since } = c.req.valid('query');
    await assertChatOwner(db, c.var.user, id);
    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.chatId, id), gt(schema.messages.updatedSeq, since)))
      .orderBy(asc(schema.messages.updatedSeq))
      .limit(RESYNC_PAGE + 1);
    const messages = await withReadOverlays(db, rows.slice(0, RESYNC_PAGE).map(toMessage));
    const d = schema.messageDeletions;
    const deleted = await db
      .select({ id: d.messageId, seq: d.messageSeq, threadRootId: d.threadRootId })
      .from(d)
      .where(and(eq(d.chatId, id), gt(d.seq, since)))
      .orderBy(asc(d.seq));
    return c.json({ messages, hasMore: rows.length > RESYNC_PAGE, deleted }, 200);
  },
);
