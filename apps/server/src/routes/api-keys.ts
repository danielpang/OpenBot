import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { notFound } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { recordAudit, userActor } from '../services/audit.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { asDirectory } from '../db/scope.js';

// API keys (U4): list, create (the key is returned once), revoke. Keys are
// hashed at rest by better-auth's api-key plugin. A key belongs to the
// organization it was made in and opens only that one (plan 21.2), so each
// organization lists and revokes its own.

const ApiKeySchema = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    start: z.string().nullable().openapi({ description: 'The first characters, for display' }),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .openapi('ApiKey');

const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string().openapi({ description: 'The key itself; shown only once' }),
}).openapi('CreatedApiKey');

const CreateApiKeySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(32),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .openapi('CreateApiKey');

const iso = (date: Date | null | undefined) => (date ? new Date(date).toISOString() : null);

export const apiKeyRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/api-keys',
      tags: ['auth'],
      summary: "The caller's API keys",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'API keys, newest first',
          content: { 'application/json': { schema: z.object({ items: z.array(ApiKeySchema) }) } },
        },
        ...authProblems,
      },
    }),
    async (c) => {
      const { db } = c.var.deps;
      const rows = await db
        .select()
        .from(schema.apikeys)
        .where(
          and(
            eq(schema.apikeys.referenceId, c.var.user.id),
            eq(schema.apikeys.workspaceId, c.var.user.workspaceId),
          ),
        )
        .orderBy(desc(schema.apikeys.createdAt));
      const items = rows.map((k) => ({
        id: k.id,
        name: k.name,
        start: k.start,
        createdAt: k.createdAt.toISOString(),
        expiresAt: iso(k.expiresAt),
        lastUsedAt: iso(k.lastRequest),
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/api-keys',
      tags: ['auth'],
      summary: 'Create an API key',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CreateApiKeySchema } } },
      },
      responses: {
        201: {
          description: 'The new key',
          content: { 'application/json': { schema: CreatedApiKeySchema } },
        },
        400: problemResponse('Invalid request'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { auth, db } = c.var.deps;
      const { name, expiresInDays } = c.req.valid('json');
      const created = await auth.api.createApiKey({
        body: {
          name,
          userId: c.var.user.id,
          expiresIn: expiresInDays ? expiresInDays * 86_400 : null,
        },
      });
      // better-auth made it with no organization, so it is the directory's
      // until it has one (db/scope.ts).
      await asDirectory(() =>
        db
          .update(schema.apikeys)
          .set({ workspaceId: c.var.user.workspaceId })
          .where(
            and(eq(schema.apikeys.id, created.id), eq(schema.apikeys.referenceId, c.var.user.id)),
          ),
      );
      await recordAudit(db, {
        workspaceId: c.var.user.workspaceId,
        actor: userActor(c.var.user),
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: created.id,
        metadata: { name, start: created.start, expiresAt: created.expiresAt },
      });
      return c.json(
        {
          id: created.id,
          name: created.name,
          start: created.start,
          key: created.key,
          createdAt: iso(created.createdAt)!,
          expiresAt: iso(created.expiresAt),
          lastUsedAt: null,
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/api-keys/{id}',
      tags: ['auth'],
      summary: 'Revoke an API key',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        204: { description: 'Revoked' },
        404: problemResponse('No such key'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { db } = c.var.deps;
      const { id } = c.req.valid('param');
      const deleted = await db
        .delete(schema.apikeys)
        .where(
          and(
            eq(schema.apikeys.id, id),
            eq(schema.apikeys.referenceId, c.var.user.id),
            eq(schema.apikeys.workspaceId, c.var.user.workspaceId),
          ),
        )
        .returning({ id: schema.apikeys.id, name: schema.apikeys.name });
      if (!deleted.length) throw notFound('No such API key');
      await recordAudit(db, {
        workspaceId: c.var.user.workspaceId,
        actor: userActor(c.var.user),
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: id,
        metadata: { name: deleted[0]!.name },
      });
      return c.body(null, 204);
    },
  );
