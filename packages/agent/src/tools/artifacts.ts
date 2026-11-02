import { computerPath } from '@openbots/computer';
import {
  ArtifactKindSchema,
  DEFAULT_LIMITS,
  isTextArtifactKind,
  type ArtifactKind,
  type MessagePart,
} from '@openbots/shared';
import { z } from 'zod';
import { attachmentTools } from './attachments.js';
import { defineTool, type AnyAgentTool, type ToolContext, type ToolGroup } from './types.js';

// Artifact tools (plan 12.1, A1): documents, code, data, designs and files the
// Bot creates and updates, every write a new version. The server supplies the
// backend (`ArtifactServices`, apps/server/src/services/artifacts.ts), which
// stores the version, applies patches and publishes `artifact.created` or
// `artifact.updated`; the run loop adds the card part after the result. The
// policy runs the group without asking: it only writes OpenBots storage.
//
// `publish_artifact` and `artifact_to_computer` move files between the
// Artifacts and the Bot's computer (A3); without a computer they answer a
// tool error. A text file is published as text; a binary one (a PDF, an
// image) as its bytes, which only the file and design kinds hold, up to the
// server's upload limit.

export const COMPUTER_UNAVAILABLE = 'the computer is not available on this install';

/** Characters of content one create or update may carry; the server's upload limit also applies. */
export const MAX_ARTIFACT_CHARS = 1_000_000;

/** A stored version, as the tools return it. */
export interface ArtifactWrite {
  artifact_id: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  /** Lines added and removed against the previous version (text kinds). */
  added?: number;
  removed?: number;
}

export interface ArtifactContent {
  artifact_id: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  current_version: number;
  mime: string;
  size: number;
  /** The text; absent for a binary version, which `note` explains. */
  content?: string;
  note?: string;
}

export interface ArtifactBytes {
  artifact_id: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  mime: string;
  bytes: Uint8Array;
}

/** A version's content: text, or bytes (file and design kinds only). */
export type ArtifactBody = { content: string } | { bytes: Uint8Array };

export type ArtifactChange = ArtifactBody | { patch: string };

/** The run's Artifacts, written as the run (`created_by_run_id`) and scoped to the Bot's owner. */
export interface ArtifactServices {
  create(input: { title: string; kind: ArtifactKind } & ArtifactBody): Promise<ArtifactWrite>;
  update(id: string, change: ArtifactChange): Promise<ArtifactWrite>;
  /** The current version, or `version`; throws when the owner has no such Artifact. */
  read(id: string, version?: number): Promise<ArtifactContent>;
  /** The version's bytes, text or not, for copying it to the computer. */
  readBytes(id: string, version?: number): Promise<ArtifactBytes>;
  /** The largest version the server stores, in bytes; defaults to `DEFAULT_LIMITS.uploadBytes`. */
  byteLimit?(): Promise<number>;
}

const ArtifactId = z.string().min(1).max(100).describe('The artifact_id from create_artifact');
const Content = z.string().max(MAX_ARTIFACT_CHARS);

export const createArtifact = defineTool({
  description:
    'Create an Artifact: a document, code, data, design or file the owner can open, edit, ' +
    'download and see the versions of. Use it for anything longer than a short answer or ' +
    'meant to be kept. Documents are markdown; data is JSON or CSV; designs are SVG. Put the ' +
    'file extension in the title when it matters (main.py, rows.csv). The owner sees a card.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(200),
    kind: ArtifactKindSchema,
    content: Content,
  }),
  async execute(input, ctx) {
    const written = await artifacts(ctx).create(input);
    return { created: true, ...written };
  },
});

export const updateArtifact = defineTool({
  description:
    'Write a new version of an Artifact: either the whole new `content`, or a `patch` as a ' +
    'unified diff (@@ hunks with a few lines of context) against the current version, which ' +
    'is cheaper for small edits to a long text. Send exactly one of the two. Earlier versions ' +
    'are kept.',
  inputSchema: z
    .object({
      id: ArtifactId,
      content: Content.optional(),
      patch: z.string().min(1).max(MAX_ARTIFACT_CHARS).optional(),
    })
    .refine((a) => (a.content === undefined) !== (a.patch === undefined), {
      message: 'Send exactly one of content and patch',
    }),
  async execute({ id, content, patch }, ctx) {
    const change = patch !== undefined ? { patch } : { content: content ?? '' };
    const written = await artifacts(ctx).update(id, change);
    return { updated: true, ...written };
  },
});

