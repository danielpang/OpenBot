import { createRoute, z } from '@hono/zod-openapi';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { MessageSchema } from '../schemas.js';
import {
  addReaction,
  listMessages,
  MESSAGE_PAGE_DEFAULT,
  MESSAGE_PAGE_MAX,
  postUserMessage,
  removeReaction,
} from '../services/messages.js';

// Transcript messages and reactions (plan 14.1; C1, C8). Owner-scoped: another
// user's chat or message answers 404. New messages are announced on the WS as
// `message.created`; Bot replies then stream as `message.delta` events.

const MessagePageSchema = z
  .object({
    messages: z.array(MessageSchema),
    /** Older messages remain; call again with `before` set to the last seq returned. */
    hasMore: z.boolean(),
  })
  .openapi('MessagePage');

const PostMessageSchema = z
  .strictObject({
    text: z.string().max(100_000).optional().openapi({
      description: '`@handle` mentions a Bot and `@everyone` every Bot in the chat',
    }),
    attachments: z.array(z.uuid()).max(20).optional().openapi({
      description: 'Ids from `POST /files`; images become `image` parts, the rest `file` parts',
    }),
    mentionEveryone: z.boolean().optional(),
    threadRootId: z.uuid().optional().openapi({ description: 'Reply in this thread' }),
    skillId: z.uuid().optional().openapi({
      description: "A Skill referenced with `/`: enabled for one of the chat's Bots",
    }),
  })
  .openapi('PostMessage');

const ReactionSchema = z
  .object({
    messageId: z.uuid(),
    emoji: z.string(),
    reactorType: z.enum(['user', 'bot']),
    reactorId: z.uuid(),
  })
  .openapi('Reaction');

const emoji = z.string().trim().min(1).max(32);

const chatParams = z.object({ id: z.uuid() });
const messageParams = z.object({ id: z.uuid() });

export const messageRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/chats/{id}/messages',
      tags: ['chats'],
      summary: 'A page of messages, newest first',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: chatParams,
        query: z.object({
          before: z.coerce.number().int().positive().optional().openapi({
            description: 'Only messages with a lower seq; omit for the newest',
          }),
          limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(MESSAGE_PAGE_DEFAULT),
          thread: z.uuid().optional().openapi({
            description: 'A thread root: the root and its replies. Omitted: top-level messages',
          }),
        }),
      },
      responses: {
        200: {
          description: 'Messages by seq, descending',
          content: { 'application/json': { schema: MessagePageSchema } },
        },
        ...authProblems,
        404: problemResponse('No such chat'),
      },
    }),
    async (c) => {
      const page = await listMessages(
        c.var.deps.db,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query'),
      );
      return c.json(page, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/chats/{id}/messages',
      tags: ['chats'],
      summary: 'Send a message as the owner',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: chatParams,
        body: { required: true, content: { 'application/json': { schema: PostMessageSchema } } },
      },
      responses: {
        201: {
          description: 'The stored message, also published as `message.created`',
          content: { 'application/json': { schema: MessageSchema } },
        },
        400: problemResponse(
          'Invalid request, empty message (`EMPTY_MESSAGE`) or bad thread (`INVALID_THREAD`)',
        ),
        ...authProblems,
        404: problemResponse('No such chat, attachment or Skill'),
      },
    }),
    async (c) => {
      const message = await postUserMessage(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(message, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/messages/{id}/reactions',
      tags: ['chats'],
      summary: 'React to a message',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: messageParams,
        body: {
          required: true,
          content: { 'application/json': { schema: z.strictObject({ emoji }) } },
        },
      },
      responses: {
        200: {
          description: 'Already there',
          content: { 'application/json': { schema: ReactionSchema } },
        },
        201: {
          description: 'Added, and published as `reaction.added`',
          content: { 'application/json': { schema: ReactionSchema } },
        },
        ...authProblems,
        404: problemResponse('No such message'),
      },
    }),
    async (c) => {
      const { reaction, created } = await addReaction(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json').emoji,
      );
      return created ? c.json(reaction, 201) : c.json(reaction, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/messages/{id}/reactions',
      tags: ['chats'],
      summary: 'Remove your reaction',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: messageParams, query: z.object({ emoji }) },
      responses: {
        204: { description: 'Removed (published as `reaction.removed`), or was not there' },
        ...authProblems,
        404: problemResponse('No such message'),
      },
    }),
    async (c) => {
      await removeReaction(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('query').emoji,
      );
      return c.body(null, 204);
    },
  );
