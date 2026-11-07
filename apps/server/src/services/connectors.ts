import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { COMPUTER_HOME, type McpStdioLaunch } from '@openbots/computer';
import {
  ComputerStdioHost,
  DEFAULT_CATALOG_INSTALL_DIR,
  HttpHost,
  McpManager,
  OAuthSetupError,
  StdioHost,
  TransportConfigSchema,
  blockedBy,
  catalogEntry,
  catalogLaunch,
  discoverServer,
  emptySecrets,
  finishOAuth,
  giveTo,
  headerSecretName,
  loadCatalog,
  matchCatalog,
  needsRefresh,
  parseMcpServers,
  parseState,
  refreshOAuth,
  slugify,
  startOAuth,
  substitute,
  toolPermitted,
  unprivilegedUser,
  verifyState,
  type ApprovalOverride,
  type BlockRule,
  type CatalogEntry,
  type CatalogInstall,
  type ConnectorKind,
  type ConnectorSession,
  type ConnectorStatus,
  type HttpAuth,
  type McpSnapshot,
  type McpTool,
  type OAuthMode,
  type SealedSecrets,
  type StdioSpawn,
  type ToolCallResult,
  type TransportConfig,
} from '@openbots/mcp';
import { wsEvent, type Unsubscribe } from '@openbots/shared';
import { and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { isPublicAddress, netFetch, type NetOptions } from '../builtins/net.js';
import { publishEvent } from '../infra/index.js';
import type { StdioRunner } from '../config.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { assertBotOwner } from '../ownership.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { isOrgAdmin, storedSettings, type Role } from '../workspace.js';
import {
  GitHubAppAuthorizationError,
  beginGitHubDevice,
  pollGitHubDevice,
  refreshGitHubDevice,
  hasGitHubInstallation,
  githubInstallationUrl,
  type DevicePoll,
} from './github-device.js';
import { computerStdioSpec } from './computer-stdio.js';
import { MCP_CONTROL_CHANNEL, type McpControl } from './mcp-control.js';
import { connectorWorkspace, currentWorkspace, inWorkspace, outsideScope } from '../db/scope.js';

// Connectors (plan 4.4, 8; T1 to T3, P3). Connectors belong to a user and
// every one of their Bots may use them, narrowed per Bot by `bot_connectors`
// (T1). Secret values, OAuth clients and tokens are sealed together in
// `connectors.secrets` and only opened here, to start a session or refresh a
// token; responses say which secrets are set and nothing more. Env and header
// values of custom servers are secrets too, so responses carry their names
// only (S-9). Admins block catalog entries or URL patterns in
// `connector_policy`, or allow only listed catalog entries (U3); a blocked
// connector cannot be created, started or called and reads as "Disabled by
// admin" (T3).
//
// A custom stdio server runs any command on the server, so only admins may
// add one, and only once an admin turns `customStdioEnabled` on (S-1).
// Catalog stdio servers run their pinned command; the filesystem server is
// confined to its owner's directory and Postgres URLs must name a public host
// (S-3).
//
// A tool's MCP readOnlyHint lets it run without asking only for catalog
// connectors and connectors an admin marked `trusted` (S-16). Only admins set
// the flag, and changing the command or URL clears it.
//
// Sessions run in whichever process calls a tool (the worker for runs, the API
// for Test). Each process keeps one `McpManager` per `AppDeps`. A stdio
// server is a child of that process (OPENBOTS_STDIO_RUNNER=host, the
// self-hosted default) or runs in its owner's computer (`computer`, the
// managed default; computer-stdio.ts), where it is restarted after a crash.
// Streamable HTTP sessions and every OAuth request (discovery, registration,
// token and refresh) go through the outbound guard, so they reach public
// addresses only (S-8). An admin can mark an HTTP connector `local` when its server
// runs on their own network; its requests may then reach private addresses,
// still through the guard's pinned lookup. Changing the URL clears the mark.

type Viewer = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ConnectorsDeps = Pick<AppDeps, 'db' | 'config' | 'logger' | 'net'> &
  Partial<Pick<AppDeps, 'infra'>>;

export type ConnectorRow = typeof schema.connectors.$inferSelect;
export type ConnectorToolRow = typeof schema.connectorTools.$inferSelect;

export const DISABLED_BY_ADMIN = 'Disabled by admin';

export interface ConnectorRecord {
  row: ConnectorRow;
  config: TransportConfig;
  params: Record<string, string>;
  /** Every secret name the connector knows of, with whether a value is stored. */
  secrets: { name: string; label: string | null; required: boolean; set: boolean }[];
  /** Environment variable names of a stdio connector; the values are sealed (S-9). */
  env: string[] | null;
  /** Header names of an HTTP connector; the values are sealed (S-9). */
  headers: string[] | null;
  oauth: {
    clientConfigured: boolean;
    connected: boolean;
    expiresAt: Date | null;
    installationUrl?: string;
  } | null;
  disabledByAdmin: boolean;
  toolCount: number;
}

export interface ConnectorInput {
  catalogId?: string;
  name?: string;
  slug?: string;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auth?: HttpAuth;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  secrets?: Record<string, string>;
  oauthClient?: { clientId: string; clientSecret?: string; githubAppSlug?: string };
}

export interface ConnectorPatch {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auth?: HttpAuth;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** A value sets the secret, null removes it; names not listed are kept. */
  secrets?: Record<string, string | null>;
  oauthClient?: { clientId: string; clientSecret?: string; githubAppSlug?: string } | null;
}

const invalid = (code: string, message: string) => new DomainError(400, code, message);
export const connectorBlocked = () =>
  new DomainError(
    403,
    'CONNECTOR_BLOCKED',
    // Said to a self-hosted owner as well, who set the policy themselves.
    'This connector is blocked by the connector policy.',
  );

/** What anyone can add instead of a custom command (S-1): said in every refusal. */
const STDIO_INSTEAD = 'Add it from the catalog or by its HTTP URL instead.';

export const customStdioAdminOnly = () =>
  new DomainError(
    403,
    'CUSTOM_STDIO_ADMIN_ONLY',
    `Only an admin can add a command (stdio) server. ${STDIO_INSTEAD}`,
  );
export const customStdioUnavailable = () =>
  new DomainError(
    403,
    'CUSTOM_STDIO_UNAVAILABLE',
    `Command (stdio) servers are not available on the hosted service. ${STDIO_INSTEAD}`,
  );
export const customStdioDisabled = () =>
  new DomainError(
    403,
    'CUSTOM_STDIO_DISABLED',
    `Command (stdio) servers are off for this workspace. ${STDIO_INSTEAD}`,
  );

const keyring = (deps: Pick<AppDeps, 'config'>) => keyringFromConfig(deps.config);

export const oauthRedirectUrl = (deps: Pick<AppDeps, 'config'>) =>
  `${deps.config.publicUrl.replace(/\/+$/, '')}/api/v1/connectors/oauth/callback`;

// --- Sealed secrets -------------------------------------------------------------

export function openSecrets(
  deps: Pick<AppDeps, 'config'>,
  row: Pick<ConnectorRow, 'secrets'>,
): SealedSecrets {
  if (!row.secrets) return emptySecrets();
  const parsed = JSON.parse(decryptSecretString(row.secrets, keyring(deps))) as SealedSecrets;
  return { ...parsed, values: parsed.values ?? {} };
}

function sealSecrets(deps: Pick<AppDeps, 'config'>, secrets: SealedSecrets): Buffer | null {
  const empty = !Object.keys(secrets.values).length && !secrets.oauth;
  return empty ? null : encryptSecret(JSON.stringify(secrets), keyring(deps));
}

/** Replaces every secret value in `text`, so errors from a server never echo a token back (P3). */
export function scrub(text: string, secrets: SealedSecrets): string {
  const values = [
    ...Object.values(secrets.values),
    secrets.oauth?.tokens?.access_token,
    secrets.oauth?.tokens?.refresh_token,
    secrets.oauth?.client?.client_secret,
    secrets.oauth?.device?.deviceCode,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 4);
  let out = text;
  for (const v of values.sort((a, b) => b.length - a.length)) out = out.split(v).join('***');
  return out.slice(0, 2000);
}

/**
 * Moves env values and header values out of the stored config into the
 * sealed secrets (S-9): stdio env becomes secrets of the same name, which
 * reach the child as env; each header becomes `HEADER_<NAME>` with a
 * `secretHeaders` entry. Values given here replace stored ones.
 */
function sealValues(transport: TransportConfig, secrets: SealedSecrets): TransportConfig {
  if (transport.transport === 'stdio' && Object.keys(transport.env).length) {
    Object.assign(secrets.values, transport.env);
    return { ...transport, env: {} };
  }
  if (transport.transport === 'http' && Object.keys(transport.headers).length) {
    const secretHeaders = { ...transport.secretHeaders };
    for (const [header, value] of Object.entries(transport.headers)) {
      const name = headerSecretName(header);
      secrets.values[name] = value;
      secretHeaders[header] = name;
    }
    return { ...transport, headers: {}, secretHeaders };
  }
  return transport;
}

// --- Config ---------------------------------------------------------------------

export interface StoredConfig {
  transport: TransportConfig;
  params: Record<string, string>;
}

/** `connectors.config` holds the transport config plus `params` and `discovered` (resources, prompts). */
export function readConfig(row: Pick<ConnectorRow, 'config'>): StoredConfig {
  const {
    params,
    discovered: _discovered,
    ...rest
  } = (row.config ?? {}) as Record<string, unknown>;
  return {
    transport: TransportConfigSchema.parse(rest),
    params: (params as Record<string, string> | undefined) ?? {},
  };
}

function writeConfig(stored: StoredConfig, discovered?: unknown): Record<string, unknown> {
  return {
    ...stored.transport,
    ...(Object.keys(stored.params).length ? { params: stored.params } : {}),
    ...(discovered ? { discovered } : {}),
  };
}

const kindOf = (config: TransportConfig): ConnectorKind =>
  config.transport === 'stdio' ? 'mcp_stdio' : config.transport === 'http' ? 'mcp_http' : 'builtin';

function configFromCatalog(entry: CatalogEntry, input: ConnectorInput): TransportConfig {
  if (entry.stdio) {
    // The stored command is informational; `sessionFor` always re-reads the catalog's pinned one.
    return { transport: 'stdio', command: entry.stdio.command, args: entry.stdio.args, env: {} };
  }
  if (entry.http) {
    const hasBearer = Boolean(
      entry.http.bearer_secret && input.secrets?.[entry.http.bearer_secret],
    );
    const auth = input.auth ?? (hasBearer ? 'bearer' : entry.http.auth[0]!);
    if (!entry.http.auth.includes(auth)) {
      throw invalid(
        'INVALID_AUTH',
        `${entry.name} supports ${entry.http.auth.join(' or ')} sign-in.`,
      );
    }
    return {
      transport: 'http',
      url: entry.http.url,
      auth,
      ...(entry.http.bearer_secret ? { bearerSecret: entry.http.bearer_secret } : {}),
      headers: {},
      ...(entry.oauth ? { scopes: entry.oauth.scopes } : {}),
    };
  }
  return { transport: 'builtin', builtin: entry.builtin! };
}

function customConfig(
  input: ConnectorInput | ConnectorPatch,
  base?: TransportConfig,
): TransportConfig {
  const transport =
    base?.transport ??
    ('transport' in input ? input.transport : undefined) ??
    (input.url ? 'http' : 'stdio');
  if (transport === 'stdio') {
    const prev = base?.transport === 'stdio' ? base : undefined;
    const command = input.command ?? prev?.command;
    if (!command) throw invalid('INVALID_CONNECTOR', 'A stdio connector needs a command.');
    return {
      transport: 'stdio',
      command,
      args: input.args ?? prev?.args ?? [],
      env: input.env ?? prev?.env ?? {},
      ...(prev?.cwd ? { cwd: prev.cwd } : {}),
    };
  }
  if (transport === 'http') {
    const prev = base?.transport === 'http' ? base : undefined;
    const url = input.url ?? prev?.url;
    if (!url) throw invalid('INVALID_CONNECTOR', 'An HTTP connector needs a URL.');
    const auth = input.auth ?? prev?.auth ?? 'none';
    return {
      transport: 'http',
      url,
      auth,
      ...(auth === 'bearer' ? { bearerSecret: prev?.bearerSecret ?? 'BEARER_TOKEN' } : {}),
      headers: input.headers ?? prev?.headers ?? {},
      ...(prev?.secretHeaders ? { secretHeaders: prev.secretHeaders } : {}),
      ...(prev?.scopes ? { scopes: prev.scopes } : {}),
    };
  }
  throw invalid('INVALID_CONNECTOR', 'Built-in connectors come from the catalog.');
}

/**
 * The S-9 data migration: before it, custom connectors kept env and header
 * values in plain `config`. Seals every such value into `secrets`, keeping a
 * stored secret where both have the name, as sessions did. Runs at start-up,
 * after the schema migrations; SQL cannot do it because sealing needs the
 * master key. Returns how many connectors changed.
 */
export async function sealPlaintextConnectorValues(
  deps: Pick<AppDeps, 'db' | 'config' | 'logger'>,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.connectors)
      .where(inArray(schema.connectors.kind, ['mcp_stdio', 'mcp_http']))
      .for('update');
    let changed = 0;
    for (const row of rows) {
      let stored: StoredConfig;
      let secrets: SealedSecrets;
      try {
        stored = readConfig(row);
        secrets = openSecrets(deps, row);
      } catch (err) {
        deps.logger.warn({ connectorId: row.id, err }, 'cannot seal connector values');
        continue;
      }
      const moved: SealedSecrets = { values: {} };
      let transport = sealValues(stored.transport, moved);
      if (transport === stored.transport) continue;
      secrets.values = { ...moved.values, ...secrets.values };
      if (transport.transport === 'http' && stored.transport.transport === 'http') {
        transport = {
          ...transport,
          secretHeaders: { ...transport.secretHeaders, ...stored.transport.secretHeaders },
        };
      }
      const discovered = (row.config as { discovered?: unknown }).discovered;
      await tx
        .update(schema.connectors)
        .set({
          config: writeConfig({ transport, params: stored.params }, discovered),
          secrets: sealSecrets(deps, secrets),
        })
        .where(eq(schema.connectors.id, row.id));
      changed++;
    }
    return changed;
  });
}

