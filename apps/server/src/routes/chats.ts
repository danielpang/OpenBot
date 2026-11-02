import { createRoute, z } from '@hono/zod-openapi';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { addMembers, botIdsByChat, createGroup, getChat, removeMember } from '../services/chats.js';
import { listChats, openBotChat, type ChatRow } from '../services/messages.js';
import type { Db } from '../db/client.js';

// Chats (plan 14.1): a Bot's one transcript (B4), group chats of two to six
// Bots (C4, B8) and the Bot-to-Bot chats `message_bot` writes (C6). Messages
// are in messages.ts.

export const ChatSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(['bot_dm', 'group', 'bot_to_bot']),
    title: z.string().nullable(),
    botId: z
      .uuid()
      .nullable()
      .openapi({ description: '`bot_dm`: the Bot. `bot_to_bot`: the lower of the two Bot ids' }),
    peerBotId: z.uuid().nullable().openapi({ description: '`bot_to_bot`: the other Bot' }),
    botIds: z.array(z.uuid()).openapi({
      description: "The chat's Bots: the one Bot, the pair, or a group's members in join order",
    }),
    lastSeq: z.number().int().openapi({ description: 'The seq of the newest message; 0 if none' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Chat');

export function toChat(row: ChatRow, botIds: string[]): z.infer<typeof ChatSchema> {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    botId: row.botId,
    peerBotId: row.peerBotId,
    botIds,
    lastSeq: row.chatSeq,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function chatView(db: Db, row: ChatRow) {
  return toChat(row, (await botIdsByChat(db, [row])).get(row.id)!);
}

const chatResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ChatSchema } },
});

const groupProblems = {
  ...authProblems,
  400: problemResponse(
    'Invalid request; `GROUP_SIZE` outside 2 to the group limit; `NOT_A_GROUP` for a transcript or Bot-to-Bot chat',
  ),
  404: problemResponse('No such chat or Bot'),
  409: problemResponse(
    '`GROUP_FULL` past the group limit (B8, default 6); `GROUP_TOO_SMALL` below two Bots',
  ),
};

export const chatRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/chat',
      tags: ['chats'],
      summary: "Open a Bot's transcript",
      description:
        'Creates the transcript if it is missing. Opening it clears a `blocked` Bot back to idle.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: "The Bot's `bot_dm` chat; page its messages from `lastSeq`",
          content: { 'application/json': { schema: ChatSchema } },
        },
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const chat = await openBotChat(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toChat(chat, [chat.botId!]), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/chats',
      tags: ['chats'],
      summary: 'Group and Bot-to-Bot chats the caller can see',
      description: "Bot transcripts are not listed; each Bot's `chatId` names its transcript.",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Chats, most recently updated first',
          content: { 'application/json': { schema: z.object({ items: z.array(ChatSchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const rows = await listChats(c.var.deps.db, c.var.user);
      const botIds = await botIdsByChat(c.var.deps.db, rows);
      return c.json({ items: rows.map((row) => toChat(row, botIds.get(row.id)!)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/chats',
      tags: ['chats'],
      summary: 'Start a group chat',
      description:
        'The caller and two to six of their Bots (the admin can change the limit). Writing ' +
        'normally lets the Bots decide who answers; `@handle` and `@everyone` address them.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.strictObject({
                botIds: z.array(z.uuid()).min(1).max(100),
                title: z.string().max(200).nullish(),
              }),
            },
          },
        },
      },
      responses: { 201: chatResponse('The new group'), ...groupProblems },
    }),
    async (c) => {
      const chat = await createGroup(c.var.deps, c.var.user, c.req.valid('json'));
      return c.json(await chatView(c.var.deps.db, chat), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/chats/{id}/members',
      tags: ['chats'],
      summary: 'Add Bots to a group',
      description:
        'Bots already in the group are ignored. Each new one gets a "joined" event row. ' +
        'Mentioning a Bot that is not in the group with `@handle` adds it the same way.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.strictObject({ botIds: z.array(z.uuid()).min(1).max(100) }),
            },
          },
        },
      },
      responses: { 200: chatResponse('The group with its members'), ...groupProblems },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await addMembers(c.var.deps, c.var.user, id, c.req.valid('json').botIds);
      return c.json(await chatView(c.var.deps.db, await getChat(c.var.deps.db, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/chats/{id}/members/{botId}',
      tags: ['chats'],
      summary: 'Remove a Bot from a group',
      description: 'The Bot gets a "left" event row; a group keeps at least two Bots.',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid(), botId: z.uuid() }) },
      responses: { 200: chatResponse('The group with its members'), ...groupProblems },
    }),
    async (c) => {
      const { id, botId } = c.req.valid('param');
      await removeMember(c.var.deps, c.var.user, id, botId);
      return c.json(await chatView(c.var.deps.db, await getChat(c.var.deps.db, id)), 200);
    },
  );
