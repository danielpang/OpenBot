import { z } from 'zod';
import { matchCatalog } from './policy.js';
import type { ConnectorKind, TransportConfig } from './types.js';

// Pasted `{"mcpServers": {...}}` JSON (T2), the format Claude Desktop, Cursor
// and most MCP READMEs use; VS Code's `{"servers": {...}}` is accepted too.
// Every env value of a stdio server and every header of an HTTP server is
// treated as a secret: they are where API keys go in that format, and sealing
// a harmless value costs nothing.

const StdioEntry = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const HttpEntry = z.looseObject({
  type: z.enum(['http', 'streamable-http', 'streamableHttp', 'sse']).optional(),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ImportSchema = z.union([
  z.looseObject({ mcpServers: z.record(z.string(), z.unknown()) }),
  z.looseObject({ servers: z.record(z.string(), z.unknown()) }),
]);

export interface ImportedConnector {
  name: string;
  slug: string;
  kind: ConnectorKind;
  catalogId: string | null;
  config: TransportConfig;
  /** Secret values to seal; never stored in `config`. */
  secrets: Record<string, string>;
}

export interface ImportResult {
  connectors: ImportedConnector[];
  errors: { name: string; message: string }[];
}

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A connector slug: lowercase letters, digits and single hyphens, so `<slug>__<tool>` stays unambiguous. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'connector';
}

const ENV_SAFE = /[^A-Z0-9_]/g;
/** The secret that holds an HTTP header's value. */
export const headerSecretName = (header: string) =>
  `HEADER_${header.toUpperCase().replace(ENV_SAFE, '_')}`;

export class ImportError extends Error {}

/** Parses pasted JSON; throws `ImportError` when it is not an `mcpServers` document at all. */
export function parseMcpServers(input: string | unknown): ImportResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ImportError('That is not valid JSON.');
    }
  }
  const doc = ImportSchema.safeParse(raw);
  if (!doc.success) throw new ImportError('Expected an object with an "mcpServers" key.');
  const servers = ('mcpServers' in doc.data ? doc.data.mcpServers : doc.data.servers) as Record<
    string,
    unknown
  >;

  const result: ImportResult = { connectors: [], errors: [] };
  const taken = new Set<string>();
  for (const [name, entry] of Object.entries(servers)) {
    const imported = importOne(name, entry);
    if ('message' in imported) {
      result.errors.push({ name, message: imported.message });
      continue;
    }
    let slug = imported.slug;
    for (let n = 2; taken.has(slug); n++) slug = `${imported.slug.slice(0, 29)}-${n}`;
    taken.add(slug);
    result.connectors.push({ ...imported, slug });
  }
  return result;
}

function importOne(name: string, entry: unknown): ImportedConnector | { message: string } {
  if (entry && typeof entry === 'object' && 'command' in entry) {
    const parsed = StdioEntry.safeParse(entry);
    if (!parsed.success)
      return { message: 'A stdio server needs a "command" string and string "args".' };
    const { command, args = [], env = {}, cwd } = parsed.data;
    const config: TransportConfig = {
      transport: 'stdio',
      command,
      args,
      env: {},
      ...(cwd ? { cwd } : {}),
    };
    return {
      name,
      slug: slugify(name),
      kind: 'mcp_stdio',
      catalogId: matchCatalog(config),
      config,
      secrets: { ...env },
    };
  }
  if (entry && typeof entry === 'object' && ('url' in entry || 'serverUrl' in entry)) {
    const e = entry as Record<string, unknown>;
    const parsed = HttpEntry.safeParse({ ...e, url: e.url ?? e.serverUrl });
    if (!parsed.success) return { message: 'An HTTP server needs a valid "url".' };
    if (parsed.data.type === 'sse') {
      return { message: 'The legacy SSE transport is not supported; use the Streamable HTTP URL.' };
    }
    const secrets: Record<string, string> = {};
    const secretHeaders: Record<string, string> = {};
    let bearer: string | undefined;
    for (const [header, value] of Object.entries(parsed.data.headers ?? {})) {
      const match = /^Bearer\s+(.+)$/i.exec(value);
      if (header.toLowerCase() === 'authorization' && match) {
        bearer = match[1]!;
        continue;
      }
      const secret = headerSecretName(header);
      secrets[secret] = value;
      secretHeaders[header] = secret;
    }
    if (bearer) secrets.BEARER_TOKEN = bearer;
    const config: TransportConfig = {
      transport: 'http',
      url: parsed.data.url,
      auth: bearer ? 'bearer' : 'none',
      ...(bearer ? { bearerSecret: 'BEARER_TOKEN' } : {}),
      headers: {},
      ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}),
    };
    return {
      name,
      slug: slugify(name),
      kind: 'mcp_http',
      catalogId: matchCatalog(config),
      config,
      secrets,
    };
  }
  return { message: 'Each server needs either a "command" (stdio) or a "url" (HTTP).' };
}