// --- Block and allow lists (T3, U3) ---------------------------------------------

/** The block list and the allow list (`blocked = false` rows) as rules for `blockedBy`. */
export async function blockRules(db: Db, workspaceId: string): Promise<BlockRule[]> {
  const rows = await db
    .select({
      catalogId: schema.connectorPolicy.catalogId,
      urlPattern: schema.connectorPolicy.urlPattern,
      blocked: schema.connectorPolicy.blocked,
    })
    .from(schema.connectorPolicy)
    .where(eq(schema.connectorPolicy.workspaceId, workspaceId))
    .orderBy(asc(schema.connectorPolicy.createdAt));
  return rows.map((r) => ({
    catalogId: r.catalogId,
    urlPattern: r.urlPattern,
    ...(r.blocked ? {} : { allow: true }),
  }));
}

export const isBlocked = (row: Pick<ConnectorRow, 'catalogId' | 'config'>, rules: BlockRule[]) => {
  let config: TransportConfig | null = null;
  try {
    config = readConfig(row).transport;
  } catch {
    // An unreadable config still matches by catalog id.
  }
  return blockedBy({ catalogId: row.catalogId, config }, rules) !== null;
};

export interface ConnectorPolicy {
  catalogIds: string[];
  urlPatterns: string[];
  /** When non-empty, only these catalog entries may be used (U3). */
  allowedCatalogIds: string[];
}

export interface ConnectorPolicyInput {
  catalogIds: string[];
  urlPatterns: string[];
  /** Left out, the allow list stays as it is. */
  allowedCatalogIds?: string[];
}

export async function getConnectorPolicy(db: Db, viewer: Viewer): Promise<ConnectorPolicy> {
  const rules = await blockRules(db, viewer.workspaceId);
  const blocks = rules.filter((r) => !r.allow);
  return {
    catalogIds: blocks.flatMap((r) => (r.catalogId ? [r.catalogId] : [])),
    urlPatterns: blocks.flatMap((r) => (r.urlPattern ? [r.urlPattern] : [])),
    allowedCatalogIds: rules.flatMap((r) => (r.allow && r.catalogId ? [r.catalogId] : [])),
  };
}

/** Replaces the block list (and the allow list when given) and stops every running session they now block. */
export async function putConnectorPolicy(
  deps: ConnectorsDeps,
  admin: Viewer,
  input: ConnectorPolicyInput,
): Promise<ConnectorPolicy> {
  const catalogIds = [...new Set(input.catalogIds)];
  const urlPatterns = [...new Set(input.urlPatterns.map((p) => p.trim()).filter(Boolean))];
  const allowedCatalogIds = [
    ...new Set(
      input.allowedCatalogIds ?? (await getConnectorPolicy(deps.db, admin)).allowedCatalogIds,
    ),
  ];
  for (const id of [...catalogIds, ...allowedCatalogIds]) {
    if (!catalogEntry(id)) throw invalid('UNKNOWN_CATALOG_ID', `No catalog entry "${id}".`);
  }
  const both = catalogIds.filter((id) => allowedCatalogIds.includes(id));
  if (both.length) {
    throw invalid('POLICY_CONFLICT', `"${both[0]}" cannot be both blocked and allowed.`);
  }
  await deps.db.transaction(async (tx) => {
    await tx
      .delete(schema.connectorPolicy)
      .where(eq(schema.connectorPolicy.workspaceId, admin.workspaceId));
    const rows = [
      ...catalogIds.map((catalogId) => ({ catalogId, urlPattern: null, blocked: true })),
      ...urlPatterns.map((urlPattern) => ({ catalogId: null, urlPattern, blocked: true })),
      ...allowedCatalogIds.map((catalogId) => ({ catalogId, urlPattern: null, blocked: false })),
    ].map((r) => ({ ...r, workspaceId: admin.workspaceId, setBy: admin.id }));
    if (rows.length) await tx.insert(schema.connectorPolicy).values(rows);
    await tx.insert(schema.auditLog).values({
      workspaceId: admin.workspaceId,
      actorType: 'user',
      actorId: admin.id,
      action: 'connector_policy.update',
      targetType: 'workspace',
      targetId: admin.workspaceId,
      metadata: { catalogIds, urlPatterns, allowedCatalogIds },
    });
  });
  const rules = await blockRules(deps.db, admin.workspaceId);
  const rows = await deps.db
    .select()
    .from(schema.connectors)
    .where(eq(schema.connectors.workspaceId, admin.workspaceId));
  await stopSessions(
    deps,
    rows.filter((r) => isBlocked(r, rules)).map((r) => r.id),
  );
  return getConnectorPolicy(deps.db, admin);
}

// --- Custom stdio (S-1) ----------------------------------------------------------

/** A stdio connector that runs its own command, not a catalog entry's pinned one. */
export function isCustomStdio(row: Pick<ConnectorRow, 'kind' | 'catalogId'>): boolean {
  return row.kind === 'mcp_stdio' && !(row.catalogId && catalogEntry(row.catalogId)?.stdio);
}

/**
 * Why the user may not run custom stdio servers, or null: they must be an
 * admin, with the setting on. Never where the install keeps them off
 * (OPENBOTS_CUSTOM_STDIO, off by default on the managed service, where the
 * command would run on a server every organization shares; plan 21.6).
 */
export async function customStdioRefusal(
  deps: { db: Db; config: Pick<AppDeps['config'], 'customStdio'> },
  workspaceId: string,
  userId: string,
): Promise<DomainError | null> {
  if (!deps.config.customStdio) return customStdioUnavailable();
  const { db } = deps;
  const [member] = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  if (!isOrgAdmin(member?.role as Role | undefined)) return customStdioAdminOnly();
  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  if (!workspace || !storedSettings(workspace).customStdioEnabled) return customStdioDisabled();
  return null;
}

// --- Confined catalog settings (S-3) --------------------------------------------

/**
 * The owner's own directory, where catalog `user_dir` params (the filesystem
 * root) point. One per (organization, owner) on the managed service (plan
 * 21.3); a self-hosted install has one organization and keeps its old name.
 */
export function userDirectory(
  config: Pick<AppDeps['config'], 'filesDir' | 'deployment'>,
  owner: { id: string; workspaceId: string },
) {
  const name = config.deployment === 'managed' ? `${owner.workspaceId}_${owner.id}` : owner.id;
  return path.join(path.resolve(config.filesDir), 'connectors', name);
}

const pathRefused = (label: string) =>
  invalid(
    'INVALID_PATH',
    `${label} must be a folder inside your own directory, such as notes or projects/site.`,
  );

/** A `user_dir` value as a clean relative path; absolute paths and `..` are refused. */
function relativeUserPath(value: string, label: string): string {
  const slashed = value.trim().replace(/\\/g, '/');
  if (slashed.includes('\0') || path.posix.isAbsolute(slashed)) throw pathRefused(label);
  if (slashed.split('/').includes('..')) throw pathRefused(label);
  const normal = path.posix.normalize(slashed || '.').replace(/\/+$/, '');
  return normal === '' ? '.' : normal;
}

