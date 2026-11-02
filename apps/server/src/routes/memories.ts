import { createRoute, z } from '@hono/zod-openapi';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
  type MemoryRow,
} from '../services/memories.js';

// A Bot's memories (M1, M2; plan 14.1). The owner sees, adds, edits and
// deletes what the Bot remembers; owner-scoped, another user's Bot is 404.

const MemoryKindSchema = z.enum(['preference', 'fact', 'summary']).openapi('MemoryKind');

const MemorySchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    kind: MemoryKindSchema,
    content: z.string(),
    sourceRunId: z.uuid().nullable().openapi({
      description: 'The run that saved it; null when the owner wrote it',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Memory');

const content = z.string().trim().min(1).max(1_000);

const CreateMemorySchema = z
  .strictObject({ kind: MemoryKindSchema, content })
  .openapi('CreateMemory');

const UpdateMemorySchema = z
  .strictObject({ kind: MemoryKindSchema.optional(), content: content.optional() })
  .openapi('UpdateMemory');

function toMemory(row: MemoryRow): z.infer<typeof MemorySchema> {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    content: row.content,
    sourceRunId: row.sourceRunId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

const botParams = z.object({ id: z.uuid() });
const memoryParams = z.object({ id: z.uuid(), memoryId: z.uuid() });
const memoryResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: MemorySchema } },
});

export const memoryRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/memories',
      tags: ['bots'],
      summary: "A Bot's memories, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: botParams },
      responses: {
        200: {
          description: 'Memories',
          content: { 'application/json': { schema: z.object({ items: z.array(MemorySchema) }) } },
        },
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const rows = await listMemories(c.var.deps.db, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toMemory) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/bots/{id}/memories',
      tags: ['bots'],
      summary: 'Add a memory',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: botParams,
        body: { content: { 'application/json': { schema: CreateMemorySchema } }, required: true },
      },
      responses: {
        201: memoryResponse('The memory'),
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const row = await createMemory(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(toMemory(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/bots/{id}/memories/{memoryId}',
      tags: ['bots'],
      summary: 'Edit a memory',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: memoryParams,
        body: { content: { 'application/json': { schema: UpdateMemorySchema } }, required: true },
      },
      responses: {
        200: memoryResponse('The memory'),
        ...authProblems,
        404: problemResponse('No such Bot or memory'),
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      const row = await updateMemory(c.var.deps, c.var.user, id, memoryId, c.req.valid('json'));
      return c.json(toMemory(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/bots/{id}/memories/{memoryId}',
      tags: ['bots'],
      summary: 'Delete a memory',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: memoryParams },
      responses: {
        204: { description: 'Deleted' },
        ...authProblems,
        404: problemResponse('No such Bot or memory'),
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      await deleteMemory(c.var.deps.db, c.var.user, id, memoryId);
      return c.body(null, 204);
    },
  );
