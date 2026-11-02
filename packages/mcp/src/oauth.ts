import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthTokenSet, SealedSecrets } from './types.js';

// OAuth 2.1 for Streamable HTTP connectors (plan 8): authorization code with
// PKCE (S256), RFC 9728 protected resource discovery, RFC 8414 metadata, RFC
// 7591 dynamic client registration when the server offers it and a
// user-supplied client otherwise, and refresh before expiry. The flow spans
// two HTTP requests, so everything in flight (state nonce, PKCE verifier) is
// returned to the caller to store sealed with the connector's secrets.
//
// The `state` sent to the authorization server is `<connectorId>.<nonce>`:
// the callback finds the connector by id and compares the nonce in constant
// time against the stored one. `discoverServer` answers, before a pasted URL
// is added, whether it needs OAuth and whether its authorization server
// registers clients itself, so one click can sign in.

type OAuthClient = NonNullable<NonNullable<SealedSecrets['oauth']>['client']>;
type Pending = NonNullable<NonNullable<SealedSecrets['oauth']>['pending']>;

/** How long a started authorization stays valid. */
export const OAUTH_PENDING_MS = 10 * 60_000;
/** Tokens are refreshed when they expire within this window. */
export const REFRESH_SKEW_MS = 60_000;

export class OAuthSetupError extends Error {
  constructor(
    readonly code: 'CLIENT_REQUIRED' | 'DISCOVERY_FAILED' | 'STATE_INVALID' | 'STATE_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthSetupError';
  }
}

/** Constant-time string comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface StartOAuthInput {
  /** The MCP server URL (the protected resource). */
  serverUrl: string;
  redirectUrl: string;
  /** Prefix of `state`, used by the callback to find the flow; the connector id. */
  stateId: string;
  clientName: string;
  scopes?: string[];
  /** A client registered by hand; skips dynamic registration. */
  client?: OAuthClient;
  /** Added to the authorization URL; never replaces what the flow itself sets. */
  authorizationParams?: Record<string, string>;
  fetch?: FetchLike;
  now?: number;
}

export interface StartedOAuth {
  authorizationUrl: string;
  state: string;
  client: OAuthClient;
  pending: Pending;
}

export async function startOAuth(input: StartOAuthInput): Promise<StartedOAuth> {
  let info;
  try {
    info = await discoverOAuthServerInfo(input.serverUrl, { fetchFn: input.fetch });
  } catch (err) {
    throw new OAuthSetupError(
      'DISCOVERY_FAILED',
      `Could not discover the authorization server: ${(err as Error).message}`,
    );
  }
  const metadata = info.authorizationServerMetadata;
  const scope = input.scopes?.length ? input.scopes.join(' ') : undefined;
  const resource = info.resourceMetadata?.resource;

  let client = input.client;
  if (!client) {
    if (!metadata?.registration_endpoint) {
      throw new OAuthSetupError(
        'CLIENT_REQUIRED',
        'This server does not support dynamic client registration; add an OAuth client id for it.',
      );
    }
    const registered = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: input.clientName,
        redirect_uris: [input.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(scope ? { scope } : {}),
      },
      fetchFn: input.fetch,
    });
    client = { ...registered };
  }

  const nonce = randomBytes(32).toString('base64url');
  const state = `${input.stateId}.${nonce}`;
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: input.redirectUrl,
    state,
    ...(scope ? { scope } : {}),
    ...(resource ? { resource: new URL(resource) } : {}),
  });
  for (const [name, value] of Object.entries(input.authorizationParams ?? {})) {
    if (!authorizationUrl.searchParams.has(name)) authorizationUrl.searchParams.set(name, value);
  }
  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    client,
    pending: {
      nonce,
      codeVerifier,
      redirectUrl: input.redirectUrl,
      authorizationServerUrl: info.authorizationServerUrl,
      ...(resource ? { resource } : {}),
      expiresAt: (input.now ?? Date.now()) + OAUTH_PENDING_MS,
    },
  };
}

/**
 * How a Streamable HTTP server wants to be signed in to, found before a
 * connector is added from a pasted URL: `none` when it answers without a
 * token and publishes no protected resource metadata, `oauth` when an
 * authorization server is found (RFC 9728, then RFC 8414 or OIDC), and
 * `bearer` when it refuses (401) but names no authorization server, so it
 * needs a token the owner pastes.
 */
export interface ServerDiscovery {
  auth: 'none' | 'oauth' | 'bearer';
  /** OAuth only: the authorization server registers clients itself (RFC 7591). */
  dynamicRegistration: boolean;
  authorizationServerUrl: string | null;
}

const PROBE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'OpenBots', version: '0' },
  },
};