/** Creates the folder under the owner's directory and returns its absolute path, refusing symlinks out. */
function confinedFolder(
  deps: Pick<AppDeps, 'config'>,
  owner: { id: string; workspaceId: string },
  value: string,
  label: string,
) {
  const base = userDirectory(deps.config, owner);
  const relative = relativeUserPath(value, label);
  const target = path.resolve(base, relative);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const realBase = realpathSync(base);
  const real = realpathSync(target);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw pathRefused(label);
  const user = unprivilegedUser();
  if (user) {
    // The files directory and `connectors/` only to pass through (see files-dir.ts),
    // then every folder from the owner's directory down, so the dropped user can reach the target.
    for (const dir of [path.dirname(path.dirname(base)), path.dirname(base)]) {
      try {
        chmodSync(dir, 0o711);
      } catch {
        // Not ours (a mounted directory): it is as traversable as its owner made it.
      }
    }
    const parts = relative === '.' ? [] : relative.split('/');
    for (let i = 0; i <= parts.length; i++) giveTo(path.join(base, ...parts.slice(0, i)), user);
  }
  return real;
}

/** Refuses a URL whose host is private, internal or unresolvable (S-3): the database, Redis, the LAN. */
export async function assertPublicHost(label: string, value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('INVALID_URL', `${label} is not a valid URL.`);
  }
  // libpq reads a host from the query too, which would bypass the check.
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw invalid('INVALID_URL', `${label} must name its host before the path, not in the query.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw invalid('INVALID_URL', `${label} needs a host.`);
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    addresses = [];
  }
  if (!addresses.length) {
    throw invalid('PRIVATE_HOST', `${label}: ${host} could not be resolved.`);
  }
  if (addresses.some((a) => !isPublicAddress(a))) {
    throw invalid(
      'PRIVATE_HOST',
      `${label}: ${host} is a private or internal address. Connectors can only reach public hosts.`,
    );
  }
}

/** The variables a catalog stdio server may get from its owner: the secrets its entry declares. */
const declaredEnv = (entry: CatalogEntry) => new Set(entry.secrets.map((s) => s.name));

/** Checks catalog settings and secrets that must stay confined, normalizing `user_dir` params in place. */
async function checkConfined(
  entry: CatalogEntry | undefined,
  params: Record<string, string>,
  secrets: SealedSecrets,
) {
  // Every secret of a stdio server reaches it as env, so one the entry does
  // not declare (NODE_OPTIONS on a custom server the catalog matched) could
  // make the pinned package run something else.
  if (entry?.stdio) {
    const declared = declaredEnv(entry);
    const extra = Object.keys(secrets.values).find((name) => !declared.has(name));
    if (extra) {
      throw invalid(
        'UNDECLARED_ENV',
        `${entry.name} runs the catalog's pinned package, which takes no "${extra}" variable.`,
      );
    }
  }
  for (const p of entry?.params ?? []) {
    if (p.user_dir && params[p.name] !== undefined) {
      params[p.name] = relativeUserPath(params[p.name]!, p.label);
    }
  }
  for (const s of entry?.secrets ?? []) {
    const value = secrets.values[s.name];
    if (s.public_host && value) await assertPublicHost(s.label, value);
  }
}

// --- Catalog --------------------------------------------------------------------

export async function catalogWithPolicy(db: Db, viewer: Viewer) {
  const rules = await blockRules(db, viewer.workspaceId);
  return loadCatalog().entries.map((entry) => {
    const config =
      entry.kind === 'builtin' ? null : configFromCatalog(entry, { auth: entry.http?.auth[0] });
    return { entry, disabledByAdmin: blockedBy({ catalogId: entry.id, config }, rules) !== null };
  });
}

// --- Records --------------------------------------------------------------------

function toRecord(
  deps: Pick<AppDeps, 'config'>,
  row: ConnectorRow,
  rules: BlockRule[],
  toolCount: number,
  /** Whether the owner may not run custom stdio servers (S-1). */
  stdioRefused: boolean,
): ConnectorRecord {
  const stored = readConfig(row);
  const secrets = openSecrets(deps, row);
  const entry = row.catalogId ? catalogEntry(row.catalogId) : undefined;
  const names = new Map<string, { label: string | null; required: boolean }>();
  for (const s of entry?.secrets ?? []) names.set(s.name, { label: s.label, required: s.required });
  for (const name of Object.keys(secrets.values)) {
    if (!names.has(name)) names.set(name, { label: null, required: false });
  }
  const http = stored.transport.transport === 'http' ? stored.transport : null;
  const stdio = stored.transport.transport === 'stdio' ? stored.transport : null;
  const tokens = secrets.oauth?.tokens;
  return {
    row,
    config: stored.transport,
    params: stored.params,
    secrets: [...names].map(([name, meta]) => ({ name, ...meta, set: name in secrets.values })),
    // Every secret of a stdio server reaches it as an environment variable.
    env: stdio ? [...new Set([...Object.keys(stdio.env), ...Object.keys(secrets.values)])] : null,
    headers: http
      ? [...new Set([...Object.keys(http.headers), ...Object.keys(http.secretHeaders ?? {})])]
      : null,
    oauth:
      http?.auth === 'oauth'
        ? {
            clientConfigured: Boolean(
              secrets.oauth?.client ||
              (isGitHubConnector(row) &&
                deps.config.githubConnectorClientId &&
                deps.config.githubConnectorAppSlug),
            ),
            connected: Boolean(tokens),
            expiresAt: tokens?.expires_at ? new Date(tokens.expires_at) : null,
            ...(isGitHubConnector(row) && githubAppSlug(deps, secrets)
              ? { installationUrl: githubInstallationUrl(githubAppSlug(deps, secrets)!) }
              : {}),
          }
        : null,
    disabledByAdmin: isBlocked(row, rules) || (stdioRefused && isCustomStdio(row)),
    toolCount,
  };
}

async function connectorRow(db: Db, viewer: Viewer, id: string): Promise<ConnectorRow> {
  const [row] = await db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.id, id),
        eq(schema.connectors.ownerId, viewer.id),
        eq(schema.connectors.workspaceId, viewer.workspaceId),
      ),
    );
  if (!row) throw notFound('Connector not found');
  return row;
}

async function toolCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: schema.connectorTools.connectorId, n: count() })
    .from(schema.connectorTools)
    .where(inArray(schema.connectorTools.connectorId, ids))
    .groupBy(schema.connectorTools.connectorId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

export async function listConnectors(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: Viewer,
): Promise<ConnectorRecord[]> {
  const rows = await deps.db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, viewer.id),
        eq(schema.connectors.workspaceId, viewer.workspaceId),
      ),
    )
    .orderBy(asc(schema.connectors.createdAt));
  const [rules, counts, refusal] = await Promise.all([
    blockRules(deps.db, viewer.workspaceId),
    toolCounts(
      deps.db,
      rows.map((r) => r.id),
    ),
    customStdioRefusal(deps, viewer.workspaceId, viewer.id),
  ]);
  return rows.map((r) => toRecord(deps, r, rules, counts.get(r.id) ?? 0, refusal !== null));
}

export async function getConnector(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: Viewer,
  id: string,
): Promise<ConnectorRecord> {
  const row = await connectorRow(deps.db, viewer, id);
  const [rules, counts, refusal] = await Promise.all([
    blockRules(deps.db, viewer.workspaceId),
    toolCounts(deps.db, [id]),
    customStdioRefusal(deps, viewer.workspaceId, viewer.id),
  ]);
  return toRecord(deps, row, rules, counts.get(id) ?? 0, refusal !== null);
}

// --- Create, update, delete -----------------------------------------------------

function checkRequired(
  entry: CatalogEntry | undefined,
  params: Record<string, string>,
  secrets: SealedSecrets,
) {
  for (const p of entry?.params ?? []) {
    if (p.required && !params[p.name])
      throw invalid('MISSING_PARAM', `${entry!.name} needs "${p.label}".`);
  }
  for (const s of entry?.secrets ?? []) {
    if (s.required && !secrets.values[s.name]) {
      throw invalid('MISSING_SECRET', `${entry!.name} needs "${s.label}".`);
    }
  }
}

async function freeSlug(db: Db, viewer: Viewer, base: string): Promise<string> {
  const rows = await db
    .select({ slug: schema.connectors.slug })
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, viewer.id),
        eq(schema.connectors.workspaceId, viewer.workspaceId),
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const slugTaken = () =>
  new DomainError(409, 'SLUG_TAKEN', 'You already have a connector with that slug.');

function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

export async function createConnector(
  deps: ConnectorsDeps,
  viewer: Viewer,
  input: ConnectorInput,
): Promise<ConnectorRecord> {
  const entry = input.catalogId ? catalogEntry(input.catalogId) : undefined;
  if (input.catalogId && !entry)
    throw invalid('UNKNOWN_CATALOG_ID', `No catalog entry "${input.catalogId}".`);
  if (entry && (input.command || input.args || input.url)) {
    throw invalid(
      'PINNED',
      'Catalog connectors run the catalog command and URL; only settings and secrets can be given.',
    );
  }
  const secrets: SealedSecrets = { values: {} };
  const transport = entry
    ? configFromCatalog(entry, input)
    : sealValues(customConfig(input), secrets);
  Object.assign(secrets.values, input.secrets);
  const params = { ...input.params };
  if (input.oauthClient) {
    secrets.oauth = {
      client: {
        client_id: input.oauthClient.clientId,
        ...(input.oauthClient.githubAppSlug
          ? { github_app_slug: input.oauthClient.githubAppSlug }
          : {}),
        ...(input.oauthClient.clientSecret
          ? { client_secret: input.oauthClient.clientSecret }
          : {}),
      },
    };
  }
  checkRequired(entry, params, secrets);
  const catalogId = entry?.id ?? matchCatalog(transport);
  if (isCustomStdio({ kind: kindOf(transport), catalogId })) {
    const refusal = await customStdioRefusal(deps, viewer.workspaceId, viewer.id);
    if (refusal) throw refusal;
  }
  const rules = await blockRules(deps.db, viewer.workspaceId);
  if (blockedBy({ catalogId, config: transport }, rules)) throw connectorBlocked();
  await checkConfined(entry ?? (catalogId ? catalogEntry(catalogId) : undefined), params, secrets);

  const name =
    input.name ??
    entry?.name ??
    (transport.transport === 'http'
      ? new URL(transport.url).host
      : transport.transport === 'stdio'
        ? transport.command
        : 'Connector');
  if (input.slug && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(input.slug)) {
    throw invalid('INVALID_SLUG', 'Slugs are lowercase letters, digits and hyphens, at most 32.');
  }
  const slug = input.slug ?? (await freeSlug(deps.db, viewer, slugify(entry?.id ?? name)));
  let row: ConnectorRow;
  try {
    row = await deps.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.connectors)
        .values({
          workspaceId: viewer.workspaceId,
          ownerId: viewer.id,
          name,
          slug,
          kind: kindOf(transport),
          catalogId,
          config: writeConfig({ transport, params }),
          secrets: sealSecrets(deps, secrets),
          status: 'untested' satisfies ConnectorStatus,
        })
        .returning();
      await audit(tx, viewer, 'connector.create', inserted!.id, { slug, catalogId });
      return inserted!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken();
    throw err;
  }
  return toRecord(deps, row, rules, 0, false);
}

