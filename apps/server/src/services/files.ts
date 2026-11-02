import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  attachmentKind,
  decodeText,
  VISION_IMAGE_TYPES,
  type AttachmentFile,
  type AttachmentRequest,
  type AttachmentServices,
  type LoadedAttachment,
} from '@openbots/agent';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { organizationSettings } from '../workspace.js';

// Stored files (plan 4.8): chat attachments, Artifact version blobs, webhook
// delivery bodies and avatar uploads, told apart by `purpose`. Only
// attachments are listed to the owner or attachable to a message (plan 12.1).
// Blobs live on local disk under OPENBOTS_FILES_DIR, named by a random storage
// key under the organization's directory (`orgs/<organization>/`, plan 21.3;
// files from before have keys without one); the row records the name the
// user gave, the sniffed mime type and a sha256. Every read is by a row the
// caller owns in the active organization.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type FilesDeps = Pick<AppDeps, 'db' | 'config'>;

export type FileRow = typeof schema.files.$inferSelect;
export type FilePurpose = FileRow['purpose'];

/** Raster types an uploaded avatar may have; SVG could carry script (S-18). */
export const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const invalidAvatar = () =>
  new DomainError(400, 'INVALID_AVATAR', 'An avatar must be a PNG, JPEG, WebP or GIF image');

export const fileTooLarge = (limit: number) =>
  new DomainError(413, 'FILE_TOO_LARGE', `Files can be at most ${limit} bytes`);

/** The organization's upload cap (`uploadBytes`, PRD section 6 style limits). */
export async function uploadLimit(deps: FilesDeps, workspaceId: string): Promise<number> {
  return (await organizationSettings(deps, workspaceId)).limits.uploadBytes;
}

type Signature = [offset: number, bytes: number[] | string];

const SIGNATURES: [mime: string, ...Signature[]][] = [
  ['image/png', [0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  ['image/jpeg', [0, [0xff, 0xd8, 0xff]]],
  ['image/gif', [0, 'GIF87a']],
  ['image/gif', [0, 'GIF89a']],
  ['image/webp', [0, 'RIFF'], [8, 'WEBP']],
  ['application/pdf', [0, '%PDF-']],
  ['application/zip', [0, [0x50, 0x4b, 0x03, 0x04]]],
  ['application/gzip', [0, [0x1f, 0x8b]]],
];

function matches(bytes: Uint8Array, [offset, sig]: Signature) {
  const expected = typeof sig === 'string' ? [...sig].map((ch) => ch.charCodeAt(0)) : sig;
  return expected.every((b, i) => bytes[offset + i] === b);
}

/**
 * The mime type from the content's magic bytes. A declared type is kept only
 * when the content does not contradict it: never an image or PDF the bytes do
 * not show, and a zip container keeps a more specific declared type (docx).
 */
export function sniffMime(bytes: Uint8Array, declared = ''): string {
  const claimed = declared.split(';')[0]!.trim().toLowerCase();
  const match = SIGNATURES.find(([, ...sigs]) => sigs.every((s) => matches(bytes, s)))?.[0];
  if (match === 'application/zip' && claimed.startsWith('application/')) return claimed;
  if (match) return match;
  if (claimed && !claimed.startsWith('image/') && claimed !== 'application/pdf') {
    if (claimed.startsWith('text/') || claimed === 'application/json') {
      return looksLikeText(bytes) ? claimed : 'application/octet-stream';
    }
    return claimed;
  }
  return looksLikeText(bytes) ? 'text/plain' : 'application/octet-stream';
}

function looksLikeText(bytes: Uint8Array) {
  const head = bytes.subarray(0, 8192);
  return !head.includes(0);
}

/**
 * Stores bytes and records them for their owner, under what they are for. An
 * avatar must sniff as a raster image.
 */
export async function storeFile(
  deps: FilesDeps,
  owner: Owner,
  input: { name: string; bytes: Uint8Array; declaredMime?: string; purpose: FilePurpose },
): Promise<FileRow> {
  const limit = await uploadLimit(deps, owner.workspaceId);
  if (input.bytes.byteLength > limit) throw fileTooLarge(limit);
  const mime = sniffMime(input.bytes, input.declaredMime);
  if (input.purpose === 'avatar' && !isAvatarMime(mime)) throw invalidAvatar();
  const storageKey = `${owner.workspaceId}/${randomUUID()}`;
  const target = blobPath(deps, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  // Write then rename, so a crash never leaves a half file under a real key.
  await writeFile(`${target}.part`, input.bytes);
  await rename(`${target}.part`, target);
  const [row] = await deps.db
    .insert(schema.files)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: cleanName(input.name),
      mime,
      size: input.bytes.byteLength,
      storageKey,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      purpose: input.purpose,
    })
    .returning();
  return row!;
}

/** The owner's file and a stream of its bytes; another user's file is not found. */
export async function openFile(
  deps: FilesDeps,
  owner: Owner,
  fileId: string,
): Promise<{ file: FileRow; stream: Readable }> {
  const [file] = await deps.db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.id, fileId),
        eq(schema.files.ownerId, owner.id),
        eq(schema.files.workspaceId, owner.workspaceId),
      ),
    );
  if (!file) throw notFound('File not found');
  return { file, stream: createReadStream(blobPath(deps, file.storageKey)) };
}

