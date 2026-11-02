import type { ArtifactKind } from '@openbots/shared';

// The mime type an Artifact version is stored and downloaded with: from the
// title's extension when it has a known one, else the kind's default. Text
// versions take a text type; binary versions (file and design kinds only:
// PDFs, raster images, archives) take the type their bytes show, which the
// server sniffs with this table's guess as the declared type.

const BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  cs: 'text/x-csharp',
  sh: 'text/x-shellscript',
  sql: 'application/sql',
  css: 'text/css',
  pdf: 'application/pdf',
  png: 'image/png',
  // `jpg` first: a download of an `image/jpeg` version is named `.jpg`.
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  zip: 'application/zip',
};

/** Types that are not text: a version of one is stored and served as bytes. */
export const BINARY_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/zip',
  'application/gzip',
  'application/octet-stream',
]);

const TEXT_MIMES = new Set([
  'application/json',
  'application/yaml',
  'application/xml',
  'application/sql',
  'image/svg+xml',
]);

/** Whether a version of this type is text the viewer can show and a patch can apply to. */
export function isTextMime(mime: string): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || TEXT_MIMES.has(type);
}

/** The type a file name's extension suggests, if it is one this table knows. */
export function mimeForName(name: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase();
  return ext ? BY_EXTENSION[ext] : undefined;
}

const BY_KIND: Record<ArtifactKind, string> = {
  document: 'text/markdown',
  code: 'text/plain',
  data: 'application/json',
  design: 'image/svg+xml',
  file: 'text/plain',
};

/** The type of a text version: a binary extension on the title (`chart.png`) is ignored. */
export function artifactMime(kind: ArtifactKind, title: string, content: string): string {
  const known = mimeForName(title);
  if (known && !BINARY_MIMES.has(known)) return known;
  if (kind === 'data' && !looksLikeJson(content)) return 'text/csv';
  if (kind === 'design' && !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(content)) return 'text/plain';
  return BY_KIND[kind];
}

/** The file name a download gets: the title, plus an extension for its mime type. */
export function artifactFileName(title: string, mime: string): string {
  const base = title.trim().replace(/[\\/]+/g, '-') || 'artifact';
  if (/\.[A-Za-z0-9]+$/.test(base)) return base;
  const known = Object.entries(BY_EXTENSION).find(([, m]) => m === mime)?.[0];
  const ext = known ?? (isTextMime(mime) ? 'txt' : 'bin');
  return `${base}.${ext}`;
}

function looksLikeJson(content: string) {
  const text = content.trim();
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
