import { z } from 'zod';

// The relay's settings, from the environment. Every APNs setting is optional:
// a relay without all four of the key file, key id, team id and topic carries
// streams only and answers every push `unavailable`, which is what a
// self-hosted relay does (the APNs key belongs to the App Store build).

export const RELAY_ENV_VARS = [
  'RELAY_PORT',
  'RELAY_HOST',
  'RELAY_TRUST_PROXY',
  'RELAY_APNS_KEY_FILE',
  'RELAY_APNS_KEY_ID',
  'RELAY_APNS_TEAM_ID',
  'RELAY_APNS_TOPIC',
  'RELAY_APNS_ENVIRONMENT',
  'RELAY_LOG_LEVEL',
] as const;

const EnvSchema = z.object({
  RELAY_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
  RELAY_HOST: z.string().default('0.0.0.0'),
  RELAY_TRUST_PROXY: z.stringbool().default(false),
  RELAY_APNS_KEY_FILE: z.string().optional(),
  RELAY_APNS_KEY_ID: z.string().optional(),
  RELAY_APNS_TEAM_ID: z.string().optional(),
  RELAY_APNS_TOPIC: z.string().optional(),
  RELAY_APNS_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  RELAY_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface RelayConfig {
  port: number;
  host: string;
  trustProxy: boolean;
  logLevel: string;
  /** Set only when every APNs setting is. */
  apns?: {
    keyFile: string;
    keyId: string;
    teamId: string;
    topic: string;
    environment: 'production' | 'sandbox';
  };
  /** The APNs settings that are missing while others are set, to warn about. */
  apnsMissing: string[];
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
    RELAY_APNS_KEY_FILE: e.RELAY_APNS_KEY_FILE,
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
  };
  if (missing.length === 0) {
    config.apns = {
      keyFile: e.RELAY_APNS_KEY_FILE!,
      keyId: e.RELAY_APNS_KEY_ID!,
      teamId: e.RELAY_APNS_TEAM_ID!,
      topic: e.RELAY_APNS_TOPIC!,
      environment: e.RELAY_APNS_ENVIRONMENT,
    };
  }
  return config;
}
