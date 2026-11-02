import type { MessagePart } from '@openbots/shared';

// Attachments in the context (plan 5.3; C1, C9). The owner's images and files
// arrive as `image` and `file` parts by file id, in their messages and in
// other Bots' replies (`attach_file`). Context assembly gives the model what
// it can use, newest first, within a budget per run:
//
// - an image, to a model with vision, as image input (at most
//   `ATTACHMENT_LIMITS.images`, each at most `imageBytes`);
// - a text file (text/*, JSON, CSV, markdown, source code) inline, framed as
//   data in <attachment> (P2), up to `textBytes` each and `totalTextBytes` in
//   all, with a note when it is cut;
// - anything else (a PDF, an archive) as a line naming it, as are images a
//   model without vision cannot see. `read_attachment` and
//   `attachment_to_computer` reach the bytes (tools/attachments.ts).
//
// The agent decides what to load (`attachmentRequests`); the server reads the
// bytes, only for files the chat's messages reference and its owner uploaded.

export const ATTACHMENT_LIMITS = {
  /** Images shown per run, newest first. */
  images: 4,
  /** The largest image shown, in bytes (the strictest provider limit, Anthropic's 5 MB). */
  imageBytes: 5 * 1024 * 1024,
  /** Bytes of one text file inlined, and what one `read_attachment` call returns. */
  textBytes: 32 * 1024,
  /** Bytes of text inlined across a run's attachments. */
  totalTextBytes: 96 * 1024,
} as const;

/** Image types every provider with vision takes. */
export const VISION_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export type AttachmentKind = 'image' | 'text' | 'binary';

const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'image/svg+xml',
]);

/** Extensions read as text whatever type the browser declared (`.ts` often arrives as video/mp2t). */
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl ndjson yaml yml toml ini cfg conf env log xml html htm css ' +
    'scss less svg js mjs cjs ts tsx jsx py rb go rs java kt kts c h cpp hpp cc cs sh bash zsh fish ' +
    'sql php swift lua r pl scala clj ex exs erl hs ml vue svelte graphql gql proto tf dockerfile ' +
    'makefile gradle diff patch tex rst adoc org'
  ).split(' '),
);

const extension = (name: string) => {
  const base = name.toLowerCase().split('/').at(-1) ?? '';
  if (base === 'dockerfile' || base === 'makefile') return base;
  return /\.([a-z0-9]+)$/.exec(base)?.[1] ?? '';
};

/** How an attachment can reach the model, from its stored type and name. */
export function attachmentKind(mime: string, name = ''): AttachmentKind {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  if (VISION_IMAGE_TYPES.includes(type)) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || /\+(json|xml)$/.test(type)) {
    return 'text';
  }
  // A known binary container is never text, whatever its name says.
  if (type.startsWith('image/') || type === 'application/pdf' || type.includes('zip')) {
    return 'binary';
  }
  return TEXT_EXTENSIONS.has(extension(name)) ? 'text' : 'binary';
}

export type AttachmentPart = Extract<MessagePart, { type: 'image' | 'file' }>;

export const isAttachmentPart = (part: MessagePart): part is AttachmentPart =>
  part.type === 'image' || part.type === 'file';

/** What the server is asked to read for one attachment. */
export interface AttachmentRequest {
  fileId: string;
  as: 'image' | 'text';
  /** Read at most this many bytes (an image larger than this is not shown). */
  maxBytes: number;
}

/** An attachment the server read for the context. */
export type LoadedAttachment =
  | {
      as: 'image';
      mediaType: string;
      /** Base64, so a paused run's state stays JSON. */ data: string;
    }
  | {
      as: 'text';
      text: string;
      /** The file's size in bytes; `truncated` when the text is only its start. */
      size: number;
      truncated: boolean;
    };

/** What context assembly knows about the run's attachments. */
export interface ContextAttachments {
  /** The model can take image input. */
  vision: boolean;
  /** Loaded content by file id; an attachment missing here is named, not shown. */
  loaded: ReadonlyMap<string, LoadedAttachment>;
}

/** No content loaded: every attachment is a line naming it and how to read it. */
export const namedAttachments = (vision: boolean): ContextAttachments => ({
  vision,
  loaded: new Map(),
});

/**
 * The attachments to load for a context, newest first and each file once,
 * within `ATTACHMENT_LIMITS`. The Bot's own messages are skipped: they replay
 * as assistant turns, which take no images.
 */
export function attachmentRequests(
  messages: { author: { self?: boolean }; parts: MessagePart[] }[],
  { vision }: { vision: boolean },
): AttachmentRequest[] {
  const requests: AttachmentRequest[] = [];
  const seen = new Set<string>();
  let images = 0;
  let textBytes = 0;
  for (const message of [...messages].reverse()) {
    if (message.author.self) continue;
    for (const part of [...message.parts].reverse()) {
      if (!isAttachmentPart(part) || seen.has(part.file_id)) continue;
      seen.add(part.file_id);
      const kind = attachmentKind(part.mime, part.name);
      if (kind === 'image') {
        const fits = (part.size ?? 0) <= ATTACHMENT_LIMITS.imageBytes;
        if (!vision || !fits || images >= ATTACHMENT_LIMITS.images) continue;
        images++;
        requests.push({
          fileId: part.file_id,
          as: 'image',
          maxBytes: ATTACHMENT_LIMITS.imageBytes,
        });
      } else if (kind === 'text') {
        const left = ATTACHMENT_LIMITS.totalTextBytes - textBytes;
        if (left <= 0) continue;
        const maxBytes = Math.min(ATTACHMENT_LIMITS.textBytes, left);
        textBytes += Math.min(part.size ?? maxBytes, maxBytes);
        requests.push({ fileId: part.file_id, as: 'text', maxBytes });
      }
    }
  }
  return requests;
}

/**
 * The longest prefix of `bytes` that ends on a whole UTF-8 character, so a
 * cut never splits one. Leading continuation bytes (a read that starts inside
 * a character) are skipped; `start` says how many.
 */
export function utf8Slice(bytes: Uint8Array): { start: number; end: number } {
  let start = 0;
  while (start < Math.min(3, bytes.length) && (bytes[start]! & 0xc0) === 0x80) start++;
  let end = bytes.length;
  // Walk back over a trailing partial character.
  for (let i = end - 1; i >= Math.max(start, end - 4); i--) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (end - i < need) end = i;
    break;
  }
  return { start, end };
}

/**
 * The bytes as text when they look like text: no NUL byte and valid UTF-8
 * once a character cut at either end is dropped. Null otherwise.
 */
export function decodeText(bytes: Uint8Array): { text: string; start: number; end: number } | null {
  if (bytes.subarray(0, 8_192).includes(0)) return null;
  const { start, end } = utf8Slice(bytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
    return { text, start, end };
  } catch {
    return null;
  }
}

/** `1.2 MB`, `340 KB`, `12 bytes`. */
export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} bytes`;
}
