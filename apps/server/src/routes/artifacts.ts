import { Readable } from 'node:stream';
import { createRoute, z } from '@hono/zod-openapi';
import { artifactFileName } from '@openbots/artifacts';
import { ARTIFACT_KINDS } from '@openbots/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../context.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  getArtifact,
  listBotArtifacts,
  listVersions,
  openVersion,
  writeArtifact,
  type ArtifactRecord,
  type ArtifactVersionRow,
} from '../services/artifacts.js';

// Artifacts (plan 12.1, 14.1; A1, A2, A4): the card's target, its version
// history, each version's content, the owner's edit of a text kind (a new
// version attributed to the user) and downloads. A version is served with the
// type it was stored with; SVG and anything else a browser could run stays an
// attachment under a sandbox CSP. Owner-scoped: another user's Artifact is 404.

const ArtifactKindSchema = z.enum(ARTIFACT_KINDS).openapi('ArtifactKind');

const ArtifactVersionSchema = z
  .object({
    id: z.uuid(),
    artifactId: z.uuid(),
    version: z.number().int().positive(),
    mime: z.string(),
    size: z.number().int(),
    summary: z.string().nullable().openapi({
      description: 'Lines added and removed against the previous version, `+14 −10` (text kinds)',
    }),
    createdBy: z.enum(['bot', 'user']),
    createdByRunId: z.uuid().nullable(),
    createdByUserId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('ArtifactVersion');

const ArtifactSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid().nullable().openapi({ description: 'Null once the Bot is deleted' }),
    chatId: z.uuid().nullable(),
    kind: ArtifactKindSchema,
    title: z.string(),
    currentVersion: ArtifactVersionSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Artifact');

const UpdateArtifactSchema = z
  .strictObject({
    content: z.string(),
    baseVersion: z.number().int().positive().optional().openapi({
      description: 'The version the edit started from; a newer current version answers 409',
    }),
  })
  .openapi('UpdateArtifact');

function toVersion(row: ArtifactVersionRow): z.infer<typeof ArtifactVersionSchema> {
  return {
    id: row.id,
    artifactId: row.artifactId,
    version: row.version,
    mime: row.mime,
    size: row.size,
    summary: row.summary,
    createdBy: row.createdByUserId ? 'user' : 'bot',
    createdByRunId: row.createdByRunId,
    createdByUserId: row.createdByUserId,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function toArtifact({ artifact, version }: ArtifactRecord): z.infer<typeof ArtifactSchema> {
  return {
    id: artifact.id,
    botId: artifact.botId,
    chatId: artifact.chatId,
    kind: artifact.kind,
    title: artifact.title,
    currentVersion: version ? toVersion(version) : null,
    createdAt: new Date(artifact.createdAt).toISOString(),
    updatedAt: new Date(artifact.updatedAt).toISOString(),
  };
}

/**
 * Types a browser may render in place; everything else is served as an
 * attachment. Not SVG: the viewer shows it through `<img>`, which runs no script.
 */
const INLINE_MIME = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function serveVersion(
  c: Context<AppEnv>,
  opened: Awaited<ReturnType<typeof openVersion>>,
  attachment: boolean,
) {
  const { artifact, opened: version, stream } = opened;
  const disposition = attachment || !INLINE_MIME.has(version.mime) ? 'attachment' : 'inline';
  const name = artifactFileName(artifact.title, version.mime);
  return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
    'content-type': version.mime.startsWith('text/')
      ? `${version.mime}; charset=utf-8`
      : version.mime,
    'content-length': String(version.size),
    'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    // A version never changes; the current one does.
    'cache-control': 'private, no-cache',
  });
}

const params = z.object({ id: z.uuid() });
const binary = (description: string) => ({
  description,
  content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
});
const artifactResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ArtifactSchema } },
});

export const artifactRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/artifacts/{id}',
      tags: ['artifacts'],
      summary: 'An Artifact with its current version',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: artifactResponse('The Artifact'),
        ...authProblems,
        404: problemResponse('No such Artifact'),
      },
    }),
    async (c) => {
      const record = await getArtifact(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toArtifact(record), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/artifacts/{id}',
      tags: ['artifacts'],
      summary:
        "The owner's edit of a document, code or data Artifact: a new version attributed to the user",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { content: { 'application/json': { schema: UpdateArtifactSchema } }, required: true },
      },
      responses: {
        200: artifactResponse('The Artifact at its new version'),
        ...authProblems,
        404: problemResponse('No such Artifact'),
        409: problemResponse(
          '`baseVersion` is not the current version (`VERSION_CONFLICT`), or the Artifact is a file or design, which cannot be edited (`NOT_EDITABLE`)',
        ),
        413: problemResponse('Larger than the upload limit (`FILE_TOO_LARGE`)'),
      },
    }),
    async (c) => {
      const { content, baseVersion } = c.req.valid('json');
      const { artifact, version } = await writeArtifact(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
        { content },
        { userId: c.var.user.id },
        baseVersion !== undefined ? { baseVersion } : {},
      );
      return c.json(toArtifact({ artifact, version }), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/artifacts/{id}/versions',
      tags: ['artifacts'],
      summary: "An Artifact's versions, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'Versions',
          content: {
            'application/json': {
              schema: z.object({ items: z.array(ArtifactVersionSchema) }),
            },
          },
        },
        ...authProblems,
        404: problemResponse('No such Artifact'),
      },
    }),
    async (c) => {
      const { versions } = await listVersions(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ items: versions.map(toVersion) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/artifacts/{id}/versions/{version}/content',
      tags: ['artifacts'],
      summary: "One version's content, for the viewer",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params: z.object({ id: z.uuid(), version: z.coerce.number().int().positive() }),
      },
      responses: {
        200: binary("The version's bytes, with its mime type"),
        ...authProblems,
        404: problemResponse('No such Artifact or version'),
      },
    }),
    async (c) => {
      const { id, version } = c.req.valid('param');
      return serveVersion(c, await openVersion(c.var.deps, c.var.user, id, version), false);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/artifacts/{id}/download',
      tags: ['artifacts'],
      summary: 'Download the current version, or `?version=`',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        query: z.object({ version: z.coerce.number().int().positive().optional() }),
      },
      responses: {
        200: binary('The version as an attachment named after the title'),
        ...authProblems,
        404: problemResponse('No such Artifact or version'),
      },
    }),
    async (c) => {
      const { version } = c.req.valid('query');
      const opened = await openVersion(c.var.deps, c.var.user, c.req.valid('param').id, version);
      return serveVersion(c, opened, true);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/bots/{id}/artifacts',
      tags: ['bots'],
      summary: "A Bot's Artifacts, most recently updated first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'Artifacts',
          content: { 'application/json': { schema: z.object({ items: z.array(ArtifactSchema) }) } },
        },
        ...authProblems,
        404: problemResponse('No such Bot'),
      },
    }),
    async (c) => {
      const rows = await listBotArtifacts(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ items: rows.map(toArtifact) }, 200);
    },
  );