/** Sends an unauthenticated `initialize` and reads where to sign in. */
export async function discoverServer(
  serverUrl: string,
  options: { fetch?: FetchLike } = {},
): Promise<ServerDiscovery> {
  const fetchFn = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(PROBE),
    });
  } catch (err) {
    throw new OAuthSetupError(
      'DISCOVERY_FAILED',
      `Could not reach the server: ${(err as Error).message}`,
    );
  }
  const unauthorized = res.status === 401;
  const { resourceMetadataUrl } = unauthorized ? extractWWWAuthenticateParams(res) : {};
  const session = res.headers.get('mcp-session-id');
  await res.body?.cancel().catch(() => undefined);
  // A server that opened a session for the probe can drop it now.
  if (session) {
    void Promise.resolve(
      fetchFn(serverUrl, { method: 'DELETE', headers: { 'mcp-session-id': session } }),
    ).catch(() => undefined);
  }

  const resource = await discoverOAuthProtectedResourceMetadata(
    serverUrl,
    resourceMetadataUrl ? { resourceMetadataUrl } : {},
    fetchFn,
  ).catch(() => undefined);
  if (!unauthorized && !resource) {
    return { auth: 'none', dynamicRegistration: false, authorizationServerUrl: null };
  }
  const authorizationServerUrl =
    resource?.authorization_servers?.[0] ?? new URL('/', serverUrl).toString();
  const metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
    fetchFn,
  }).catch(() => undefined);
  if (!metadata) {
    return {
      auth: unauthorized ? 'bearer' : 'none',
      dynamicRegistration: false,
      authorizationServerUrl: null,
    };
  }
  return {
    auth: 'oauth',
    dynamicRegistration: Boolean(metadata.registration_endpoint),
    authorizationServerUrl,
  };
}

/** Splits `state` into the connector id and nonce; null when malformed. */
export function parseState(state: string): { id: string; nonce: string } | null {
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;
  return { id: state.slice(0, dot), nonce: state.slice(dot + 1) };
}

/** Throws unless `state` matches the stored flow and it has not expired. */
export function verifyState(state: string, pending: Pending | undefined, now = Date.now()): void {
  const parsed = parseState(state);
  if (!pending || !parsed || !safeEqual(parsed.nonce, pending.nonce)) {
    throw new OAuthSetupError('STATE_INVALID', 'This sign-in link is not valid; start again.');
  }
  if (now > pending.expiresAt) {
    throw new OAuthSetupError('STATE_EXPIRED', 'This sign-in took too long; start again.');
  }
}

export function tokenSet(
  tokens: OAuthTokens,
  now = Date.now(),
  previous?: OAuthTokenSet,
): OAuthTokenSet {
  const refresh = tokens.refresh_token ?? previous?.refresh_token;
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    ...(refresh ? { refresh_token: refresh } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(tokens.expires_in !== undefined ? { expires_at: now + tokens.expires_in * 1000 } : {}),
  };
}

export interface FinishOAuthInput {
  code: string;
  pending: Pending;
  client: OAuthClient;
  fetch?: FetchLike;
  now?: number;
}

/** Exchanges the code with the PKCE verifier. Call `verifyState` first. */
export async function finishOAuth(input: FinishOAuthInput): Promise<OAuthTokenSet> {
  const { pending } = input;
  const metadata = await discoverAuthorizationServerMetadata(pending.authorizationServerUrl, {
    fetchFn: input.fetch,
  });
  const tokens = await exchangeAuthorization(pending.authorizationServerUrl, {
    metadata,
    clientInformation: input.client,
    authorizationCode: input.code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUrl,
    ...(pending.resource ? { resource: new URL(pending.resource) } : {}),
    fetchFn: input.fetch,
  });
  return tokenSet(tokens, input.now);
}

/** True when the token is expired or expires within `REFRESH_SKEW_MS`. */
export function needsRefresh(tokens: OAuthTokenSet, now = Date.now()): boolean {
  return tokens.expires_at !== undefined && tokens.expires_at - REFRESH_SKEW_MS <= now;
}

export interface RefreshOAuthInput {
  authorizationServerUrl: string;
  client: OAuthClient;
  tokens: OAuthTokenSet;
  resource?: string;
  fetch?: FetchLike;
  now?: number;
}

export async function refreshOAuth(input: RefreshOAuthInput): Promise<OAuthTokenSet> {
  if (!input.tokens.refresh_token) throw new Error('no refresh token; sign in again');
  const metadata = await discoverAuthorizationServerMetadata(input.authorizationServerUrl, {
    fetchFn: input.fetch,
  });
  const tokens = await refreshAuthorization(input.authorizationServerUrl, {
    metadata,
    clientInformation: input.client,
    refreshToken: input.tokens.refresh_token,
    ...(input.resource ? { resource: new URL(input.resource) } : {}),
    fetchFn: input.fetch,
  });
  return tokenSet(tokens, input.now, input.tokens);
}