export function isAvatarMime(mime: string): boolean {
  return (AVATAR_MIMES as readonly string[]).includes(mime);
}

/**
 * Whether a file can be a Bot's uploaded avatar: `missing` unless it is the
 * owner's (S-18 G1), `not_image` unless it is an avatar or attachment upload
 * of a raster type, else `usable`.
 */
export async function avatarFileStatus(
  db: AppDeps['db'],
  owner: Owner,
  fileId: string,
): Promise<'usable' | 'missing' | 'not_image'> {
  const [row] = await db
    .select({ mime: schema.files.mime, purpose: schema.files.purpose })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.id, fileId),
        eq(schema.files.ownerId, owner.id),
        eq(schema.files.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) return 'missing';
  const upload = row.purpose === 'avatar' || row.purpose === 'attachment';
  return upload && isAvatarMime(row.mime) ? 'usable' : 'not_image';
}

/**
 * The owner's attachments among `fileIds`, the only files a message may carry
 * (plan 12.1). Artifact blobs, webhook bodies and avatars are left out, so an
 * id of one reads as not found.
 */
export async function ownedAttachments(
  db: AppDeps['db'],
  owner: Owner,
  fileIds: string[],
): Promise<FileRow[]> {
  if (!fileIds.length) return [];
  return db
    .select()
    .from(schema.files)
    .where(
      and(
        inArray(schema.files.id, fileIds),
        eq(schema.files.ownerId, owner.id),
        eq(schema.files.workspaceId, owner.workspaceId),
        eq(schema.files.purpose, 'attachment'),
      ),
    );
}

/** Records the chat the owner first sent each attachment in. */
export async function noteAttachmentChat(db: AppDeps['db'], fileIds: string[], chatId: string) {
  if (!fileIds.length) return;
  await db
    .update(schema.files)
    .set({ chatId })
    .where(
      and(
        inArray(schema.files.id, fileIds),
        eq(schema.files.purpose, 'attachment'),
        sql`${schema.files.chatId} is null`,
      ),
    );
}

export interface AttachmentChat {
  id: string;
  type: (typeof schema.chatType.enumValues)[number];
  /** The DM's Bot, for linking to its transcript. */
  botId: string | null;
  /** The group's title, or the DM's Bot name. */
  name: string;
}

export interface AttachmentListing {
  items: (FileRow & { chat: AttachmentChat | null })[];
  nextCursor: string | null;
}

/**
 * The owner's chat attachments with the chat each came from, newest first,
 * `limit` at a time (plan 12.1: the Computer page lists them beside the
 * computer's files).
 */
