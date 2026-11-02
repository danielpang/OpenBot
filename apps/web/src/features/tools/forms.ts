import type { CatalogEntry, Connector, CreateConnector, UpdateConnector } from './api.js';

// The Connectors page's form logic, kept apart from the components so it can be
// tested without a DOM: the custom server form, pasted `mcpServers` JSON,
// write-only secret edits and the admin block list.

export const STATUS_LABELS: Record<Connector['status'], string> = {
  untested: 'Not tested',
  ok: 'Working',
  error: 'Failing',
  needs_auth: 'Needs login',
};

/** The status column: admin blocks first, then the OAuth connection, then the test status. */
export function statusText(connector: Connector): string {
  if (connector.disabledByAdmin) return 'Disabled by admin';
  const oauth = connector.oauth;
  if (oauth) {
    if (!oauth.connected) return 'Not connected';
    if (connector.status === 'needs_auth') return 'Sign-in expired';
    if (connector.status === 'error') return 'Failing';
    return 'Connected';
  }
  // Built-ins have no session to test; they are ready once their secrets are.
  if (connector.kind === 'builtin') {
    const secrets = connector.secrets;
    return secrets.length && !secrets.some((s) => s.set) ? 'No key set' : 'Ready';
  }
  return STATUS_LABELS[connector.status];
}

/**
 * The card's one sign-in button: Connect until the first login, Reconnect
 * once its tokens expired or were revoked, none while it works.
 */
export function signInAction(connector: Connector): 'Connect' | 'Reconnect' | null {
  const oauth = connector.oauth;
  if (!oauth || connector.disabledByAdmin) return null;
  if (!oauth.connected) return 'Connect';
  return connector.status === 'needs_auth' ? 'Reconnect' : null;
}

/** Whether a catalog entry needs the owner's own OAuth client (GitHub, Slack, Google). */
export const needsOAuthClient = (entry: Pick<CatalogEntry, 'oauth'>) =>
  !!entry.oauth && !entry.oauth.dynamicRegistration;

/**
 * What Connect on a catalog card does: `oauth` signs in at once (the
 * provider registers OpenBots itself), `client` first asks for the owner's
 * OAuth client under Advanced, `plain` just adds it. Required settings and
 * keys are asked for first either way.
 */
export function connectKind(entry: CatalogEntry): 'oauth' | 'client' | 'plain' {
  if (!entry.oauth) return 'plain';
  return entry.oauth.dynamicRegistration ? 'oauth' : 'client';
}

/** Whether a catalog entry has something to fill in before it can be added. */
export const needsForm = (entry: CatalogEntry) =>
  entry.params.some((p) => p.required) ||
  entry.secrets.some((s) => s.required) ||
  (connectKind(entry) === 'plain' && (entry.params.length > 0 || entry.secrets.length > 0));

/** Built-ins every Bot has without adding anything; the catalog shows them as on. */
export const ALWAYS_ON = new Set(['web_fetch', 'http_request']);

/** Splits a command line into arguments: whitespace separates, quotes group. */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('A quote in the command is not closed');
  if (started) args.push(current);
  return args;
}

/** `KEY=value` lines; blank lines are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Not a KEY=value line: ${line}`);
    env[key] = line.slice(eq + 1);
  }
  return env;
}

export interface CustomServerInput {
  name: string;
  transport: 'stdio' | 'http';
  /** The command and its arguments, as typed. */
  command: string;
  /** `KEY=value` lines, stored as secrets. */
  env: string;
  url: string;
  auth: 'none' | 'bearer' | 'oauth';
  token: string;
}

/** The `POST /connectors` body for the custom form. Environment values and the token are secrets. */
export function customConnectorBody(input: CustomServerInput): CreateConnector {
  const name = input.name.trim();
  if (input.transport === 'stdio') {
    const [command, ...args] = splitArgs(input.command);
    if (!command) throw new Error('Enter the command that starts the server');
    const secrets = parseEnv(input.env);
    return {
      ...(name ? { name } : {}),
      transport: 'stdio',
      command,
      args,
      ...(Object.keys(secrets).length ? { secrets } : {}),
    };
  }
  const url = input.url.trim();
  if (!url) throw new Error('Enter the server URL');
  const token = input.token.trim();
  if (input.auth === 'bearer' && !token) throw new Error('Enter the access token');
  return {
    ...(name ? { name } : {}),
    transport: 'http',
    url,
    auth: input.auth,
    ...(input.auth === 'bearer' ? { secrets: { BEARER_TOKEN: token } } : {}),
  };
}

/** Whether the custom form may add a command (stdio) server (S-1). */
export type StdioAvailability = 'on' | 'admin_only' | 'off' | 'unavailable';

/**
 * Admins only, and only once an admin turns custom stdio on in the
 * settings; never where the install keeps them off (the managed service).
 */
export function stdioAvailability(
  role: string | null | undefined,
  enabled: boolean | undefined,
  available = true,
): StdioAvailability {
  if (!available) return 'unavailable';
  if (role !== 'owner' && role !== 'admin') return 'admin_only';
  return enabled ? 'on' : 'off';
}

export const STDIO_NOTES: Record<Exclude<StdioAvailability, 'on'>, string> = {
  admin_only: 'Only an admin can add a command (stdio) server. Use the catalog or an HTTP URL.',
  off: 'Command (stdio) servers are off. Turn them on under "Admin: connector policy" below.',
  unavailable: 'Command (stdio) servers are not available here. Use the catalog or an HTTP URL.',
};

/** The "off" note on a self-hosted install, whose owner sets the connector policy. */
export const STDIO_OFF_SELF_HOSTED =
  'Command (stdio) servers are off. Turn them on under "Connector policy" below.';

/** Under the import box while custom commands are refused: what a paste still imports. */
export const IMPORT_STDIO_NOTE = 'Command servers are imported only if they match a catalog entry.';

/** Pasted JSON as the `mcpServers` map; a bare map of servers is accepted too. */
export function parseImport(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('Paste a JSON object with "mcpServers"');
  const servers = 'mcpServers' in parsed ? parsed.mcpServers : parsed;
  if (!isRecord(servers) || !Object.keys(servers).length) {
    throw new Error('No servers found under "mcpServers"');
  }
  return servers;
}

/**
 * The secrets part of a `PATCH`: only fields the owner typed into. A blank
 * field keeps the stored value (the form never holds one, P3); `remove`
 * lists the secrets to delete.
 */
export function secretsPatch(
  typed: Record<string, string>,
  remove: readonly string[] = [],
): UpdateConnector['secrets'] | undefined {
  const patch: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(typed)) {
    if (value.trim()) patch[name] = value.trim();
  }
  for (const name of remove) patch[name] = null;
  return Object.keys(patch).length ? patch : undefined;
}

/** The catalog's declared params with the values typed in; required ones must be filled. */
export function paramValues(
  entry: Pick<CatalogEntry, 'params'>,
  typed: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of entry.params) {
    const value = typed[param.name]?.trim();
    if (value) values[param.name] = value;
    else if (param.required) throw new Error(`Enter ${param.label}`);
  }
  return values;
}

/** One entry per line, blank lines and repeats dropped. */
export function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `oauthClient` body from the two inputs; nothing when no client id was typed. */
export function oauthClientBody(client: {
  clientId: string;
  clientSecret: string;
}): { clientId: string; clientSecret?: string } | undefined {
  const clientId = client.clientId.trim();
  const clientSecret = client.clientSecret.trim();
  return clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : undefined;
}