export async function updateConnector(
  deps: ConnectorsDeps,
  viewer: Viewer,
  id: string,
  patch: ConnectorPatch,
): Promise<ConnectorRecord> {
  const row = await connectorRow(deps.db, viewer, id);
  const stored = readConfig(row);
  const entry = row.catalogId ? catalogEntry(row.catalogId) : undefined;
  if (entry && (patch.command || patch.args || patch.env || patch.url)) {
    throw invalid(
      'PINNED',
      'Catalog connectors run the catalog command and URL; only settings and secrets can change.',
    );
  }
  const secrets = openSecrets(deps, row);
  let transport = stored.transport;
  if (row.kind === 'builtin') {
    if (patch.command || patch.args || patch.url || patch.auth) {
      throw invalid('INVALID_CONNECTOR', 'Built-in connectors have no transport to edit.');
    }
  } else if (entry?.http && patch.auth) {
    if (!entry.http.auth.includes(patch.auth)) {
      throw invalid(
        'INVALID_AUTH',
        `${entry.name} supports ${entry.http.auth.join(' or ')} sign-in.`,
      );
    }
    transport = {
      ...(transport as Extract<TransportConfig, { transport: 'http' }>),
      auth: patch.auth,
    };
  } else if (!entry) {
    transport = sealValues(customConfig(patch, stored.transport), secrets);
  }
  const params = { ...stored.params, ...patch.params };
  for (const [name, value] of Object.entries(patch.secrets ?? {})) {
    if (value === null) delete secrets.values[name];
    else secrets.values[name] = value;
  }
  if (patch.oauthClient !== undefined) {
    // A different client invalidates tokens issued to the old one.
    secrets.oauth = patch.oauthClient
      ? {
          client: {
            client_id: patch.oauthClient.clientId,
            ...(patch.oauthClient.githubAppSlug
              ? { github_app_slug: patch.oauthClient.githubAppSlug }
              : {}),
            ...(patch.oauthClient.clientSecret
              ? { client_secret: patch.oauthClient.clientSecret }
              : {}),
          },
        }
      : undefined;
    if (!secrets.oauth) delete secrets.oauth;
  }
  const changedUrl =
    transport.transport === 'http' && transport.url !== (stored.transport as { url?: string }).url;
  if (changedUrl) delete secrets.oauth;
  checkRequired(entry, params, secrets);
  const catalogId = entry?.id ?? matchCatalog(transport);
  if (isCustomStdio({ kind: row.kind, catalogId })) {
    const refusal = await customStdioRefusal(deps, viewer.workspaceId, viewer.id);
    if (refusal) throw refusal;
  }
  const rules = await blockRules(deps.db, viewer.workspaceId);
  if (blockedBy({ catalogId, config: transport }, rules)) throw connectorBlocked();
  await checkConfined(entry ?? (catalogId ? catalogEntry(catalogId) : undefined), params, secrets);

  const discovered = (row.config as { discovered?: unknown }).discovered;
  const changedTransport = JSON.stringify(transport) !== JSON.stringify(stored.transport);
  const [updated] = await deps.db
    .update(schema.connectors)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      catalogId,
      // Trust was given to the server as it was (S-16).
      ...(changedTransport ? { trusted: false } : {}),
      // So was the local mark: a new URL is held to public addresses again (S-8).
      ...(changedUrl ? { local: false } : {}),
      config: writeConfig({ transport, params }, discovered),
      secrets: sealSecrets(deps, secrets),
      ...(changedTransport || patch.secrets || patch.params || patch.oauthClient !== undefined
        ? { status: 'untested' satisfies ConnectorStatus, lastError: null }
        : {}),
    })
    .where(eq(schema.connectors.id, id))
    .returning();
  // Names of what changed (the command and env included, S-11), never secret values.
  await audit(deps.db, viewer, 'connector.update', id, {
    fields: Object.keys(patch).filter((k) => patch[k as keyof ConnectorPatch] !== undefined),
    ...(patch.secrets ? { secrets: Object.keys(patch.secrets) } : {}),
    ...(changedTransport ? { transport: transport.transport } : {}),
  });
  await stopSessions(deps, [id]);
  const counts = await toolCounts(deps.db, [id]);
  return toRecord(deps, updated!, rules, counts.get(id) ?? 0, false);
}

export async function deleteConnector(
  deps: ConnectorsDeps,
  viewer: Viewer,
  id: string,
): Promise<void> {
  const row = await connectorRow(deps.db, viewer, id);
  await stopSessions(deps, [id]);
  await deps.db.transaction(async (tx) => {
    await tx.delete(schema.connectors).where(eq(schema.connectors.id, id));
    await audit(tx, viewer, 'connector.delete', id, { slug: row.slug });
  });
}

/**
 * The connectors an admin's trust and local marks reach: any in a self-hosted
 * install (its one owner's), only their own on the managed service, where
 * admins do not act on members' per-user data (U2, plan 21.6).
 */
function adminReach(deps: Pick<AppDeps, 'config'>, admin: Viewer) {
  return deps.config.deployment === 'managed' ? eq(schema.connectors.ownerId, admin.id) : undefined;
}

/** Marks a connector's MCP hints trusted or not (S-16). Admins only (see `adminReach`). */
export async function setConnectorTrusted(
  deps: ConnectorsDeps,
  admin: Viewer,
  id: string,
  trusted: boolean,
): Promise<ConnectorRecord> {
  const [row] = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.connectors)
      .set({ trusted })
      .where(
        and(
          eq(schema.connectors.id, id),
          eq(schema.connectors.workspaceId, admin.workspaceId),
          adminReach(deps, admin),
        ),
      )
      .returning();
    if (updated[0]) await audit(tx, admin, 'connector.trust', id, { trusted });
    return updated;
  });
  if (!row) throw notFound('Connector not found');
  const [rules, counts, refusal] = await Promise.all([
    blockRules(deps.db, admin.workspaceId),
    toolCounts(deps.db, [id]),
    customStdioRefusal(deps, admin.workspaceId, row.ownerId),
  ]);
  return toRecord(deps, row, rules, counts.get(id) ?? 0, refusal !== null);
}

/**
 * Marks an HTTP connector as on the admin's own network, or not (S-8). Marked,
 * its MCP session and OAuth requests may reach private addresses. Admins only,
 * for any connector of the workspace.
 */
export async function setConnectorLocal(
  deps: ConnectorsDeps,
  admin: Viewer,
  id: string,
  local: boolean,
): Promise<ConnectorRecord> {
  // On the managed service the server's private network is every
  // organization's: no connector may reach it (S-8, plan 21.6).
  if (local && !deps.config.localEndpoints) {
    throw new DomainError(
      403,
      'LOCAL_UNAVAILABLE',
      'Connectors cannot reach private addresses on the hosted service.',
    );
  }
  const [row] = await deps.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ kind: schema.connectors.kind })
      .from(schema.connectors)
      .where(
        and(
          eq(schema.connectors.id, id),
          eq(schema.connectors.workspaceId, admin.workspaceId),
          adminReach(deps, admin),
        ),
      )
      .for('update');
    if (!found) return [];
    if (found.kind !== 'mcp_http') {
      throw invalid('NOT_HTTP', 'Only HTTP connectors reach the network; this one runs locally.');
    }
    const updated = await tx
      .update(schema.connectors)
      .set({ local })
      .where(eq(schema.connectors.id, id))
      .returning();
    await audit(tx, admin, 'connector.local', id, { local });
    return updated;
  });
  if (!row) throw notFound('Connector not found');
  const [rules, counts, refusal] = await Promise.all([
    blockRules(deps.db, admin.workspaceId),
    toolCounts(deps.db, [id]),
    customStdioRefusal(deps, admin.workspaceId, row.ownerId),
  ]);
  return toRecord(deps, row, rules, counts.get(id) ?? 0, refusal !== null);
}

