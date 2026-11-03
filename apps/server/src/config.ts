import {
  DEFAULT_SANDBOX_IMAGE,
  resolveSandboxNetwork,
  type SandboxNetwork,
} from '@openbots/computer';
import { DEFAULT_CATALOG_INSTALL_DIR, type CatalogInstall } from '@openbots/mcp';
import { isValidTimezone } from '@openbots/routines';
import {
  LIMIT_ENV_VARS,
  PROCESS_LIMIT_ENV_VARS,
  resolveLimits,
  resolveProcessLimits,
  type Limits,
  type ProcessLimits,
} from '@openbots/shared';
import { z } from 'zod';
import { isCidr } from './client-ip.js';
import { resolveSecretFiles } from './env-files.js';
import { parseMasterKey } from './secrets.js';

// Server configuration from the environment (plan 16.2). Empty values count as
// unset, so a copied `.env.example` with blank keys parses cleanly. Secrets may
// come from files instead (NAME_FILE, see env-files.ts).

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((value) => (value === '' || value === undefined ? fallback : value), schema);

const masterKey = z.string().refine(
  (value) => {
    try {
      parseMasterKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes, base64-encoded (generate one with `keygen`)' },
);

/** Master keys being rotated out (plan 4.9): comma-separated, each like OPENBOTS_MASTER_KEY. */
const masterKeyList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  )
  .refine((keys) => keys.every((key) => masterKey.safeParse(key).success), {
    message: 'must be comma-separated master keys, each 32 bytes, base64-encoded',
  });

/** A comma-separated list of addresses and CIDR ranges. */
const cidrList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean),
  )
  .refine((ranges) => ranges.every(isCidr), {
    message: 'must be comma-separated addresses or CIDR ranges, e.g. 172.16.0.0/12',
  });

/**
 * The computers' egress proxy: an http(s) URL with its port spelled out, the
 * form docker/sandbox-firewall.sh parses for its exception.
 */
const proxyUrl = z
  .url({ protocol: /^https?$/ })
  .regex(/^https?:\/\/([^/@]+@)?[^/@:]+:\d{1,5}\/?$/, {
    message: 'must look like http://172.30.255.3:8888, with the port',
  });

const limitsShape = Object.fromEntries(
  [...Object.values(LIMIT_ENV_VARS), ...Object.values(PROCESS_LIMIT_ENV_VARS)].map((name) => [
    name,
    optional(z.coerce.number().int().positive()),
  ]),
);

const envSchema = z.object({
  OPENBOTS_PUBLIC_URL: withDefault(z.url(), 'http://localhost:3000'),
  OPENBOTS_RELAY_URL: optional(z.url({ protocol: /^wss?$/ })),
  OPENBOTS_MASTER_KEY: masterKey,
  OPENBOTS_MASTER_KEY_PREVIOUS: withDefault(masterKeyList, ''),
  DATABASE_URL: z.string().min(1),
  OPENBOTS_DB_APP_PASSWORD: optional(
    z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'use 16 to 128 letters, digits, - or _'),
  ),
  REDIS_URL: optional(z.string()),
  DOCKER_HOST: optional(z.string()),
  OPENBOTS_SANDBOX_IMAGE: withDefault(z.string(), DEFAULT_SANDBOX_IMAGE),
  // Checked together by resolveSandboxNetwork below.
  OPENBOTS_SANDBOX_NETWORK: optional(z.string()),
  OPENBOTS_SANDBOX_BRIDGE: optional(z.string()),
  OPENBOTS_SANDBOX_EGRESS_PROXY: optional(proxyUrl),
  OPENBOTS_SANDBOX_NO_PROXY: optional(z.string()),
  OPENBOTS_TIMEZONE: withDefault(
    z.string().refine(isValidTimezone, {
      message: 'must be an IANA timezone name, e.g. Europe/London',
    }),
    'UTC',
  ),
  OPENBOTS_COMPUTER_AGENT_URL: optional(z.url()),
  OPENBOTS_COMPUTER_AGENT_TOKEN: optional(z.string()),
  OPENBOTS_COMPUTER_AGENT_SHARED: withDefault(z.stringbool(), 'false'),
  OPENBOTS_DEPLOYMENT: withDefault(z.enum(['self_hosted', 'managed']), 'self_hosted'),
  // Set by the standalone image (docker/standalone.Dockerfile), not by hand.
  OPENBOTS_STANDALONE: withDefault(z.stringbool(), 'false'),
  OPENBOTS_LOCAL_TOKEN: optional(
    z.string().min(32, { message: 'must be 32 characters or more (the Mac app generates one)' }),
  ),
  OPENBOTS_LOCAL_ENDPOINTS: optional(z.stringbool()),
  OPENBOTS_CUSTOM_STDIO: optional(z.stringbool()),
  OPENBOTS_STDIO_RUNNER: optional(z.enum(['host', 'computer'])),
  OPENBOTS_ALLOW_HOST_STDIO: withDefault(z.stringbool(), 'false'),
  OPENBOTS_SIGNUP_MODE: withDefault(
    z.enum(['first_user_admin', 'invite', 'open']),
    'first_user_admin',
  ),
  OPENBOTS_FILES_DIR: withDefault(z.string(), '/data/files'),
  OPENBOTS_MCP_DIR: withDefault(z.string(), DEFAULT_CATALOG_INSTALL_DIR),
  OPENBOTS_MCP_NPX_FALLBACK: withDefault(z.stringbool(), 'false'),
  OPENBOTS_ROLE: withDefault(z.enum(['api', 'worker', 'all']), 'all'),
  OPENBOTS_METRICS_TOKEN: optional(z.string().min(16)),
  TRUSTED_PROXIES: withDefault(cidrList, ''),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  XAI_API_KEY: optional(z.string()),
  GOOGLE_GENERATIVE_AI_API_KEY: optional(z.string()),
  OLLAMA_BASE_URL: optional(z.url()),
  GITHUB_CLIENT_ID: optional(z.string()),
  GITHUB_CLIENT_SECRET: optional(z.string()),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  ...limitsShape,
});

