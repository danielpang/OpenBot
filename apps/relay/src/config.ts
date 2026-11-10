import { z } from 'zod';

// The relay's settings, from the environment. Every APNs setting is optional:
// a relay without all four of the key, key id, team id and topic carries
// streams only and answers every push `unavailable`, which is what a
// self-hosted relay does (the APNs key belongs to the App Store build). The
// key comes from a file (`RELAY_APNS_KEY_FILE`) or from `RELAY_APNS_KEY`
// itself (the `.p8` text, or its base64), which `takeApnsKey` reads once and
// then deletes from the process environment.
//
// Replays (`fly-replay`) only mean something behind Fly's proxy, so the relay
// replays only on Fly (`FLY_MACHINE_ID` is set) or with `RELAY_REPLAY=fly`.
// Anywhere else it serves every upgrade itself, and a relay of several
// machines there needs a proxy that routes by host id.
//
// On Fly the client's address is read from `fly-client-ip` (see
// `remoteAddress`); `RELAY_CLIENT_IP_HEADER` names another proxy's header.
//
// The cluster settings (MOBILE_AND_VM_PLAN.md 5.8): without `RELAY_REDIS_URL`
// the relay keeps its registry in memory and is a cluster of one, as a
// self-hosted relay is. The node id defaults to Fly's `FLY_MACHINE_ID`, and
// to a random one where that is not set.

export const RELAY_ENV_VARS = [
  'RELAY_PORT',
  'RELAY_HOST',
  'RELAY_TRUST_PROXY',
  'RELAY_CLIENT_IP_HEADER',
  'RELAY_APNS_KEY_FILE',
  'RELAY_APNS_KEY',
  'RELAY_APNS_KEY_ID',
  'RELAY_APNS_TEAM_ID',
  'RELAY_APNS_TOPIC',
  'RELAY_APNS_ENVIRONMENT',
  'RELAY_LOG_LEVEL',
  'RELAY_REDIS_URL',
  'RELAY_NODE_ID',
  'RELAY_MIN_CLUSTER_SIZE',
  'RELAY_LEASE_MS',
  'RELAY_LEASE_RENEW_MS',
  'RELAY_NODE_TTL_MS',
  'RELAY_NODE_HEARTBEAT_MS',
  'FLY_MACHINE_ID',
  'RELAY_METRICS_TOKEN',
  'RELAY_HOST_BUDGET_SHARE',
  'RELAY_REPLAY',
  'RELAY_PRESENCE_TOKEN',
  'RELAY_REDIS_COMMAND_TIMEOUT_MS',
  'POSTHOG_API_KEY',
  'RELAY_POSTHOG_HOST',
] as const;

const milliseconds = (fallback: number) => z.coerce.number().int().min(100).default(fallback);

const EnvSchema = z.object({
  RELAY_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
  RELAY_HOST: z.string().default('0.0.0.0'),
  RELAY_TRUST_PROXY: z.stringbool().default(false),
  RELAY_CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'must be a lower case header name')
    .optional(),
  RELAY_APNS_KEY_FILE: z.string().optional(),
  RELAY_APNS_KEY: z.string().optional(),
  RELAY_APNS_KEY_ID: z.string().optional(),
  RELAY_APNS_TEAM_ID: z.string().optional(),
  RELAY_APNS_TOPIC: z.string().optional(),
  RELAY_APNS_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  RELAY_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  RELAY_REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL')
    .optional(),
  RELAY_NODE_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits, dot, dash or underscore')
    .optional(),
  FLY_MACHINE_ID: z.string().optional(),
  RELAY_HOST_BUDGET_SHARE: z.coerce
    .number()
    .gt(0, 'must be above 0')
    .max(1, 'must be at most 1')
    .default(0.125),
  RELAY_METRICS_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  RELAY_PRESENCE_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  POSTHOG_API_KEY: z.string().min(1).optional(),
  RELAY_POSTHOG_HOST: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      );
    }, 'must be an https:// URL (http:// only for localhost)')
    .optional(),
  RELAY_REPLAY: z.enum(['fly', 'off']).optional(),
  RELAY_REDIS_COMMAND_TIMEOUT_MS: milliseconds(2_000),
  RELAY_MIN_CLUSTER_SIZE: z.coerce.number().int().min(1).default(1),
  RELAY_LEASE_MS: milliseconds(30_000),
  RELAY_LEASE_RENEW_MS: milliseconds(10_000),
  RELAY_NODE_TTL_MS: milliseconds(15_000),
  RELAY_NODE_HEARTBEAT_MS: milliseconds(5_000),
});