/** Creates one connector per importable server; servers that cannot be imported come back as errors. */
export async function importConnectors(deps: ConnectorsDeps, viewer: Viewer, json: unknown) {
  const parsed = parseMcpServers(json);
  const created: ConnectorRecord[] = [];
  const errors = [...parsed.errors];
  for (const c of parsed.connectors) {
    try {
      const record = await createConnector(deps, viewer, {
        name: c.name,
        slug: await freeSlug(deps.db, viewer, c.slug),
        ...(c.config.transport === 'stdio'
          ? { transport: 'stdio', command: c.config.command, args: c.config.args }
          : c.config.transport === 'http'
            ? { transport: 'http', url: c.config.url, auth: c.config.auth }
            : {}),
        secrets: c.secrets,
      });
      if (c.config.transport === 'http' && c.config.secretHeaders) {
        // Header secrets need the mapping the custom form does not expose.
        const stored = readConfig(record.row);
        const transport = {
          ...(stored.transport as Extract<TransportConfig, { transport: 'http' }>),
        };
        transport.secretHeaders = c.config.secretHeaders;
        await deps.db
          .update(schema.connectors)
          .set({ config: writeConfig({ transport, params: stored.params }) })
          .where(eq(schema.connectors.id, record.row.id));
        created.push(await getConnector(deps, viewer, record.row.id));
      } else {
        created.push(record);
      }
    } catch (err) {
      errors.push({ name: c.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, errors };
}

// --- Sessions -------------------------------------------------------------------

// One manager per process: keyed by its config, which every deps of the
// process shares.
const managers = new WeakMap<object, McpManager>();
const listening = new WeakMap<object, Promise<Unsubscribe | null>>();
const keyOf = (deps: object) => (deps as { config?: object }).config ?? deps;
const refreshing = new Map<string, Promise<string>>();

export { MCP_CONTROL_CHANNEL, type McpControl };

/** Stops the sessions here and, through the bus, in every other process. */
async function stopSessions(deps: ConnectorsDeps, connectorIds: string[]): Promise<void> {
  if (!connectorIds.length) return;
  const manager = managers.get(keyOf(deps));
  if (manager) await Promise.all(connectorIds.map((id) => manager.stop(id)));
  await deps.infra?.bus.publish<McpControl>(MCP_CONTROL_CHANNEL, { type: 'stop', connectorIds });
}

/** Stops every custom stdio session of the workspace, in every process: they were just turned off (S-1). */
export async function stopCustomStdio(deps: ConnectorsDeps, workspaceId: string): Promise<void> {
  const rows = await deps.db
    .select({
      id: schema.connectors.id,
      kind: schema.connectors.kind,
      catalogId: schema.connectors.catalogId,
    })
    .from(schema.connectors)
    .where(
      and(eq(schema.connectors.workspaceId, workspaceId), eq(schema.connectors.kind, 'mcp_stdio')),
    );
  await stopSessions(
    deps,
    rows.filter((r) => isCustomStdio(r)).map((r) => r.id),
  );
}

/** The process's MCP manager for these deps, created with its health loop on first use. */
export function mcpManager(deps: ConnectorsDeps): McpManager {
  let manager = managers.get(keyOf(deps));
  if (!manager) {
    // One manager serves every organization: each session's callbacks work in
    // the organization that started it (db/scope.ts), and the manager's own
    // timers belong to none.
    const organizations = new Map<string, string>();
    const inItsOrganization = <T>(id: string, fn: () => Promise<T>) => {
      const workspaceId = organizations.get(id);
      return workspaceId ? inWorkspace(workspaceId, fn) : fn();
    };
    const created = outsideScope(
      () =>
        new McpManager({
          resolve: (id, context) => {
            const workspaceId = currentWorkspace();
            if (workspaceId) organizations.set(id, workspaceId);
            return sessionFor(deps, id, context);
          },
          onStarted: (id, snapshot) =>
            inItsOrganization(id, () => recordSnapshot(deps, id, snapshot)),
          onToolsChanged: (id, tools) =>
            inItsOrganization(id, () => storeTools(deps.db, id, tools)),
          onError: (id, error) => inItsOrganization(id, () => recordError(deps, id, error)),
          idleMs: deps.config.processLimits.mcpIdleStopMinutes * 60_000,
        }),
    );
    outsideScope(() => created.startHealthLoop());
    managers.set(keyOf(deps), created);
    listening.set(
      keyOf(deps),
      deps.infra
        ? deps.infra.bus
            .subscribe<McpControl>(MCP_CONTROL_CHANNEL, (control) => {
              if (control.type === 'stop') {
                for (const id of control.connectorIds) void created.stop(id);
              } else if (control.type === 'computer') {
                void inWorkspace(control.workspaceId, () =>
                  stopComputerSessions(deps, created, control),
                ).catch((error: unknown) =>
                  deps.logger.warn(
                    { err: error },
                    'stopping stdio connectors with the computer failed',
                  ),
                );
              }
            })
            .catch((error: unknown) => {
              deps.logger.warn({ err: error }, 'MCP control channel unavailable');
              return null;
            })
        : Promise.resolve(null),
    );
    manager = created;
  }
  return manager;
}

/**
 * When an owner's computer stops, their stdio servers in it end with it;
 * the remote provider's machine keeps running, so they are stopped here.
 */
async function stopComputerSessions(
  deps: ConnectorsDeps,
  manager: McpManager,
  owner: { ownerId: string; workspaceId: string },
) {
  if (deps.config.stdioRunner !== 'computer') return;
  const rows = await deps.db
    .select({ id: schema.connectors.id })
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, owner.ownerId),
        eq(schema.connectors.workspaceId, owner.workspaceId),
        eq(schema.connectors.kind, 'mcp_stdio'),
      ),
    );
  await Promise.all(rows.map((r) => manager.stop(r.id)));
}

/** Stops every session (shutdown, tests). */
export async function closeMcpManager(deps: object): Promise<void> {
  const manager = managers.get(keyOf(deps));
  const unsubscribe = listening.get(keyOf(deps));
  managers.delete(keyOf(deps));
  listening.delete(keyOf(deps));
  await (
    await unsubscribe
  )?.();
  await manager?.close();
}

class NeedsAuthError extends Error {}

async function rowById(db: Db, id: string): Promise<ConnectorRow> {
  const [row] = await db.select().from(schema.connectors).where(eq(schema.connectors.id, id));
  if (!row) throw notFound('Connector not found');
  return row;
}

const noExemptions: NetOptions = {};
const localOptions = new WeakMap<NetOptions, NetOptions>();

/**
 * The outbound guard for a connector's MCP and OAuth requests (S-8). One an
 * admin marked local may reach private addresses; it keeps the pinned lookup,
 * so an answer that changes after the lookup is still never used.
 */
function connectorFetch(deps: ConnectorsDeps, row: Pick<ConnectorRow, 'local'>): typeof fetch {
  if (!row.local) return netFetch(deps.net);
  const base = deps.net ?? noExemptions;
  let options = localOptions.get(base);
  if (!options) {
    options = { ...base, allowPrivateNetwork: true };
    localOptions.set(base, options);
  }
  return netFetch(options);
}

async function sessionFor(
  deps: ConnectorsDeps,
  id: string,
  { restart }: { restart: boolean } = { restart: false },
): Promise<ConnectorSession> {
  const row = await rowById(deps.db, id);
  const rules = await blockRules(deps.db, row.workspaceId);
  if (isBlocked(row, rules)) throw connectorBlocked();
  if (isCustomStdio(row)) {
    const refusal = await customStdioRefusal(deps, row.workspaceId, row.ownerId);
    if (refusal) throw refusal;
  }
  const stored = readConfig(row);
  const secrets = openSecrets(deps, row);
  const entry = row.catalogId ? catalogEntry(row.catalogId) : undefined;
  // Excludes `discovered` and OAuth tokens, which change without the session needing a restart.
  const version = createHash('sha256')
    .update(
      JSON.stringify([
        stored,
        secrets.values,
        secrets.oauth?.client ?? null,
        entry ?? null,
        row.local,
      ]),
    )
    .digest('hex');
  const config = stored.transport;

  if (config.transport === 'stdio' && deps.config.stdioRunner === 'computer') {
    const launch = await computerLaunchFor(deps, row);
    const owner = { id: row.ownerId, workspaceId: row.workspaceId };
    return {
      id,
      version,
      restartOnCrash: true,
      create: (options) =>
        new ComputerStdioHost(computerStdioSpec(deps, owner, launch, { restart }), options),
    };
  }
  if (config.transport === 'stdio') {
    const spec = await stdioSpawnFor(deps, row);
    return { id, version, create: (options) => new StdioHost(spec, options) };
  }
  if (config.transport === 'http') {
    const headers = { ...config.headers };
    for (const [header, secret] of Object.entries(config.secretHeaders ?? {})) {
      const value = secrets.values[secret];
      if (value) headers[header] = value;
    }
    let token: () => Promise<string | undefined>;
    if (config.auth === 'bearer') {
      const value = config.bearerSecret ? secrets.values[config.bearerSecret] : undefined;
      if (!value) throw new NeedsAuthError('Add the access token in the connector settings.');
      token = async () => value;
    } else if (config.auth === 'oauth') {
      if (!secrets.oauth?.tokens) throw new NeedsAuthError('Sign in to this connector first.');
      token = () => oauthAccessToken(deps, id);
    } else {
      token = async () => undefined;
    }
    return {
      id,
      version,
      create: (options) =>
        new HttpHost(
          { url: config.url, headers, token, fetch: connectorFetch(deps, row) },
          options,
        ),
    };
  }
  throw invalid(
    'NOT_AN_MCP_SERVER',
    'Built-in connectors are provided by OpenBots and have no MCP session.',
  );
}

/** Where the computer image installs the catalog's stdio servers: where the server image does. */
const COMPUTER_CATALOG: CatalogInstall = { dir: DEFAULT_CATALOG_INSTALL_DIR, allowNpx: false };

/**
 * What a stdio connector's child is started with on this host. Catalog
 * connectors run the catalog's pinned server from the image's install (S-20),
 * whatever the row says, with `user_dir` params confined to the owner's
 * directory and `public_host` secrets re-checked, since DNS answers change
 * (S-3). Errors are plain, so the manager stores them as the connector's last
 * error.
 */
export async function stdioSpawnFor(
  deps: Pick<AppDeps, 'config'>,
  row: ConnectorRow,
): Promise<StdioSpawn> {
  const { command, args, env, cwd } = await stdioLaunchFor(deps, row, 'host');
  return { command, args, env, homeKey: row.id, ...(cwd ? { cwd } : {}) };
}

/**
 * What a stdio connector's server is started with in its owner's computer.
 * Catalog connectors run the pinned server the computer image installs, and a
 * `user_dir` param (the filesystem server's root) is a folder of the owner's
 * files there, under the home their Bots and the file browser share; the
 * agent creates it when missing. A custom server's command runs with the
 * owner's own tools in the computer.
 */
export async function computerLaunchFor(
  deps: Pick<AppDeps, 'config'>,
  row: ConnectorRow,
): Promise<McpStdioLaunch> {
  const { command, args, env, cwd, dirs } = await stdioLaunchFor(deps, row, 'computer');
  return { command, args, env, ...(cwd ? { cwd } : {}), ...(dirs.length ? { dirs } : {}) };
}

async function stdioLaunchFor(
  deps: Pick<AppDeps, 'config'>,
  row: ConnectorRow,
  runner: StdioRunner,
): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Folders under the computer's home to create first. */
  dirs: string[];
}> {
  const stored = readConfig(row);
  const config = stored.transport;
  if (config.transport !== 'stdio') throw new Error('Not a stdio connector.');
  const secrets = openSecrets(deps, row);
  const entry = row.catalogId ? catalogEntry(row.catalogId) : undefined;
  const params = { ...stored.params };
  const dirs: string[] = [];
  try {
    for (const p of entry?.params ?? []) {
      if (!p.user_dir) continue;
      if (runner === 'computer') {
        const relative = relativeUserPath(params[p.name] ?? '', p.label);
        if (relative !== '.') dirs.push(relative);
        params[p.name] =
          relative === '.' ? COMPUTER_HOME : path.posix.join(COMPUTER_HOME, relative);
      } else {
        params[p.name] = confinedFolder(
          deps,
          { id: row.ownerId, workspaceId: row.workspaceId },
          params[p.name] ?? '',
          p.label,
        );
      }
    }
    for (const s of entry?.secrets ?? []) {
      const value = secrets.values[s.name];
      if (s.public_host && value) await assertPublicHost(s.label, value);
    }
  } catch (err) {
    throw new Error((err as Error).message, { cause: err });
  }
  const values = { ...params, ...secrets.values };
  const launch = !entry?.stdio
    ? config
    : runner === 'computer'
      ? // Installed in the computer image, not on this host.
        catalogLaunch(entry, COMPUTER_CATALOG, () => true)
      : catalogLaunch(entry, deps.config.mcpCatalog);
  const catalogEnv = Object.fromEntries(
    Object.entries(entry?.stdio?.env ?? {}).map(([k, v]) => [k, substitute(v, values)]),
  );
  // A catalog server gets its declared secrets only, whatever an older row holds.
  const declared = entry?.stdio ? declaredEnv(entry) : null;
  const ownEnv = declared
    ? Object.fromEntries(Object.entries(secrets.values).filter(([name]) => declared.has(name)))
    : { ...config.env, ...secrets.values };
  return {
    command: launch.command,
    args: launch.args.map((a) => substitute(a, values)),
    env: { ...catalogEnv, ...ownEnv },
    ...(config.cwd ? { cwd: config.cwd } : {}),
    dirs,
  };
}

