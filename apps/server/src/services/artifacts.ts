import type { Readable } from 'node:stream';
import type {
  ArtifactBody,
  ArtifactChange,
  ArtifactServices,
  ArtifactWrite,
} from '@openbots/agent';
import {
  applyUnifiedPatch,
  artifactFileName,
  artifactMime,
  diffSummary,
  isTextMime,
  mimeForName,
  PatchError,
} from '@openbots/artifacts';
import { isTextArtifactKind, wsEvent, type ArtifactKind } from '@openbots/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { DomainError, notFound } from '../errors.js';
import { assertBotOwner } from '../ownership.js';
import { openFile, storeFile, uploadLimit } from './files.js';

// Artifacts (plan 4.8, 12.1; A1, A2, A4). Every write, by a run or by the
// owner, is a new `artifact_versions` row whose blob is a `files` row (1.4's
// store; `storage_key` holds the file id). Under a row lock on the Artifact
// the next version number is taken, the blob stored, the version inserted and
// `current_version_id` advanced, all in one transaction, so concurrent writers
// get consecutive versions and the pointer never lags. Text kinds (document,
// code, data) hold text only and store a `+14 −10` line summary against the
// previous version; file and design kinds may also hold bytes (a PDF, a PNG
// published from the computer, A3), stored as they are with the type the
// bytes show. Only text kinds take the owner's edit (plan 12.1). The upload
// limit caps every version. Writes publish `artifact.created` or
// `artifact.updated` after commit.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ArtifactDeps = Pick<AppDeps, 'db' | 'config' | 'infra'>;

export type ArtifactRow = typeof schema.artifacts.$inferSelect;
export type ArtifactVersionRow = typeof schema.artifactVersions.$inferSelect;

/** Who wrote a version: a run of the Artifact's Bot, or the owner editing it (A2). */
export type Author = { runId: string } | { userId: string };

export interface ArtifactRecord {
  artifact: ArtifactRow;
  version: ArtifactVersionRow | null;
}

export interface WriteResult {
  artifact: ArtifactRow;
  version: ArtifactVersionRow;
  added: number | null;
  removed: number | null;
}

export const invalidPatch = (message: string) => new DomainError(400, 'INVALID_PATCH', message);

const notText = (kind: ArtifactKind) =>
  new DomainError(
    409,
    'NOT_TEXT',
    `A ${kind} Artifact holds text only. Publish a binary file as a file or design Artifact.`,
  );

const notEditable = (kind: ArtifactKind) =>
  new DomainError(
    409,
    'NOT_EDITABLE',
    `Only document, code and data Artifacts can be edited here. Download this ${kind} to change it.`,
  );

export async function createArtifact(
  deps: ArtifactDeps,
  owner: Owner,
  input: {
    title: string;
    kind: ArtifactKind;
    botId?: string | null;
    chatId?: string | null;
  } & ArtifactBody,
  author: Author,
): Promise<WriteResult> {
  if ('bytes' in input && isTextArtifactKind(input.kind)) throw notText(input.kind);
  const result = await deps.db.transaction(async (tx) => {
    const [artifact] = await tx
      .insert(schema.artifacts)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        botId: input.botId ?? null,
        chatId: input.chatId ?? null,
        kind: input.kind,
        title: input.title,
      })
      .returning();
    return addVersion({ ...deps, db: tx }, owner, artifact!, null, input, author);
  });
  await announce(deps, 'artifact.created', result, author);
  return result;
}

/**
 * A new version from whole content, bytes, or a unified-diff patch against the
 * current text. The owner (a `userId` author) may only edit the text kinds.
 */
