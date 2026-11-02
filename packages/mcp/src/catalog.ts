import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ConnectorKindSchema, HttpAuthSchema } from './types.js';

// One-click connectors for the Connectors page (plan 8, T2). The data lives in
// `catalog.json` at the package root so it can be edited without touching
// code. Stdio entries pin an exact package version: a connector added from
// the catalog always runs the catalog's command, never one the user typed
// (plan 17, "pinned versions in the MCP catalog").
//
// Args and stdio env values may name a secret or param as `{{NAME}}`, or as
// `{{NAME|without_password}}` and `{{NAME|password}}` for a URL, so a
// password can travel in the environment rather than in argv, which every
// process on the host can read (S-9).
//
// The server image installs every stdio entry's package from the lockfile in
// `docker/mcp-catalog`, and `catalogLaunch` runs that install's binary
// directly. `command` and `args` are the `npx` form of the same server,
// used only from source when the dev fallback is on, since `npx` downloads
// the package and its unpinned dependencies at run time (S-20).

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The icons the web app ships (`apps/web/src/features/tools/icons.tsx`):
 * Simple Icons brand marks, a few generic glyphs, and `lettermark` for a
 * brand whose logo we may not use, drawn from the entry's name. Nothing is
 * fetched at run time.
 */
export const CATALOG_ICONS = [
  'cloudflare',
  'github',
  'gmail',
  'googledocs',
  'neon',
  'postgresql',
  'railway',
  'supabase',
  'vercel',
  'database',
  'folder',
  'globe',
  'mail',
  'network',
  'plug',
  'search',
  'lettermark',
] as const;
export type CatalogIcon = (typeof CATALOG_ICONS)[number];

export const CatalogSecretSchema = z.strictObject({
  /** Env var name for stdio servers; also usable as `{{NAME}}` in args. */
  name: z.string().regex(NAME),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean(),
  /** A URL whose host must be on the public internet; private and internal hosts are refused (S-3). */
  public_host: z.boolean().optional(),
});
export type CatalogSecret = z.infer<typeof CatalogSecretSchema>;

/** A non-secret setting substituted into stdio args as `{{name}}`. */
export const CatalogParamSchema = z.strictObject({
  name: z.string().regex(NAME),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean(),
  /**
   * A relative path inside the owner's own directory on the server; the
   * server substitutes the absolute path and refuses anything outside (S-3).
   */
  user_dir: z.boolean().optional(),
});
export type CatalogParam = z.infer<typeof CatalogParamSchema>;

export const CatalogOAuthSchema = z.strictObject({
  scopes: z.array(z.string()),
  /** Whether the authorization server accepts RFC 7591 registration; otherwise the user brings a client id. */
  dynamic_registration: z.boolean(),
  /** Where to create an OAuth app when dynamic registration is unavailable. */
  client_setup_url: z.url().optional(),
  /**
   * Extra query parameters for the authorization URL, such as Google's
   * `access_type=offline`, without which it issues no refresh token.
   */
  authorization_params: z.record(z.string().regex(/^[a-z_]+$/), z.string()).optional(),
});
export type CatalogOAuth = z.infer<typeof CatalogOAuthSchema>;