export const readArtifact = defineTool({
  description:
    'Read an Artifact: the current version, or an earlier one by number. A binary version ' +
    '(a PDF, an image) comes back without content; copy it to your computer to work with it.',
  inputSchema: z.object({
    id: ArtifactId,
    version: z.number().int().positive().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async execute({ id, version }, ctx) {
    return artifacts(ctx).read(id, version);
  },
});

const ComputerPath = z.string().trim().min(1).max(1_000);

const extension = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

/** The kind a published file gets, from its extension. */
export function kindForPath(path: string): ArtifactKind {
  const ext = extension(path);
  if (['md', 'markdown', 'txt', 'html'].includes(ext)) return 'document';
  if (['csv', 'tsv', 'json', 'yaml', 'yml', 'xml'].includes(ext)) return 'data';
  if (['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'design';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'file';
}

/** Extensions published as bytes even when the content happens to decode as text. */
const BINARY_EXTENSIONS = new Set('pdf png jpg jpeg webp gif zip gz'.split(' '));

/** The file's text when it is UTF-8 without NUL bytes and not a known binary type, else null. */
export function fileText(path: string, bytes: Uint8Array): string | null {
  if (BINARY_EXTENSIONS.has(extension(path)) || bytes.subarray(0, 8_192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const CODE_EXTENSIONS = new Set(
  'js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs sh bash zsh sql css scss php swift lua r toml ini dockerfile makefile'.split(
    ' ',
  ),
);

export const publishArtifact = defineTool({
  description:
    'Publish a file from your computer as an Artifact the owner can open and download: text ' +
    'files (documents, code, data) they can also edit, and binary files such as a PDF or an ' +
    'image. Pass the `id` of an Artifact to publish the file as its new version instead of ' +
    'creating one; a document, code or data Artifact takes text files only.',
  inputSchema: z.object({
    path: ComputerPath.describe('Path on the computer; relative paths are under /home/bot'),
    title: z.string().trim().min(1).max(200).optional().describe('Defaults to the file name'),
    id: ArtifactId.optional(),
  }),
  async execute({ path, title, id }, ctx) {
    if (!ctx.computer) throw new Error(COMPUTER_UNAVAILABLE);
    const absolute = computerPath(path, { withinHome: true });
    const services = artifacts(ctx);
    const limit = (await services.byteLimit?.()) ?? DEFAULT_LIMITS.uploadBytes;
    const tooLarge = () => new Error(`${absolute} is too large to publish (over ${limit} bytes)`);
    const agent = await ctx.computer.agent();
    // Check the size before holding the whole file in memory.
    const response = await agent.openFile(absolute, ctx.computer.signal);
    if (Number(response.headers.get('content-length') ?? 0) > limit) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw tooLarge();
    const content = fileText(absolute, bytes);
    if (content !== null && content.length > MAX_ARTIFACT_CHARS) throw tooLarge();
    const body = content !== null ? { content } : { bytes };
    if (id) {
      const written = await services.update(id, body);
      return { updated: true, path: absolute, ...written };
    }
    const name = title ?? absolute.split('/').at(-1) ?? 'file';
    let kind = kindForPath(name);
    // A binary file named like text (`dump.json`) is still a file.
    if (content === null && isTextArtifactKind(kind)) kind = 'file';
    const written = await services.create({ title: name, kind, ...body });
    return { created: true, path: absolute, ...written };
  },
});

export const artifactToComputer = defineTool({
  description:
    'Copy an Artifact (its current version, or `version`) into a file on your computer, replacing the file if it exists.',
  inputSchema: z.object({
    id: ArtifactId,
    path: ComputerPath.describe('Path on the computer; relative paths are under /home/bot'),
    version: z.number().int().positive().optional(),
  }),
  async execute({ id, path, version }, ctx) {
    if (!ctx.computer) throw new Error(COMPUTER_UNAVAILABLE);
    const absolute = computerPath(path, { withinHome: true });
    const artifact = await artifacts(ctx).readBytes(id, version);
    const agent = await ctx.computer.agent();
    const { size } = await agent.writeFile(absolute, artifact.bytes, ctx.computer.signal);
    return {
      copied: true,
      path: absolute,
      size,
      artifact_id: artifact.artifact_id,
      title: artifact.title,
      version: artifact.version,
    };
  },
});

/** The card part a create or update adds to the run's message, after the result. */
export function artifactCardPart(toolName: string, output: unknown): MessagePart | null {
  if (!['create_artifact', 'update_artifact', 'publish_artifact'].includes(toolName)) return null;
  const written = output as (ArtifactWrite & { created?: boolean; updated?: boolean }) | undefined;
  if (!written?.created && !written?.updated) return null;
  return {
    type: 'artifact',
    artifact_id: written.artifact_id,
    title: written.title,
    kind: written.kind,
    version: written.version,
  };
}

function artifacts(ctx: ToolContext): ArtifactServices {
  if (!ctx.artifacts) throw new Error('Artifacts are not available in this run');
  return ctx.artifacts;
}

/** Artifacts, and the chat's attachments beside them (tools/attachments.ts). */
export const artifactTools: ToolGroup = {
  name: 'artifacts',
  tools: (ctx): Record<string, AnyAgentTool> => ({
    ...(ctx.artifacts
      ? {
          create_artifact: createArtifact,
          update_artifact: updateArtifact,
          read_artifact: readArtifact,
          publish_artifact: publishArtifact,
          artifact_to_computer: artifactToComputer,
        }
      : {}),
    ...attachmentTools(ctx),
  }),
};