export async function writeArtifact(
  deps: ArtifactDeps,
  owner: Owner,
  artifactId: string,
  change: ArtifactChange,
  author: Author,
  options: { baseVersion?: number } = {},
): Promise<WriteResult> {
  const result = await deps.db.transaction(async (tx) => {
    const [artifact] = await tx
      .select()
      .from(schema.artifacts)
      .where(ownedBy(owner, artifactId))
      .for('update');
    if (!artifact) throw notFound('Artifact not found');
    if ('userId' in author && !isTextArtifactKind(artifact.kind)) throw notEditable(artifact.kind);
    if ('bytes' in change && isTextArtifactKind(artifact.kind)) throw notText(artifact.kind);
    const current = await currentVersion(tx, artifact);
    if (options.baseVersion !== undefined && current?.version !== options.baseVersion) {
      throw new DomainError(
        409,
        'VERSION_CONFLICT',
        `The Artifact is at version ${current?.version ?? 0}, not ${options.baseVersion}; reload it and edit again`,
      );
    }
    if ('patch' in change && current && !isTextMime(current.mime)) {
      throw invalidPatch('The current version is a binary file, so a patch cannot apply to it');
    }
    const scoped = { ...deps, db: tx };
    // The previous text is needed for a patch and for the text kinds' diff summary.
    const before =
      current && ('patch' in change || isTextArtifactKind(artifact.kind))
        ? await versionText(scoped, owner, current)
        : '';
    let body: ArtifactBody;
    if ('patch' in change) {
      try {
        body = { content: applyUnifiedPatch(before, change.patch) };
      } catch (error) {
        if (error instanceof PatchError) throw invalidPatch(error.message);
        throw error;
      }
    } else {
      body = change;
    }
    return addVersion(scoped, owner, artifact, current, body, author, before);
  });
  await announce(deps, 'artifact.updated', result, author);
  return result;
}

async function addVersion(
  deps: ArtifactDeps,
  owner: Owner,
  artifact: ArtifactRow,
  previous: ArtifactVersionRow | null,
  body: ArtifactBody,
  author: Author,
  before = '',
): Promise<WriteResult> {
  const text = 'content' in body ? body.content : null;
  // Text gets its type from the title and kind; bytes get the type they show,
  // sniffed by the files store with the title's extension as the claim.
  const declared =
    text !== null
      ? artifactMime(artifact.kind, artifact.title, text)
      : (mimeForName(artifact.title) ?? 'application/octet-stream');
  const file = await storeFile(deps, owner, {
    name: artifactFileName(artifact.title, declared),
    bytes: 'bytes' in body ? body.bytes : new TextEncoder().encode(body.content),
    declaredMime: declared,
    purpose: 'artifact',
  });
  const mime = text !== null ? declared : file.mime;
  const diff =
    text !== null && isTextArtifactKind(artifact.kind) ? diffSummary(before, text) : null;
  const [version] = await deps.db
    .insert(schema.artifactVersions)
    .values({
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      version: (previous?.version ?? 0) + 1,
      storageKey: file.id,
      mime,
      size: file.size,
      summary: diff?.summary ?? null,
      createdByRunId: 'runId' in author ? author.runId : null,
      createdByUserId: 'userId' in author ? author.userId : null,
    })
    .returning();
  const [updated] = await deps.db
    .update(schema.artifacts)
    .set({ currentVersionId: version!.id, updatedAt: new Date() })
    .where(eq(schema.artifacts.id, artifact.id))
    .returning();
  return {
    artifact: updated!,
    version: version!,
    added: diff?.added ?? null,
    removed: diff?.removed ?? null,
  };
}

async function announce(
  deps: ArtifactDeps,
  type: 'artifact.created' | 'artifact.updated',
  { artifact, version }: WriteResult,
  author: Author,
) {
  const scope = {
    ...(artifact.chatId ? { chat_id: artifact.chatId } : {}),
    ...(artifact.botId ? { bot_id: artifact.botId } : {}),
  };
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      type,
      {
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        version: version.version,
        summary: version.summary,
        createdBy: 'runId' in author ? 'bot' : 'user',
      },
      scope,
    ),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownedBy(owner: Owner, artifactId: string) {
  // The model may pass any string as an id; one that is not a uuid is simply not found.
  if (!UUID.test(artifactId)) throw notFound('Artifact not found');
  return and(
    eq(schema.artifacts.id, artifactId),
    eq(schema.artifacts.ownerId, owner.id),
    eq(schema.artifacts.workspaceId, owner.workspaceId),
  );
}

async function currentVersion(db: Db, artifact: ArtifactRow) {
  if (!artifact.currentVersionId) return null;
  const [row] = await db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.id, artifact.currentVersionId));
  return row ?? null;
}