export const CatalogEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1),
    description: z.string(),
    kind: ConnectorKindSchema,
    icon: z.enum(CATALOG_ICONS),
    homepage: z.url().optional(),
    /** The pinned package version; null for vendor-hosted remote servers and built-ins. */
    version: z.string().nullable(),
    /** What the stdio command needs on the server's PATH. */
    runtime: z.enum(['node', 'python']).optional(),
    stdio: z
      .strictObject({
        /** The executable in `node_modules/.bin` of the catalog install. */
        bin: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
        /** `npx`, with args `-y`, the pinned `package@version`, then the server's own args. */
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string().regex(NAME), z.string()).optional(),
      })
      .optional(),
    http: z
      .strictObject({
        url: z.url(),
        auth: z.array(HttpAuthSchema).min(1),
        /** The secret sent as `Authorization: Bearer` when auth is `bearer`. */
        bearer_secret: z.string().regex(NAME).optional(),
      })
      .optional(),
    /** The first-party tool group (leaf 2.3) a built-in entry stands for. */
    builtin: z.string().optional(),
    params: z.array(CatalogParamSchema).optional(),
    secrets: z.array(CatalogSecretSchema),
    oauth: CatalogOAuthSchema.optional(),
  })
  .refine(
    (e) =>
      (e.kind === 'mcp_stdio') === Boolean(e.stdio) &&
      (e.kind === 'mcp_http') === Boolean(e.http) &&
      (e.kind === 'builtin') === Boolean(e.builtin),
    { message: 'stdio entries need `stdio`, http entries `http`, built-ins `builtin`' },
  )
  .refine((e) => !e.http?.auth.includes('oauth') || Boolean(e.oauth), {
    message: 'entries offering oauth need `oauth` metadata',
  })
  .refine(
    (e) =>
      !e.http?.auth.includes('bearer') || e.secrets.some((s) => s.name === e.http?.bearer_secret),
    { message: '`bearer_secret` must name one of the entry secrets' },
  )
  .refine((e) => e.kind !== 'mcp_stdio' || e.version !== null, {
    message: 'stdio entries pin a version',
  })
  .refine(
    (e) =>
      !e.stdio ||
      (e.stdio.command === 'npx' &&
        e.stdio.args[0] === '-y' &&
        Boolean(e.stdio.args[1]?.endsWith(`@${e.version}`))),
    { message: 'stdio entries run `npx -y package@version`' },
  );
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z
  .strictObject({ version: z.literal(1), entries: z.array(CatalogEntrySchema) })
  .refine((c) => new Set(c.entries.map((e) => e.id)).size === c.entries.length, {
    message: 'entry ids must be unique',
  });
export type Catalog = z.infer<typeof CatalogSchema>;

/** `catalog.json` sits one level above both `src/` and `dist/`. */
export const CATALOG_URL = new URL('../catalog.json', import.meta.url);

let cached: Catalog | undefined;

export function loadCatalog(): Catalog {
  cached ??= CatalogSchema.parse(JSON.parse(readFileSync(CATALOG_URL, 'utf8')));
  return cached;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return loadCatalog().entries.find((e) => e.id === id);
}

function urlPart(value: string, filter: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // handled below
  }
  if (!url?.host) {
    // Not a URL with a host: never put a value that may hold a password in argv.
    return filter === 'password' || value.includes('@') ? '' : value;
  }
  if (filter === 'password') return decodeURIComponent(url.password);
  url.password = '';
  return url.toString();
}

/** Fills `{{NAME}}`, `{{NAME|without_password}}` and `{{NAME|password}}` from `values`; unknown names become empty. */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(
    /\{\{([A-Za-z_][A-Za-z0-9_]*)(?:\|(without_password|password))?\}\}/g,
    (_, name: string, filter: string | undefined) => {
      const value = values[name] ?? '';
      return filter && value ? urlPart(value, filter) : value;
    },
  );
}

// --- Launching stdio entries (S-20) ---------------------------------------------

/** Where the server image installs the catalog's stdio servers. */
export const DEFAULT_CATALOG_INSTALL_DIR = '/opt/openbots/mcp';

export interface CatalogInstall {
  /** The directory holding the catalog install's `node_modules`. */
  dir: string;
  /** From source only: run `npx` when the binary is not installed. */
  allowNpx: boolean;
}

/** The pinned npm package of a stdio entry, as `name@version`. */
export function catalogPackage(entry: CatalogEntry): string {
  if (!entry.stdio) throw new Error(`${entry.id} is not a stdio catalog entry.`);
  return entry.stdio.args[1]!;
}

/** The command and unsubstituted args a stdio catalog entry starts with. */
export function catalogLaunch(
  entry: CatalogEntry,
  install: CatalogInstall,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  const stdio = entry.stdio;
  if (!stdio) throw new Error(`${entry.id} is not a stdio catalog entry.`);
  const bin = join(install.dir, 'node_modules', '.bin', stdio.bin);
  if (exists(bin)) return { command: bin, args: stdio.args.slice(2) };
  if (install.allowNpx) return { command: stdio.command, args: stdio.args };
  throw new Error(
    `${entry.name} is not installed: ${bin} is missing. The server image installs it; ` +
      `from source, run \`npm ci\` in docker/mcp-catalog and point OPENBOTS_MCP_DIR there, ` +
      `or set OPENBOTS_MCP_NPX_FALLBACK=true to download ${catalogPackage(entry)} with npx.`,
  );
}
