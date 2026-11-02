import { z } from 'zod';

// Value sets for the `connectors` and `bot_connectors` text columns (plan 4.4)
// and the shape of `connectors.config`. Nothing secret lives in `config`:
// secret values, OAuth clients and tokens go in the sealed `connectors.secrets`
// envelope (`SealedSecrets` below), which the API never returns (P3).

export const ConnectorKindSchema = z.enum(['mcp_stdio', 'mcp_http', 'builtin']);
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;

/** `untested` until the first test or start; `needs_auth` when an OAuth login is missing or expired. */
export const ConnectorStatusSchema = z.enum(['untested', 'ok', 'error', 'needs_auth']);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const HttpAuthSchema = z.enum(['none', 'bearer', 'oauth']);
export type HttpAuth = z.infer<typeof HttpAuthSchema>;

/** `bot_connectors.approval_override`: forces a decision for every tool of the connector (null keeps the policy's). */
export const ApprovalOverrideSchema = z.enum(['auto', 'ask', 'deny']);
export type ApprovalOverride = z.infer<typeof ApprovalOverrideSchema>;

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const StdioConfigSchema = z.strictObject({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Non-secret environment; secrets are added from the envelope at start. */
  env: z.record(EnvName, z.string()).default({}),
  cwd: z.string().optional(),
});
export type StdioConfig = z.infer<typeof StdioConfigSchema>;

export const HttpConfigSchema = z.strictObject({
  transport: z.literal('http'),
  url: z.url(),
  auth: HttpAuthSchema.default('none'),
  /** Which secret carries the bearer token when `auth` is `bearer`. */
  bearerSecret: EnvName.optional(),
  /** Non-secret request headers. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Headers whose value is a secret: header name to secret name. */
  secretHeaders: z.record(z.string(), EnvName).optional(),
  scopes: z.array(z.string()).optional(),
});
export type HttpConfig = z.infer<typeof HttpConfigSchema>;

export const BuiltinConfigSchema = z.strictObject({
  transport: z.literal('builtin'),
  builtin: z.string().min(1),
});

export const TransportConfigSchema = z.discriminatedUnion('transport', [
  StdioConfigSchema,
  HttpConfigSchema,
  BuiltinConfigSchema,
]);
export type TransportConfig = z.infer<typeof TransportConfigSchema>;

/** A tool as `tools/list` reports it, the row cached in `connector_tools`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** What one session discovered: tools are cached in `connector_tools`; resources and prompts are stored for later use. */
export interface McpSnapshot {
  server: { name: string; version: string } | null;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export interface OAuthTokenSet {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** Epoch ms; absent when the server gave no `expires_in`. */
  expires_at?: number;
}

export const OAuthModeSchema = z.enum(['popup', 'external', 'redirect']);
export type OAuthMode = z.infer<typeof OAuthModeSchema>;

/** Plaintext of `connectors.secrets`. */
export interface SealedSecrets {
  /** Named secret values (env vars for stdio, the bearer token for http). */
  values: Record<string, string>;
  oauth?: {
    /** Registered (RFC 7591) or user-supplied client. */
    client?: { client_id: string; client_secret?: string; [key: string]: unknown };
    tokens?: OAuthTokenSet;
    /** The authorization server the tokens came from, for refresh. */
    authorizationServerUrl?: string;
    resource?: string;
    /** An authorization in flight: state nonce and PKCE verifier. */
    pending?: {
      nonce: string;
      codeVerifier: string;
      redirectUrl: string;
      authorizationServerUrl: string;
      resource?: string;
      expiresAt: number;
      /** The user who started it; the callback completes it for them only. */
      ownerId?: string;
      /**
       * Where the sign-in page was opened, which decides what the callback
       * answers: `popup` a window of the web app, `external` the default
       * browser (the Mac app), `redirect` the web app's own tab.
       */
      mode?: OAuthMode;
    };
  };
}

export const emptySecrets = (): SealedSecrets => ({ values: {} });