export type Deployment = 'self_hosted' | 'managed';
export type StdioRunner = 'host' | 'computer';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  publicUrl: string;
  /**
   * The private relay phones reach this server through (OPENBOTS_RELAY_URL,
   * a wss:// or ws:// URL; docs/RELAY_PROTOCOL.md). The server dials it only
   * once a device is paired or a pairing is open. Unset: no relay, and a
   * pairing link lists only direct addresses.
   */
  relayUrl?: string;
  /** Base64; seals every new secret. Open secrets with `keyringFromConfig`. */
  masterKey: string;
  /**
   * Base64 keys being rotated out (OPENBOTS_MASTER_KEY_PREVIOUS): they still
   * open secrets sealed under them until `rotate-key` re-seals those.
   */
  previousMasterKeys: string[];
  /** Secrets given in the plain environment rather than as NAME_FILE (S-1); main.ts warns. */
  secretsFromEnvironment: string[];
  databaseUrl: string;
  /**
   * OPENBOTS_DB_APP_PASSWORD: the app connects as openbots_app with it, a role
   * that owns nothing and does not bypass row-level security (db/app-role.ts).
   * Without it the app connects as DATABASE_URL's user and switches to that
   * role in every transaction.
   */
  dbAppPassword?: string;
  redisUrl?: string;
  dockerHost?: string;
  sandboxImage: string;
  /**
   * The network computers are created on and its bridge
   * (OPENBOTS_SANDBOX_NETWORK, OPENBOTS_SANDBOX_BRIDGE): compose's sandbox
   * network, which the docker guard and the sandbox firewall are set to as well.
   */
  sandboxNetwork: SandboxNetwork;
  /** The HTTP proxy the computers' web traffic goes through, and what skips it (plan 9.5). */
  sandboxProxy?: { url: string; noProxy?: string };
  /**
   * The instance's timezone (IANA name, default UTC): the computers' clock, so
   * the Bots' shells, browsers and the wallpaper follow the owner's day.
   */
  timezone: string;
  /**
   * The `remote` computer provider (plan 9.2): a control agent already running
   * at this URL. When set it is used instead of Docker. It is one machine:
   * the first account to use it keeps it, unless `shared` lets every account
   * on the install use it (and share its files and logins).
   */
  computerAgent?: { url: string; token: string; shared: boolean };
  /**
   * What kind of install this is (OPENBOTS_DEPLOYMENT). `self_hosted`, the
   * default, is a personal install with one account, its owner: sign-up
   * closes once it exists, and the members, invites and audit log routes
   * answer 404. `managed` is the hosted OpenBots service, where admins
   * manage members.
   */
  deployment: Deployment;
  /**
   * The Mac app's local owner token (OPENBOTS_LOCAL_TOKEN), self-hosted only.
   * With it the Mac app that runs this stack signs its owner in through
   * `POST /api/v1/local/session` instead of a password: the install has no
   * sign-in, sign-up or sign-out. Only the app's main process holds it.
   */
  localToken?: string;
  /**
   * Who may sign up on the managed service (plan 21.6): `open` lets anyone
   * sign up and make an organization; `invite` and `first_user_admin` (its
   * old name) let only the first user and people with a pending invitation.
   * Self-hosted is always closed after its owner.
   */
  signupMode: 'first_user_admin' | 'invite' | 'open';
  /**
   * Whether admins may mark a provider, connector or event subscription as
   * on their own network, so it may reach private addresses (S-8,
   * OPENBOTS_LOCAL_ENDPOINTS). On by default for a self-hosted install; off by
   * default on the managed service, whose network every organization shares.
   */
  localEndpoints: boolean;
  /**
   * Whether an organization's admins may turn custom stdio connectors on at
   * all (S-1, OPENBOTS_CUSTOM_STDIO): each runs a command on the server. On by
   * default for a self-hosted install; off by default on the managed
   * service, whose server every organization shares.
   */
  customStdio: boolean;
  /**
   * Where stdio connectors run (OPENBOTS_STDIO_RUNNER). `host`, the default
   * for a self-hosted install, runs them as child processes of this server,
   * as an unprivileged user. `computer`, the default on the managed service,
   * runs each in its owner's computer for that organization, so no two
   * accounts or organizations share a process or a filesystem. The managed
   * service refuses `host` unless the operator sets
   * OPENBOTS_ALLOW_HOST_STDIO, and then warns at every start.
   */
  stdioRunner: StdioRunner;
  filesDir: string;
  /** The catalog's pre-installed stdio servers (S-20). */
  mcpCatalog: CatalogInstall;
  role: 'api' | 'worker' | 'all';
  /** Bearer token for `GET /metrics`; metrics are off without one. */
  metricsToken?: string;
  /**
   * Reverse proxies and tunnels whose `X-Forwarded-For` is believed (CIDR
   * ranges). Empty means the header is ignored (see client-ip.ts).
   */
  trustedProxies: string[];
  providerKeys: {
    anthropic?: string;
    openai?: string;
    xai?: string;
    google?: string;
    ollamaBaseUrl?: string;
  };
  /** Sign-in providers (U1), each enabled only when both its id and secret are set. */
  oauth: {
    github?: OAuthClient;
    google?: OAuthClient;
  };
  limits: Limits;
  /**
   * Approval expiry, the MCP idle stop and the web_fetch caps
   * (OPENBOTS_APPROVAL_TTL_MINUTES and so on): set at start, not admin settings.
   */
  processLimits: ProcessLimits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = resolveSecretFiles(env);
  const parsed = envSchema.safeParse(secrets.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  if (e.OPENBOTS_MASTER_KEY_PREVIOUS.includes(e.OPENBOTS_MASTER_KEY.trim())) {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_MASTER_KEY_PREVIOUS: holds OPENBOTS_MASTER_KEY itself; list only the keys being replaced',
    );
  }
  // The standalone image runs one person's OpenBots, database and computer in
  // one container (V6): it is never the managed service.
  if (e.OPENBOTS_STANDALONE && e.OPENBOTS_DEPLOYMENT === 'managed') {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_DEPLOYMENT: the standalone image is a single-person install and runs self_hosted only; unset OPENBOTS_DEPLOYMENT or set it to self_hosted',
    );
  }
  if (e.OPENBOTS_LOCAL_TOKEN && e.OPENBOTS_DEPLOYMENT !== 'self_hosted') {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_LOCAL_TOKEN: only a self-hosted install signs in with the Mac app; unset it for managed',
    );
  }
  const stdioRunner =
    e.OPENBOTS_STDIO_RUNNER ?? (e.OPENBOTS_DEPLOYMENT === 'managed' ? 'computer' : 'host');
  if (
    e.OPENBOTS_DEPLOYMENT === 'managed' &&
    stdioRunner === 'host' &&
    !e.OPENBOTS_ALLOW_HOST_STDIO
  ) {
    throw new Error(
      "invalid configuration:\n  OPENBOTS_STDIO_RUNNER: host would run every organization's stdio connectors on this one server; use computer, or set OPENBOTS_ALLOW_HOST_STDIO=1 to accept that",
    );
  }
  let sandboxNetwork: SandboxNetwork;
  try {
    sandboxNetwork = resolveSandboxNetwork(e.OPENBOTS_SANDBOX_NETWORK, e.OPENBOTS_SANDBOX_BRIDGE);
  } catch (error) {
    throw new Error(`invalid configuration:\n  ${(error as Error).message}`, { cause: error });
  }
  const raw = e as Record<string, unknown>;
  const limitOverrides: Partial<Limits> = {};
  for (const [key, name] of Object.entries(LIMIT_ENV_VARS) as [keyof Limits, string][]) {
    limitOverrides[key] = raw[name] as number | undefined;
  }
  const processOverrides: Partial<ProcessLimits> = {};
  for (const [key, name] of Object.entries(PROCESS_LIMIT_ENV_VARS) as [
    keyof ProcessLimits,
    string,
  ][]) {
    processOverrides[key] = raw[name] as number | undefined;
  }
  return {
    publicUrl: e.OPENBOTS_PUBLIC_URL,
    ...(e.OPENBOTS_RELAY_URL ? { relayUrl: e.OPENBOTS_RELAY_URL.replace(/\/+$/, '') } : {}),
    masterKey: e.OPENBOTS_MASTER_KEY,
    previousMasterKeys: e.OPENBOTS_MASTER_KEY_PREVIOUS,
    secretsFromEnvironment: secrets.fromEnvironment,
    databaseUrl: e.DATABASE_URL,
    ...(e.OPENBOTS_DB_APP_PASSWORD ? { dbAppPassword: e.OPENBOTS_DB_APP_PASSWORD } : {}),
    redisUrl: e.REDIS_URL,
    dockerHost: e.DOCKER_HOST,
    sandboxImage: e.OPENBOTS_SANDBOX_IMAGE,
    sandboxNetwork,
    sandboxProxy: e.OPENBOTS_SANDBOX_EGRESS_PROXY
      ? { url: e.OPENBOTS_SANDBOX_EGRESS_PROXY, noProxy: e.OPENBOTS_SANDBOX_NO_PROXY }
      : undefined,
    timezone: e.OPENBOTS_TIMEZONE,
    computerAgent: e.OPENBOTS_COMPUTER_AGENT_URL
      ? {
          url: e.OPENBOTS_COMPUTER_AGENT_URL,
          token: e.OPENBOTS_COMPUTER_AGENT_TOKEN ?? '',
          shared: e.OPENBOTS_COMPUTER_AGENT_SHARED,
        }
      : undefined,
    deployment: e.OPENBOTS_DEPLOYMENT,
    localToken: e.OPENBOTS_LOCAL_TOKEN,
    signupMode: e.OPENBOTS_SIGNUP_MODE,
    localEndpoints: e.OPENBOTS_LOCAL_ENDPOINTS ?? e.OPENBOTS_DEPLOYMENT === 'self_hosted',
    customStdio: e.OPENBOTS_CUSTOM_STDIO ?? e.OPENBOTS_DEPLOYMENT === 'self_hosted',
    stdioRunner,
    filesDir: e.OPENBOTS_FILES_DIR,
    mcpCatalog: { dir: e.OPENBOTS_MCP_DIR, allowNpx: e.OPENBOTS_MCP_NPX_FALLBACK },
    role: e.OPENBOTS_ROLE,
    metricsToken: e.OPENBOTS_METRICS_TOKEN,
    trustedProxies: e.TRUSTED_PROXIES,
    providerKeys: {
      anthropic: e.ANTHROPIC_API_KEY,
      openai: e.OPENAI_API_KEY,
      xai: e.XAI_API_KEY,
      google: e.GOOGLE_GENERATIVE_AI_API_KEY,
      ollamaBaseUrl: e.OLLAMA_BASE_URL,
    },
    oauth: {
      github: oauthClient(e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET),
      google: oauthClient(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    },
    limits: resolveLimits(limitOverrides),
    processLimits: resolveProcessLimits(processOverrides),
  };
}

function oauthClient(clientId?: string, clientSecret?: string): OAuthClient | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Every variable `loadConfig` reads. `.env.example` lists them all (env-example.test.ts). */
export const CONFIG_ENV_VARS: readonly string[] = Object.keys(envSchema.shape);
