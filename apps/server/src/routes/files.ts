import { Readable } from 'node:stream';
import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../context.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  fileTooLarge,
  listAttachments,
  openFile,
  storeFile,
  uploadLimit,
  type AttachmentListing,
  type FileRow,
} from '../services/files.js';

// Uploads (plan 14.1, C1): composer attachments become `image` or `file`
// message parts by id, and avatar uploads become a Bot's image. Files are
// private to their owner; another user's file answers 404. The list is the
// owner's attachments only, with the chat each was sent in (plan 12.1):
// Artifact blobs, webhook bodies and avatars stay out of it.

const FileSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    mime: z.string().openapi({ description: 'Sniffed from the content, not taken on trust' }),
    size: z.number().int(),
    sha256: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi('File');

const AttachmentSchema = FileSchema.extend({
  chat: z
    .object({
      id: z.uuid(),
      type: z.enum(['bot_dm', 'group', 'bot_to_bot']),
      botId: z.uuid().nullable().openapi({ description: "A DM's Bot" }),
      name: z.string().openapi({ description: "The group's title or the DM's Bot name" }),
    })
    .nullable()
    .openapi({ description: 'The chat it was first sent in; null until sent or once deleted' }),
}).openapi('Attachment');

function toAttachment(item: AttachmentListing['items'][number]): z.infer<typeof AttachmentSchema> {
  return { ...toFile(item), chat: item.chat };
}

function toFile(row: FileRow): z.infer<typeof FileSchema> {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** Types a browser may render in place; everything else downloads. */
const INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

/** Multipart framing on top of the file itself. */
const FORM_OVERHEAD = 64 * 1024;

/** Refuses an upload body over the effective `uploadBytes` before parsing it. */
const limitUpload: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limit = await uploadLimit(c.var.deps, c.var.user.workspaceId);
  return bodyLimit({
    maxSize: limit + FORM_OVERHEAD,
    onError: () => {
      throw fileTooLarge(limit);
    },
  })(c, next);
};

export const fileRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/files',
      tags: ['files'],
      summary: "The caller's chat attachments, newest first",
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        query: z.object({
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: 'Attachments, each with the chat it came from',
          content: {
            'application/json': {
              schema: z.object({
                items: z.array(AttachmentSchema),
                nextCursor: z.uuid().nullable(),
              }),
            },
          },
        },
        400: problemResponse('Invalid cursor or limit'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { cursor, limit } = c.req.valid('query');
      const page = await listAttachments(c.var.deps.db, c.var.user, {
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      });
      return c.json({ items: page.items.map(toAttachment), nextCursor: page.nextCursor }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/files',
      tags: ['files'],
      summary: 'Upload a file to attach to a message or use as an avatar',
      middleware: [requireUser, limitUpload] as const,
      security: authenticated,
      request: {
        body: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: z.object({
                file: z
                  .custom<File>((v) => v instanceof File)
                  .openapi({ type: 'string', format: 'binary' }),
                purpose: z.enum(['attachment', 'avatar']).default('attachment').openapi({
                  description: 'An avatar must be a PNG, JPEG, WebP or GIF image',
                }),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: 'The stored file',
          content: { 'application/json': { schema: FileSchema } },
        },
        400: problemResponse('No `file` field, or an avatar that is not a raster image'),
        ...authProblems,
        413: problemResponse('Larger than the upload limit (`FILE_TOO_LARGE`)'),
      },
    }),
    async (c) => {
      const { file, purpose } = c.req.valid('form');
      const row = await storeFile(c.var.deps, c.var.user, {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredMime: file.type,
        purpose,
      });
      return c.json(toFile(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/files/{id}',
      tags: ['files'],
      summary: "A file's content",
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: 'The bytes, with the stored mime type',
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
        ...authProblems,
        404: problemResponse('No such file'),
      },
    }),
    async (c) => {
      const { file, stream } = await openFile(c.var.deps, c.var.user, c.req.valid('param').id);
      const disposition = INLINE_MIME.has(file.mime) ? 'inline' : 'attachment';
      return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
        'content-type': file.mime,
        'content-length': String(file.size),
        'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=31536000, immutable',
      });
    },
  );
