// Product limits (PRD section 6), and the webhook rate limits beside them.
// The server overrides any of them from `OPENBOTS_LIMITS_*` environment
// variables, and the admin from Settings. Two limits in PRD section 6 are not
// here because 1.0 fixes them: one computer per account (`computers.owner_id`
// is unique) and one computer-use task per Bot at a time (`ScreenLocks`).

export const DEFAULT_LIMITS = {
  botsPerAccount: 50,
  botsPerGroup: 6,
  routinesPerBot: 50,
  /** The account's Skills library, however its Skills arrive (typed, saved, imported). */
  skillsPerAccount: 200,
  runRecordsPerRoutine: 20,
  webhookPayloadBytes: 1024 * 1024,
  syncWebhookWaitSeconds: 60,
  /** Webhook requests a minute from one address to all endpoints, before the body is read. */
  webhookIpRatePerMin: 600,
  /** Failed webhook verifications a minute from one address to one endpoint; past it, 429. */
  webhookFailedAuthPerMin: 10,
  /** Verified deliveries a minute to an endpoint that sets no rate limit of its own. */
  webhookEndpointRatePerMin: 60,
  /** Largest file accepted by `POST /api/v1/files`. */
  uploadBytes: 25 * 1024 * 1024,
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

export const LIMIT_ENV_VARS: { [K in keyof Limits]: string } = {
  botsPerAccount: 'OPENBOTS_LIMITS_BOTS_PER_ACCOUNT',
  botsPerGroup: 'OPENBOTS_LIMITS_BOTS_PER_GROUP',
  routinesPerBot: 'OPENBOTS_LIMITS_ROUTINES_PER_BOT',
  skillsPerAccount: 'OPENBOTS_LIMITS_SKILLS_PER_ACCOUNT',
  runRecordsPerRoutine: 'OPENBOTS_LIMITS_RUN_RECORDS_PER_ROUTINE',
  webhookPayloadBytes: 'OPENBOTS_LIMITS_WEBHOOK_PAYLOAD_BYTES',
  syncWebhookWaitSeconds: 'OPENBOTS_LIMITS_SYNC_WEBHOOK_WAIT_SECONDS',
  webhookIpRatePerMin: 'OPENBOTS_LIMITS_WEBHOOK_IP_RATE_PER_MIN',
  webhookFailedAuthPerMin: 'OPENBOTS_LIMITS_WEBHOOK_FAILED_AUTH_PER_MIN',
  webhookEndpointRatePerMin: 'OPENBOTS_LIMITS_WEBHOOK_ENDPOINT_RATE_PER_MIN',
  uploadBytes: 'OPENBOTS_LIMITS_UPLOAD_BYTES',
};

export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    const value = overrides[key];
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

// Process limits: read from the environment when the server starts, the same
// for every account. Unlike the limits above they are not admin settings,
// because what they size (approval and sign-in expiry jobs, the MCP manager's sessions,
// the web tools) is set up once per process.

export const DEFAULT_PROCESS_LIMITS = {
  /**
   * How long an approval request waits for the owner before it expires, denied
   * (plan 5.6). Sign-in requests expire on the same clock (plan 9.7).
   */
  approvalTtlMinutes: 24 * 60,
  /** An MCP session unused this long is stopped; the next call starts it again (plan 8). */
  mcpIdleStopMinutes: 10,
  /** Characters of a fetched page that web_fetch hands the model. */
  webFetchMaxChars: 40_000,
  /** How long web_fetch waits for a page, redirects included. */
  webFetchTimeoutSeconds: 30,
} as const;

export type ProcessLimits = { -readonly [K in keyof typeof DEFAULT_PROCESS_LIMITS]: number };

export const PROCESS_LIMIT_ENV_VARS: { [K in keyof ProcessLimits]: string } = {
  approvalTtlMinutes: 'OPENBOTS_APPROVAL_TTL_MINUTES',
  mcpIdleStopMinutes: 'OPENBOTS_MCP_IDLE_STOP_MINUTES',
  webFetchMaxChars: 'OPENBOTS_WEB_FETCH_MAX_CHARS',
  webFetchTimeoutSeconds: 'OPENBOTS_WEB_FETCH_TIMEOUT_SECONDS',
};

export function resolveProcessLimits(overrides: Partial<ProcessLimits> = {}): ProcessLimits {
  const limits: ProcessLimits = { ...DEFAULT_PROCESS_LIMITS };
  for (const key of Object.keys(limits) as (keyof ProcessLimits)[]) {
    const value = overrides[key];
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}