export async function listAttachments(
  db: AppDeps['db'],
  owner: Owner,
  { cursor, limit = 50 }: { cursor?: string; limit?: number } = {},
): Promise<AttachmentListing> {
  const files = schema.files;
  const rows = await db
    .select({ file: files, chat: schema.chats, botName: schema.bots.name })
    .from(files)
    .leftJoin(schema.chats, eq(schema.chats.id, files.chatId))
    .leftJoin(schema.bots, eq(schema.bots.id, schema.chats.botId))
    .where(
      and(
        eq(files.ownerId, owner.id),
        eq(files.workspaceId, owner.workspaceId),
        eq(files.purpose, 'attachment'),
        // Keyset on (created_at, id), read from the cursor row (as the audit log).
        cursor
          ? sql`(${files.createdAt}, ${files.id}) < (select created_at, id from files where id = ${cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(({ file, chat, botName }) => ({
      ...file,
      chat: chat
        ? {
            id: chat.id,
            type: chat.type,
            botId: chat.type === 'bot_dm' ? chat.botId : null,
            name: chat.title ?? botName ?? (chat.type === 'group' ? 'Group chat' : 'Chat'),
          }
        : null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.file.id : null,
  };
}

/** `<organization>/<key>`, or a bare `<key>` from before organizations. */
const STORAGE_KEY = /^(?:([0-9a-f-]{36})\/)?([A-Za-z0-9_-]+)$/;

function blobPath(deps: FilesDeps, storageKey: string) {
  const match = STORAGE_KEY.exec(storageKey);
  if (!match) throw new Error('Malformed storage key');
  const [, workspaceId, key] = match as unknown as [string, string | undefined, string];
  // Two-character fan-out keeps any one directory small.
  return workspaceId
    ? path.join(deps.config.filesDir, 'orgs', workspaceId, key.slice(0, 2), key)
    : path.join(deps.config.filesDir, key.slice(0, 2), key);
}

function cleanName(name: string) {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '');
  return base.trim().slice(0, 255) || 'file';
}

// Attachments for a run (C1, C9): what context assembly loads and what
// `read_attachment` and `attachment_to_computer` read. Only the chat owner's
// uploads, and only those a message in the run's chat references (an `image`
// or `file` part, from the owner or a Bot's `attach_file`); any other id
// reads as not found.

type RunChat = { id: string; ownerId: string; workspaceId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const attachmentNotFound = (fileId: string) =>
  new Error(`No attachment ${fileId} in this chat. Use the file id from its attachment line.`);

/** The chat owner's attachment `fileId`, when a message in the chat references it. */
export async function chatAttachment(
  db: AppDeps['db'],
  chat: RunChat,
  fileId: string,
): Promise<FileRow | null> {
  if (!UUID.test(fileId)) return null;
  const [file] = await ownedAttachments(db, { id: chat.ownerId, workspaceId: chat.workspaceId }, [
    fileId,
  ]);
  if (!file) return null;
  const refs = ['image', 'file'].map(
    (type) =>
      sql`${schema.messages.parts} @> ${JSON.stringify([{ type, file_id: fileId }])}::jsonb`,
  );
  const [referenced] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chat.id), or(...refs)))
    .limit(1);
  return referenced ? file : null;
}

/** Up to `length` bytes of a stored file from `offset`, or all of it. */
async function readBlob(
  deps: FilesDeps,
  file: Pick<FileRow, 'storageKey' | 'size'>,
  range?: { offset: number; length: number },
): Promise<Uint8Array> {
  const offset = Math.min(range?.offset ?? 0, file.size);
  const length = Math.max(0, Math.min(range?.length ?? file.size, file.size - offset));
  const handle = await open(blobPath(deps, file.storageKey), 'r');
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

const toAttachmentFile = (file: FileRow): AttachmentFile => ({
  file_id: file.id,
  name: file.name,
  mime: file.mime,
  size: file.size,
});

/** `ToolContext.attachments` for a run in `chat`; `vision` is whether its model sees images. */
export function attachmentServices(
  deps: FilesDeps,
  chat: RunChat,
  vision: boolean,
): AttachmentServices {
  const find = async (fileId: string) => {
    const file = await chatAttachment(deps.db, chat, fileId);
    if (!file) throw attachmentNotFound(fileId);
    return file;
  };
  return {
    vision,
    info: async (fileId) => toAttachmentFile(await find(fileId)),
    read: async (fileId, range) => readBlob(deps, await find(fileId), range),
  };
}

/**
 * Reads what context assembly asked for (`attachmentRequests`) from the
 * chat owner's attachments: whole images of a type models take, under the
 * byte cap, and the start of text files that decode as text. The requests
 * come from the chat's own messages; anything not the owner's, too large,
 * not text after all or missing from disk is left out, and so only named.
 */
export async function loadContextAttachments(
  deps: FilesDeps & Pick<AppDeps, 'logger'>,
  chat: RunChat,
  requests: AttachmentRequest[],
): Promise<Map<string, LoadedAttachment>> {
  const loaded = new Map<string, LoadedAttachment>();
  const ids = requests.map((r) => r.fileId).filter((id) => UUID.test(id));
  const files = new Map(
    (await ownedAttachments(deps.db, { id: chat.ownerId, workspaceId: chat.workspaceId }, ids)).map(
      (f) => [f.id, f],
    ),
  );
  for (const request of requests) {
    const file = files.get(request.fileId);
    if (!file) continue;
    try {
      if (request.as === 'image') {
        if (!VISION_IMAGE_TYPES.includes(file.mime) || file.size > request.maxBytes) continue;
        const bytes = await readBlob(deps, file);
        loaded.set(file.id, {
          as: 'image',
          mediaType: file.mime,
          data: Buffer.from(bytes).toString('base64'),
        });
      } else if (attachmentKind(file.mime, file.name) === 'text') {
        const bytes = await readBlob(deps, file, { offset: 0, length: request.maxBytes });
        const decoded = decodeText(bytes);
        if (!decoded) continue;
        loaded.set(file.id, {
          as: 'text',
          text: decoded.text,
          size: file.size,
          truncated: decoded.end < file.size,
        });
      }
    } catch (error) {
      deps.logger.warn({ err: error, fileId: file.id }, 'attachment not loaded for the context');
    }
  }
  return loaded;
}