/** The current OAuth access token, refreshed (once, across concurrent callers) when it is about to expire. */
export async function oauthAccessToken(deps: ConnectorsDeps, id: string): Promise<string> {
  const inFlight = refreshing.get(id);
  if (inFlight) return inFlight;
  const row = await rowById(deps.db, id);
  const secrets = openSecrets(deps, row);
  const tokens = secrets.oauth?.tokens;
  if (!tokens) throw new NeedsAuthError('Sign in to this connector first.');
  if (!needsRefresh(tokens)) return tokens.access_token;
  const promise = secrets.oauth?.githubApp
    ? refreshGitHubAppToken(deps, id)
    : (async () => {
        const oauth = secrets.oauth!;
        if (!oauth.client || !oauth.authorizationServerUrl || !tokens.refresh_token) {
          throw new NeedsAuthError('The sign-in expired; sign in again.');
        }
        let fresh;
        try {
          fresh = await refreshOAuth({
            authorizationServerUrl: oauth.authorizationServerUrl,
            client: oauth.client,
            tokens,
            ...(oauth.resource ? { resource: oauth.resource } : {}),
            fetch: connectorFetch(deps, row),
          });
        } catch (err) {
          throw new NeedsAuthError(
            `The sign-in expired and could not be renewed: ${scrub((err as Error).message, secrets)}`,
          );
        }
        const latest = openSecrets(deps, await rowById(deps.db, id));
        latest.oauth = { ...latest.oauth, tokens: fresh };
        await deps.db
          .update(schema.connectors)
          .set({ secrets: sealSecrets(deps, latest) })
          .where(eq(schema.connectors.id, id));
        return fresh.access_token;
      })();
  refreshing.set(id, promise);
  try {
    return await promise;
  } finally {
    refreshing.delete(id);
  }
}

/** Row locking serializes single-use GitHub refresh tokens across API/worker
 * processes, not just callers sharing the in-process refreshing map. */
async function refreshGitHubAppToken(deps: ConnectorsDeps, id: string): Promise<string> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, id))
      .for('update');
    if (!row || !isGitHubConnector(row))
      throw new NeedsAuthError('The GitHub connector changed. Connect again.');
    const secrets = openSecrets(deps, row);
    const oauth = secrets.oauth;
    const tokens = oauth?.tokens;
    if (!tokens || !oauth.githubApp) throw new NeedsAuthError('Connect the GitHub App again.');
    if (!needsRefresh(tokens)) return tokens.access_token;
    try {
      oauth.tokens = await refreshGitHubDevice(
        oauth.githubApp.clientId,
        tokens,
        connectorFetch(deps, { local: false }),
      );
    } catch {
      throw new NeedsAuthError(
        'The GitHub App authorization expired or was revoked. Connect again.',
      );
    }
    await tx
      .update(schema.connectors)
      .set({ secrets: sealSecrets(deps, secrets) })
      .where(eq(schema.connectors.id, id));
    return oauth.tokens.access_token;
  });
}

async function storeTools(db: Db, connectorId: string, tools: McpTool[]): Promise<void> {
  const [row] = await db
    .select({ workspaceId: schema.connectors.workspaceId })
    .from(schema.connectors)
    .where(eq(schema.connectors.id, connectorId));
  if (!row) return;
  const now = new Date();
  await db.transaction(async (tx) => {
    const names = tools.map((t) => t.name);
    await tx
      .delete(schema.connectorTools)
      .where(
        names.length
          ? and(
              eq(schema.connectorTools.connectorId, connectorId),
              notInArray(schema.connectorTools.name, names),
            )
          : eq(schema.connectorTools.connectorId, connectorId),
      );
    for (const tool of tools) {
      const values = {
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? {},
        lastSeenAt: now,
      };
      await tx
        .insert(schema.connectorTools)
        .values({ workspaceId: row.workspaceId, connectorId, name: tool.name, ...values })
        .onConflictDoUpdate({
          target: [schema.connectorTools.connectorId, schema.connectorTools.name],
          set: values,
        });
    }
  });
}

async function recordSnapshot(
  deps: ConnectorsDeps,
  id: string,
  snapshot: McpSnapshot,
): Promise<void> {
  await storeTools(deps.db, id, snapshot.tools);
  const row = await rowById(deps.db, id).catch(() => null);
  if (!row) return;
  const discovered = {
    server: snapshot.server,
    resources: snapshot.resources,
    prompts: snapshot.prompts,
  };
  await deps.db
    .update(schema.connectors)
    .set({
      config: writeConfig(readConfig(row), discovered),
      status: 'ok' satisfies ConnectorStatus,
      lastError: null,
      lastCheckedAt: new Date(),
    })
    .where(eq(schema.connectors.id, id));
}

export function errorStatus(error: Error): ConnectorStatus {
  if (error instanceof NeedsAuthError) return 'needs_auth';
  // The SDK's StreamableHTTPError keeps the HTTP status in `code`, not in the message.
  if ((error as { code?: unknown }).code === 401) return 'needs_auth';
  if (/\b401\b|unauthori[sz]ed|invalid_token/i.test(error.message)) return 'needs_auth';
  return 'error';
}

export async function recordError(deps: ConnectorsDeps, id: string, error: Error): Promise<void> {
  const row = await rowById(deps.db, id).catch(() => null);
  if (!row) return;
  const message = describeError(deps, row, error);
  deps.logger.warn({ connectorId: id, error: message }, 'connector session failed');
  await deps.db
    .update(schema.connectors)
    .set({ status: errorStatus(error), lastError: message, lastCheckedAt: new Date() })
    .where(eq(schema.connectors.id, id));
}

function describeError(deps: Pick<AppDeps, 'config'>, row: ConnectorRow, error: Error): string {
  let secrets: SealedSecrets;
  try {
    secrets = openSecrets(deps, row);
  } catch {
    secrets = emptySecrets();
  }
  const code = (error as { code?: unknown }).code;
  const base =
    code === 'ENOENT' ? `Command not found: ${error.message}` : error.message || String(error);
  return scrub(base, secrets);
}

/** Connects, lists tools and stores the outcome in `status`, `last_error` and `connector_tools`. */
export async function testConnector(
  deps: ConnectorsDeps,
  viewer: Viewer,
  id: string,
): Promise<{ record: ConnectorRecord; tools: ConnectorToolRow[] }> {
  const row = await connectorRow(deps.db, viewer, id);
  if (row.kind === 'builtin') {
    throw invalid(
      'NOT_AN_MCP_SERVER',
      'Built-in connectors are provided by OpenBots and have no MCP session.',
    );
  }
  const rules = await blockRules(deps.db, viewer.workspaceId);
  if (isBlocked(row, rules)) throw connectorBlocked();
  if (isCustomStdio(row)) {
    const refusal = await customStdioRefusal(deps, viewer.workspaceId, viewer.id);
    if (refusal) throw refusal;
  }
  try {
    await mcpManager(deps).test(id);
  } catch (err) {
    // Start failures were stored by `onError`; failures while resolving (no login, unreadable
    // secrets) never reached it. Storing twice is harmless.
    if (err instanceof DomainError) throw err;
    await recordError(deps, id, err as Error);
  }
  return {
    record: await getConnector(deps, viewer, id),
    tools: await listConnectorTools(deps.db, viewer, id),
  };
}

export async function listConnectorTools(
  db: Db,
  viewer: Viewer,
  id: string,
): Promise<ConnectorToolRow[]> {
  await connectorRow(db, viewer, id);
  return db
    .select()
    .from(schema.connectorTools)
    .where(eq(schema.connectorTools.connectorId, id))
    .orderBy(asc(schema.connectorTools.name));
}

// --- OAuth ----------------------------------------------------------------------

/** A catalog entry's extra authorization URL parameters, such as Google's `access_type=offline`. */
function authorizationParams(catalogId: string | null) {
  const params = catalogId ? catalogEntry(catalogId)?.oauth?.authorization_params : undefined;
  return params ? { authorizationParams: params } : {};
}

export { githubInstallationUrl };

function githubAppSlug(
  deps: Pick<ConnectorsDeps, 'config'>,
  secrets: SealedSecrets,
): string | undefined {
  const client = secrets.oauth?.client;
  return client
    ? typeof client.github_app_slug === 'string'
      ? client.github_app_slug
      : undefined
    : deps.config.githubConnectorAppSlug;
}

/** Never send GitHub tokens to a connector whose URL was changed. */
function isGitHubConnector(row: ConnectorRow): boolean {
  const transport = readConfig(row).transport;
  return (
    row.catalogId === 'github' &&
    transport.transport === 'http' &&
    transport.auth === 'oauth' &&
    transport.url === 'https://api.githubcopilot.com/mcp/'
  );
}