export interface RelayConfig {
  port: number;
  host: string;
  trustProxy: boolean;
  /** With `trustProxy`, the header that carries the client's address: `fly-client-ip` on Fly. */
  clientIpHeader?: string;
  logLevel: string;
  /** Set only when every APNs setting is. */
  apns?: {
    /** The key file, or unset when the key is in `RELAY_APNS_KEY` (read it with `takeApnsKey`). */
    keyFile?: string;
    keyId: string;
    teamId: string;
    topic: string;
    environment: 'production' | 'sandbox';
  };
  /** The APNs settings that are missing while others are set, to warn about. */
  apnsMissing: string[];
  /** The shared registry; unset means one in memory, for this relay alone. */
  redisUrl?: string;
  /** `RELAY_NODE_ID`, else `FLY_MACHINE_ID`; unset means a random one. */
  nodeId?: string;
  minClusterSize: number;
  /** The fraction of the byte budget one host's sockets may hold together. */
  hostBudgetShare: number;
  /** The bearer token for `GET /metrics`; unset turns the route off (404). */
  metricsToken?: string;
  /** The bearer token `GET /v1/hosts/{id}` wants; unset leaves presence open. */
  presenceToken?: string;
  /** `fly` on Fly (`FLY_MACHINE_ID` set) or with `RELAY_REPLAY=fly`; `off` serves every upgrade here. */
  replay: 'fly' | 'off';
  /** Anonymous usage data and errors to PostHog (telemetry.ts); unset sends nothing. */
  posthog?: { apiKey: string; host?: string };
  /** The time limit of one Redis call. */
  redisCommandTimeoutMs: number;
  cluster: { leaseMs: number; renewMs: number; nodeTtlMs: number; heartbeatMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  // An empty variable is an unset one, as compose files leave them.
  const present = Object.fromEntries(
    RELAY_ENV_VARS.flatMap((name) => {
      const value = env[name];
      return value === undefined || value === '' ? [] : [[name, value]];
    }),
  );
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid relay configuration:\n- ${problems.join('\n- ')}`);
  }
  const e = parsed.data;
  const apnsSettings = {
    RELAY_APNS_KEY_FILE: e.RELAY_APNS_KEY_FILE ?? e.RELAY_APNS_KEY,
    RELAY_APNS_KEY_ID: e.RELAY_APNS_KEY_ID,
    RELAY_APNS_TEAM_ID: e.RELAY_APNS_TEAM_ID,
    RELAY_APNS_TOPIC: e.RELAY_APNS_TOPIC,
  };
  const missing = Object.entries(apnsSettings)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  const config: RelayConfig = {
    port: e.RELAY_PORT,
    host: e.RELAY_HOST,
    trustProxy: e.RELAY_TRUST_PROXY,
    logLevel: e.RELAY_LOG_LEVEL,
    apnsMissing: missing.length === 4 ? [] : missing,
    minClusterSize: e.RELAY_MIN_CLUSTER_SIZE,
    hostBudgetShare: e.RELAY_HOST_BUDGET_SHARE,
    replay: e.RELAY_REPLAY ?? (e.FLY_MACHINE_ID ? 'fly' : 'off'),
    redisCommandTimeoutMs: e.RELAY_REDIS_COMMAND_TIMEOUT_MS,
    cluster: {
      leaseMs: e.RELAY_LEASE_MS,
      renewMs: e.RELAY_LEASE_RENEW_MS,
      nodeTtlMs: e.RELAY_NODE_TTL_MS,
      heartbeatMs: e.RELAY_NODE_HEARTBEAT_MS,
    },
  };
  if (e.RELAY_REDIS_URL) config.redisUrl = e.RELAY_REDIS_URL;
  if (e.RELAY_METRICS_TOKEN) config.metricsToken = e.RELAY_METRICS_TOKEN;
  if (e.POSTHOG_API_KEY) {
    config.posthog = {
      apiKey: e.POSTHOG_API_KEY,
      ...(e.RELAY_POSTHOG_HOST ? { host: e.RELAY_POSTHOG_HOST } : {}),
    };
  }
  if (e.RELAY_PRESENCE_TOKEN) config.presenceToken = e.RELAY_PRESENCE_TOKEN;
  const clientIpHeader =
    e.RELAY_CLIENT_IP_HEADER ?? (e.FLY_MACHINE_ID ? 'fly-client-ip' : undefined);
  if (clientIpHeader) config.clientIpHeader = clientIpHeader;
  const nodeId = e.RELAY_NODE_ID ?? e.FLY_MACHINE_ID;
  if (nodeId) config.nodeId = nodeId;
  const { leaseMs, renewMs, nodeTtlMs, heartbeatMs } = config.cluster;
  if (renewMs >= leaseMs || heartbeatMs >= nodeTtlMs) {
    throw new Error(
      'Invalid relay configuration:\n- RELAY_LEASE_RENEW_MS must be below RELAY_LEASE_MS, and RELAY_NODE_HEARTBEAT_MS below RELAY_NODE_TTL_MS',
    );
  }
  if (missing.length === 0) {
    config.apns = {
      ...(e.RELAY_APNS_KEY_FILE ? { keyFile: e.RELAY_APNS_KEY_FILE } : {}),
      keyId: e.RELAY_APNS_KEY_ID!,
      teamId: e.RELAY_APNS_TEAM_ID!,
      topic: e.RELAY_APNS_TOPIC!,
      environment: e.RELAY_APNS_ENVIRONMENT,
    };
  }
  return config;
}

/**
 * The APNs key's PEM text from `RELAY_APNS_KEY` (the `.p8` text, or its
 * base64, as a Fly secret holds it), deleted from `env` once read so it does
 * not stay in the process environment or reach a child process. Undefined
 * when the variable is unset.
 */
export function takeApnsKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.RELAY_APNS_KEY;
  delete env.RELAY_APNS_KEY;
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  if (text.startsWith('-----BEGIN')) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  if (!decoded.includes('-----BEGIN')) {
    throw new Error('RELAY_APNS_KEY must be the .p8 key, or its base64');
  }
  return decoded;
}