/** The owner's Artifact with its current version; another user's is not found. */
export async function getArtifact(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  artifactId: string,
): Promise<ArtifactRecord> {
  const [artifact] = await deps.db
    .select()
    .from(schema.artifacts)
    .where(ownedBy(owner, artifactId));
  if (!artifact) throw notFound('Artifact not found');
  return { artifact, version: await currentVersion(deps.db, artifact) };
}

/** Every version, newest first. */
export async function listVersions(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  artifactId: string,
): Promise<{ artifact: ArtifactRow; versions: ArtifactVersionRow[] }> {
  const { artifact } = await getArtifact(deps, owner, artifactId);
  const versions = await deps.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
    .orderBy(desc(schema.artifactVersions.version));
  return { artifact, versions };
}

/** One version (the current one without `version`) and a stream of its bytes. */
export async function openVersion(
  deps: Pick<AppDeps, 'db' | 'config'>,
  owner: Owner,
  artifactId: string,
  version?: number,
): Promise<ArtifactRecord & { opened: ArtifactVersionRow; stream: Readable }> {
  const record = await getArtifact(deps, owner, artifactId);
  let opened = record.version;
  if (version !== undefined && version !== opened?.version) {
    const [row] = await deps.db
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.artifactId, record.artifact.id),
          eq(schema.artifactVersions.version, version),
        ),
      );
    opened = row ?? null;
  }
  if (!opened) throw notFound('Version not found');
  const { stream } = await openFile(deps, owner, opened.storageKey);
  return { ...record, opened, stream };
}

async function versionText(
  deps: Pick<AppDeps, 'db' | 'config'>,
  owner: Owner,
  version: ArtifactVersionRow,
) {
  const { stream } = await openFile(deps, owner, version.storageKey);
  return readText(stream);
}

export async function readText(stream: Readable): Promise<string> {
  return (await readBytes(stream)).toString('utf8');
}

export async function readBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A Bot's Artifacts with their current versions, most recently updated first (A4). */
export async function listBotArtifacts(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  botId: string,
): Promise<ArtifactRecord[]> {
  await assertBotOwner(deps.db, owner, botId);
  const rows = await deps.db
    .select({ artifact: schema.artifacts, version: schema.artifactVersions })
    .from(schema.artifacts)
    .leftJoin(
      schema.artifactVersions,
      eq(schema.artifactVersions.id, schema.artifacts.currentVersionId),
    )
    .where(
      and(
        eq(schema.artifacts.botId, botId),
        eq(schema.artifacts.ownerId, owner.id),
        eq(schema.artifacts.workspaceId, owner.workspaceId),
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.createdAt));
  return rows;
}

/** The artifact tools' backend for one run: written as the run, scoped to the Bot's owner. */
export function artifactServices(
  deps: ArtifactDeps,
  run: { id: string; chatId: string | null },
  bot: { id: string; ownerId: string; workspaceId: string },
): ArtifactServices {
  const owner = { id: bot.ownerId, workspaceId: bot.workspaceId };
  const author = { runId: run.id };
  const toWrite = ({ artifact, version, added, removed }: WriteResult): ArtifactWrite => ({
    artifact_id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    version: version.version,
    ...(added !== null && removed !== null ? { added, removed } : {}),
  });
  return {
    create: async (input) =>
      toWrite(
        await createArtifact(deps, owner, { ...input, botId: bot.id, chatId: run.chatId }, author),
      ),
    update: async (id, change) => toWrite(await writeArtifact(deps, owner, id, change, author)),
    read: async (id, version) => {
      const {
        artifact,
        version: current,
        opened,
        stream,
      } = await openVersion(deps, owner, id, version);
      const described = {
        artifact_id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        version: opened.version,
        current_version: current?.version ?? opened.version,
        mime: opened.mime,
        size: opened.size,
      };
      if (isTextMime(opened.mime)) return { ...described, content: await readText(stream) };
      stream.destroy();
      return {
        ...described,
        note: 'This version is a binary file. Copy it to your computer with artifact_to_computer to work with it.',
      };
    },
    readBytes: async (id, version) => {
      const { artifact, opened, stream } = await openVersion(deps, owner, id, version);
      return {
        artifact_id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        version: opened.version,
        mime: opened.mime,
        bytes: new Uint8Array(await readBytes(stream)),
      };
    },
    byteLimit: () => uploadLimit(deps, owner.workspaceId),
  };
}