export async function startConnectorOAuth(
  deps: ConnectorsDeps,
  viewer: Viewer,
  id: string,
  mode: OAuthMode = 'redirect',
): Promise<{
  authorizationUrl: string;
  device?: {
    userCode: string;
    verificationUrl: string;
    installationUrl: string;
    expiresAt: string;
    interval: number;
  };
}> {
  const row = await connectorRow(deps.db, viewer, id);
  const config = readConfig(row).transport;
  if (config.transport !== 'http' || config.auth !== 'oauth') {
    throw invalid('NOT_OAUTH', 'This connector does not sign in with OAuth.');
  }
  const rules = await blockRules(deps.db, viewer.workspaceId);
  if (isBlocked(row, rules)) throw connectorBlocked();
  const secrets = openSecrets(deps, row);
  const client = secrets.oauth?.client;
  const deviceClientId = isGitHubConnector(row)
    ? client?.client_id || deps.config.githubConnectorClientId
    : undefined;
  const appSlug = githubAppSlug(deps, secrets);
  if (isGitHubConnector(row) && (!deviceClientId || !appSlug || client?.client_secret)) {
    throw invalid(
      'OAUTH_CLIENT_REQUIRED',
      'Configure a GitHub App client ID and app slug with Device Flow enabled. No client secret is used.',
    );
  }
  if (deviceClientId) {
    let startedDevice;
    try {
      startedDevice = await beginGitHubDevice(
        deviceClientId,
        appSlug!,
        connectorFetch(deps, { local: false }),
      );
    } catch {
      throw new DomainError(
        502,
        'OAUTH_FAILED',
        'Could not start GitHub device authorization. Check that Device Flow is enabled on the GitHub App.',
      );
    }
    secrets.oauth = { ...secrets.oauth, device: startedDevice.device };
    delete secrets.oauth.pending;
    const saved = await deps.db
      .update(schema.connectors)
      .set({ secrets: sealSecrets(deps, secrets) })
      .where(
        and(
          eq(schema.connectors.id, id),
          row.secrets
            ? eq(schema.connectors.secrets, Buffer.from(row.secrets))
            : isNull(schema.connectors.secrets),
        ),
      )
      .returning({ id: schema.connectors.id });
    if (!saved.length)
      throw invalid('OAUTH_DEVICE_CHANGED', 'The connector changed. Connect again.');
    return { authorizationUrl: startedDevice.public.verificationUrl, device: startedDevice.public };
  }
  let started;
  try {
    started = await startOAuth({
      serverUrl: config.url,
      redirectUrl: oauthRedirectUrl(deps),
      stateId: id,
      clientName: 'OpenBots',
      ...(config.scopes ? { scopes: config.scopes } : {}),
      ...(secrets.oauth?.client ? { client: secrets.oauth.client } : {}),
      ...authorizationParams(row.catalogId),
      fetch: connectorFetch(deps, row),
    });
  } catch (err) {
    if (err instanceof OAuthSetupError) throw invalid(`OAUTH_${err.code}`, err.message);
    throw new DomainError(502, 'OAUTH_FAILED', scrub((err as Error).message, secrets));
  }
  secrets.oauth = {
    ...secrets.oauth,
    client: started.client,
    device: undefined,
    pending: { ...started.pending, ownerId: viewer.id, mode },
  };
  await deps.db
    .update(schema.connectors)
    .set({ secrets: sealSecrets(deps, secrets) })
    .where(eq(schema.connectors.id, id));
  return { authorizationUrl: started.authorizationUrl };
}

/**
 * Authenticated polling keeps the device code on the server. A compare-and-swap
 * reserves each poll across API processes and prevents stale requests from
 * overwriting a restarted flow, edited settings or a deleted connector.
 */
export async function pollConnectorDevice(
  deps: ConnectorsDeps,
  viewer: Viewer,
  id: string,
): Promise<DevicePoll> {
  const row = await connectorRow(deps.db, viewer, id);
  if (!isGitHubConnector(row))
    throw invalid('NOT_DEVICE_OAUTH', 'This connector does not use GitHub device authorization.');
  if (isBlocked(row, await blockRules(deps.db, viewer.workspaceId))) throw connectorBlocked();
  const secrets = openSecrets(deps, row);
  const device = secrets.oauth?.device;
  if (!device) throw invalid('OAUTH_DEVICE_MISSING', 'Start GitHub authorization again.');
  const pending = (): DevicePoll => ({ status: 'pending', interval: device.interval });
  const save = async (previous: Buffer, values: Record<string, unknown> = {}) => {
    const next = sealSecrets(deps, secrets)!;
    const updated = await deps.db
      .update(schema.connectors)
      .set({ ...values, secrets: next })
      .where(and(eq(schema.connectors.id, id), eq(schema.connectors.secrets, previous)))
      .returning({ id: schema.connectors.id });
    return updated.length ? next : null;
  };
  if (Date.now() >= device.expiresAt) {
    delete secrets.oauth!.device;
    await save(Buffer.from(row.secrets!));
    return { status: 'error', message: 'The GitHub code expired. Connect again for a new code.' };
  }
  if (Date.now() < device.nextPollAt) return pending();
  // Reserve enough time for this request as well as GitHub's polling interval.
  device.nextPollAt = Date.now() + Math.max(device.interval * 1000, 20_000);
  const reserved = await save(Buffer.from(row.secrets!));
  if (!reserved) return pending();
  let result;
  try {
    result = await pollGitHubDevice(device, connectorFetch(deps, { local: false }));
  } catch (error) {
    if (error instanceof GitHubAppAuthorizationError) {
      delete secrets.oauth!.device;
      await save(reserved);
      return { status: 'error', message: error.message };
    }
    // Leave the reservation in place after a network error. Do not echo provider
    // responses or exceptions, which could contain the device code or token.
    return pending();
  }
  if ('error' in result) {
    if (result.error === 'authorization_pending' || result.error === 'slow_down') {
      if (result.error === 'slow_down')
        device.interval = Math.max(device.interval + 5, result.interval ?? 0);
      device.nextPollAt = Date.now() + device.interval * 1000;
      await save(reserved);
      return pending();
    }
    delete secrets.oauth!.device;
    await save(reserved);
    return {
      status: 'error',
      message:
        result.error === 'access_denied'
          ? 'GitHub authorization was cancelled. Connect again to retry.'
          : 'GitHub authorization ended. Connect again for a new code.',
    };
  }
  let installed;
  try {
    installed = await hasGitHubInstallation(
      result.tokens.access_token,
      device.appSlug,
      connectorFetch(deps, { local: false }),
    );
  } catch {
    installed = false;
  }
  if (!installed) {
    delete secrets.oauth!.device;
    await save(reserved);
    return {
      status: 'error',
      message:
        'Install the GitHub App on the repositories you want to use, then Connect again. Use Manage repositories to install it or request organization approval.',
    };
  }
  secrets.oauth = {
    ...secrets.oauth,
    tokens: result.tokens,
    githubApp: { clientId: device.clientId, appSlug: device.appSlug },
    authorizationServerUrl: 'https://github.com',
  };
  delete secrets.oauth.device;
  const saved = await save(reserved, { status: 'untested', lastError: null });
  if (!saved)
    throw invalid(
      'OAUTH_DEVICE_CHANGED',
      'The connector changed during authorization. Connect again.',
    );
  await stopSessions(deps, [id]);
  await publishConnectorUpdated(deps, row, { oauth: 'connected' });
  return { status: 'connected' };
}

/** How a sign-in ended, for the callback page; never carries a token. */
export interface OAuthOutcome {
  ok: boolean;
  /** The HTTP status the callback answers with. */
  status: 200 | 400 | 401 | 403 | 502;
  code: string | null;
  message: string | null;
  /** Known once the state checked out. */
  connectorId: string | null;
  name: string | null;
  mode: OAuthMode | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_STATE = 'This sign-in link is not valid. Start again.';

export const SIGN_IN_FIRST = 'Sign in to OpenBots in this browser, then try again.';

/**
 * Finishes a sign-in at the callback. The flow is found by its state: the
 * connector id, then the stored nonce compared in constant time, single use
 * and at most 10 minutes old (`verifyState`). It completes only for the user
 * who started it: a session for anyone else is always refused, and so is no
 * session, with one exception. A popup or same-tab flow runs in the browser
 * that started it, which has the session. An `external` flow runs in the Mac
 * app's default browser, which may have none; on a self-hosted install only
 * its one owner can start a flow, so the state alone suffices there. On the
 * managed service the session is required for now; binding the browser to
 * the app with a one-time handoff comes with the managed service. The
 * owner's pages hear the outcome as `connector.updated`.
 */
export async function completeConnectorOAuth(
  deps: ConnectorsDeps,
  viewer: Viewer | null,
  query: { state?: string; code?: string; error?: string; error_description?: string },
): Promise<OAuthOutcome> {
  // The provider's redirect has no organization: the state's connector says
  // which (a SECURITY DEFINER lookup), and the rest works there (db/scope.ts).
  const named = query.state ? parseState(query.state) : null;
  const workspaceId =
    named && UUID.test(named.id) ? await connectorWorkspace(deps.db, named.id) : null;
  return workspaceId
    ? inWorkspace(workspaceId, () => completeInScope(deps, viewer, query))
    : completeInScope(deps, viewer, query);
}

async function completeInScope(
  deps: ConnectorsDeps,
  viewer: Viewer | null,
  query: { state?: string; code?: string; error?: string; error_description?: string },
): Promise<OAuthOutcome> {
  const refused = (code: string, message: string, status: 400 | 401 | 403 = 400): OAuthOutcome => ({
    ok: false,
    status,
    code,
    message,
    connectorId: null,
    name: null,
    mode: null,
  });
  const parsed = query.state ? parseState(query.state) : null;
  if (!parsed || !UUID.test(parsed.id)) return refused('OAUTH_STATE_INVALID', INVALID_STATE);
  const row = await rowById(deps.db, parsed.id).catch(() => null);
  if (!row) return refused('OAUTH_STATE_INVALID', INVALID_STATE);
  if (viewer && (viewer.id !== row.ownerId || viewer.workspaceId !== row.workspaceId)) {
    return refused(
      'OAUTH_WRONG_USER',
      'This sign-in was started by another account. Sign in as that account, or start again.',
      403,
    );
  }
  const secrets = openSecrets(deps, row);
  const pending = secrets.oauth?.pending;
  try {
    verifyState(query.state!, pending);
    if (pending!.ownerId && pending!.ownerId !== row.ownerId) {
      throw new OAuthSetupError('STATE_INVALID', INVALID_STATE);
    }
  } catch (err) {
    const code = (err as OAuthSetupError).code;
    // An expired flow had the right nonce, so it may say which connector it was for.
    if (code === 'STATE_EXPIRED') {
      return {
        ...refused(`OAUTH_${code}`, 'This sign-in took too long. Start again.'),
        connectorId: row.id,
        name: row.name,
        mode: pending?.mode ?? 'redirect',
      };
    }
    return refused(`OAUTH_${code ?? 'STATE_INVALID'}`, INVALID_STATE);
  }
  const flow = pending!;
  const mode = flow.mode ?? 'redirect';
  const sessionless = mode === 'external' && deps.config.deployment === 'self_hosted';
  if (!viewer && !sessionless) {
    // The flow stays pending: signing in and loading the page again finishes it.
    return {
      ...refused('OAUTH_SIGN_IN_REQUIRED', SIGN_IN_FIRST, 401),
      connectorId: row.id,
      name: row.name,
      mode: mode === 'redirect' ? null : mode,
    };
  }
  // The flow is single use whatever happens next.
  delete secrets.oauth!.pending;
  const save = () =>
    deps.db
      .update(schema.connectors)
      .set({ secrets: sealSecrets(deps, secrets) })
      .where(eq(schema.connectors.id, row.id));
  const failed = async (status: 400 | 502, code: string, message: string) => {
    await save();
    await publishConnectorUpdated(deps, row, { oauth: 'error', error: message });
    return { ok: false, status, code, message, connectorId: row.id, name: row.name, mode };
  };
  if (query.error || !query.code) {
    return failed(
      400,
      'OAUTH_DENIED',
      (query.error_description ?? query.error ?? 'The sign-in was cancelled.').slice(0, 500),
    );
  }
  try {
    const tokens = await finishOAuth({
      code: query.code,
      pending: flow,
      client: secrets.oauth!.client!,
      fetch: connectorFetch(deps, row),
    });
    secrets.oauth = {
      ...secrets.oauth,
      tokens,
      authorizationServerUrl: flow.authorizationServerUrl,
      ...(flow.resource ? { resource: flow.resource } : {}),
    };
  } catch (err) {
    return failed(502, 'OAUTH_FAILED', scrub((err as Error).message, secrets));
  }
  await deps.db
    .update(schema.connectors)
    .set({
      secrets: sealSecrets(deps, secrets),
      status: 'untested' satisfies ConnectorStatus,
      lastError: null,
    })
    .where(eq(schema.connectors.id, row.id));
  await stopSessions(deps, [row.id]);
  await publishConnectorUpdated(deps, row, { oauth: 'connected' });
  return {
    ok: true,
    status: 200,
    code: null,
    message: null,
    connectorId: row.id,
    name: row.name,
    mode,
  };
}

/** Tells every page of the owner that a connector changed (plan 14.2). */
async function publishConnectorUpdated(
  deps: ConnectorsDeps,
  row: Pick<ConnectorRow, 'id' | 'ownerId' | 'workspaceId'>,
  payload: { oauth?: 'connected' | 'error'; error?: string | null },
): Promise<void> {
  if (!deps.infra) return;
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'connector.updated',
      { connectorId: row.id, ...payload },
      { user_id: row.ownerId, workspace_id: row.workspaceId },
    ),
  ).catch((err: unknown) => deps.logger.warn({ err }, 'could not publish connector.updated'));
}

/** What a pasted URL needs, for the custom server form. */
export interface UrlDiscovery {
  auth: 'none' | 'oauth' | 'bearer';
  dynamicRegistration: boolean;
  /** False when the probe could not reach the server; it is added as is and Test says why. */
  reachable: boolean;
  message: string | null;
}

/**
 * Probes a Streamable HTTP URL before it is added (no connector exists yet):
 * whether it needs OAuth, whether its authorization server registers clients
 * itself, or whether it wants a token. Blocked URLs are refused as on add,
 * and the probe goes through the outbound guard (S-8).
 */
export async function discoverConnectorUrl(
  deps: ConnectorsDeps,
  viewer: Viewer,
  url: string,
): Promise<UrlDiscovery> {
  const config: TransportConfig = { transport: 'http', url, auth: 'none', headers: {} };
  const rules = await blockRules(deps.db, viewer.workspaceId);
  if (blockedBy({ catalogId: matchCatalog(config), config }, rules)) throw connectorBlocked();
  try {
    const found = await discoverServer(url, { fetch: connectorFetch(deps, { local: false }) });
    return {
      auth: found.auth,
      dynamicRegistration: found.dynamicRegistration,
      reachable: true,
      message: null,
    };
  } catch (err) {
    return {
      auth: 'none',
      dynamicRegistration: false,
      reachable: false,
      message: (err as Error).message.slice(0, 500),
    };
  }
}

// --- Per-Bot permissions (T1) ---------------------------------------------------

export interface BotConnectorPermission {
  connectorId: string;
  toolAllowlist: string[] | null;
  toolDenylist: string[];
  approvalOverride: ApprovalOverride | null;
}

export async function getBotConnectors(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: Viewer,
  botId: string,
) {
  await assertBotOwner(deps.db, viewer, botId);
  const [records, rows] = await Promise.all([
    listConnectors(deps, viewer),
    deps.db.select().from(schema.botConnectors).where(eq(schema.botConnectors.botId, botId)),
  ]);
  const byConnector = new Map(rows.map((r) => [r.connectorId, r]));
  return records.map((record) => {
    const row = byConnector.get(record.row.id);
    return {
      record,
      permission: {
        connectorId: record.row.id,
        toolAllowlist: row?.toolAllowlist ?? null,
        toolDenylist: row?.toolDenylist ?? [],
        approvalOverride: (row?.approvalOverride as ApprovalOverride | null | undefined) ?? null,
      } satisfies BotConnectorPermission,
      customized: Boolean(row),
    };
  });
}

/** Replaces the Bot's rows; connectors left out go back to "every tool, policy defaults". */
export async function putBotConnectors(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: Viewer,
  botId: string,
  items: BotConnectorPermission[],
) {
  await assertBotOwner(deps.db, viewer, botId);
  await deps.db.transaction((tx) => writeBotConnectors(tx, viewer, botId, items));
  return getBotConnectors(deps, viewer, botId);
}

/**
 * `putBotConnectors` for a Bot already checked as the viewer's, inside the
 * caller's transaction (also a new Bot's, B2): 400 for a connector named
 * twice, 404 for one that is not the viewer's.
 */
export async function writeBotConnectors(
  tx: Db,
  viewer: Viewer,
  botId: string,
  items: BotConnectorPermission[],
) {
  const ids = [...new Set(items.map((i) => i.connectorId))];
  if (ids.length !== items.length)
    throw invalid('DUPLICATE_CONNECTOR', 'Each connector may appear once.');
  if (ids.length) {
    const owned = await tx
      .select({ id: schema.connectors.id })
      .from(schema.connectors)
      .where(
        and(
          inArray(schema.connectors.id, ids),
          eq(schema.connectors.ownerId, viewer.id),
          eq(schema.connectors.workspaceId, viewer.workspaceId),
        ),
      );
    if (owned.length !== ids.length) throw notFound('Connector not found');
  }
  await tx.delete(schema.botConnectors).where(eq(schema.botConnectors.botId, botId));
  if (items.length) {
    await tx.insert(schema.botConnectors).values(
      items.map((i) => ({
        workspaceId: viewer.workspaceId,
        botId,
        connectorId: i.connectorId,
        toolAllowlist: i.toolAllowlist,
        toolDenylist: i.toolDenylist,
        approvalOverride: i.approvalOverride,
      })),
    );
  }
}

export interface BotTool {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  tool: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  approvalOverride: ApprovalOverride | null;
}

/**
 * Every MCP tool the Bot may use: its owner's connectors that are not blocked,
 * from the cached tool list, filtered by the Bot's allow and deny lists. Leaf
 * 2.3 names them `${connectorSlug}__${tool}`.
 */
export async function listToolsForBot(
  deps: Pick<AppDeps, 'db' | 'config'>,
  botId: string,
): Promise<BotTool[]> {
  const usable = await usableMcpConnectors(deps, botId);
  if (!usable.length) return [];
  const [tools, permissions] = await Promise.all([
    deps.db
      .select()
      .from(schema.connectorTools)
      .where(
        inArray(
          schema.connectorTools.connectorId,
          usable.map((c) => c.id),
        ),
      )
      .orderBy(asc(schema.connectorTools.name)),
    deps.db.select().from(schema.botConnectors).where(eq(schema.botConnectors.botId, botId)),
  ]);
  const ruleFor = new Map(permissions.map((p) => [p.connectorId, p]));
  const out: BotTool[] = [];
  for (const connector of usable) {
    const rule = ruleFor.get(connector.id);
    for (const t of tools) {
      if (t.connectorId !== connector.id || !toolPermitted(t.name, rule)) continue;
      out.push({
        connectorId: connector.id,
        connectorSlug: connector.slug,
        connectorName: connector.name,
        tool: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations as Record<string, unknown>,
        approvalOverride: (rule?.approvalOverride as ApprovalOverride | null | undefined) ?? null,
      });
    }
  }
  return out;
}

/** How long a run waits for new connectors to list their tools before going on without them. */
export const DISCOVERY_WAIT_MS = 15_000;

/**
 * Starts the Bot's usable MCP connectors that have not listed their tools
 * since they were added or their settings changed (status `untested`), so a
 * connector saved without pressing Test, through the API (U4) say, still
 * offers its tools (plan 8: sessions start lazily). The session caches the
 * tools and sets the status; a failure is recorded on the connector. A slow
 * server keeps starting after `waitMs` and its tools reach the next run.
 */
export async function discoverUntested(
  deps: ConnectorsDeps,
  botId: string,
  waitMs = DISCOVERY_WAIT_MS,
): Promise<void> {
  const untested = (await usableMcpConnectors(deps, botId)).filter(
    (c) => c.status === ('untested' satisfies ConnectorStatus),
  );
  if (!untested.length) return;
  const manager = mcpManager(deps);
  const started = Promise.allSettled(
    untested.map((c) =>
      manager.host(c.id).catch(async (err: unknown) => {
        // Start failures reach `onError`; a missing login or unreadable secrets do not.
        await recordError(deps, c.id, err as Error);
      }),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
    timer.unref?.();
  });
  await Promise.race([started, waited]);
  clearTimeout(timer);
}

/** The owner's MCP connectors a Bot may use: not blocked, and no custom stdio the owner may not run. */
async function usableMcpConnectors(
  deps: Pick<AppDeps, 'db' | 'config'>,
  botId: string,
): Promise<ConnectorRow[]> {
  const { db } = deps;
  const [bot] = await db
    .select({ ownerId: schema.bots.ownerId, workspaceId: schema.bots.workspaceId })
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  if (!bot) return [];
  const connectors = await db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, bot.ownerId),
        eq(schema.connectors.workspaceId, bot.workspaceId),
        inArray(schema.connectors.kind, ['mcp_stdio', 'mcp_http']),
      ),
    )
    .orderBy(asc(schema.connectors.createdAt));
  const [rules, refusal] = await Promise.all([
    blockRules(db, bot.workspaceId),
    customStdioRefusal(deps, bot.workspaceId, bot.ownerId),
  ]);
  return connectors.filter((c) => !isBlocked(c, rules) && !(refusal && isCustomStdio(c)));
}

/** Calls a permitted tool for a Bot through the manager; re-checks the block list and the Bot's lists. */
export async function callToolForBot(
  deps: ConnectorsDeps,
  botId: string,
  connectorSlug: string,
  tool: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ToolCallResult> {
  const permitted = await listToolsForBot(deps, botId);
  const match = permitted.find((t) => t.connectorSlug === connectorSlug && t.tool === tool);
  if (!match)
    throw new DomainError(
      403,
      'TOOL_NOT_PERMITTED',
      `${connectorSlug}__${tool} is not available to this Bot.`,
    );
  return mcpManager(deps).callTool(match.connectorId, tool, args, options);
}

async function audit(
  tx: Db,
  viewer: Viewer,
  action:
    | 'connector.create'
    | 'connector.update'
    | 'connector.delete'
    | 'connector.trust'
    | 'connector.local',
  connectorId: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(schema.auditLog).values({
    workspaceId: viewer.workspaceId,
    actorType: 'user',
    actorId: viewer.id,
    action,
    targetType: 'connector',
    targetId: connectorId,
    metadata,
  });
}
