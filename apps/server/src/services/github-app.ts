import { createHmac, randomBytes, sign as rsaSign, timingSafeEqual } from 'node:crypto';
import {
  GITHUB_APP_MANIFEST_EVENTS,
  GITHUB_APP_WEBHOOK_PATH,
  type GitConnectionRepoAccess,
} from '@openbots/shared';
import { lt } from 'drizzle-orm';
import { BlockedAddressError, guardedFetch, type NetOptions } from '../builtins/net.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError } from '../errors.js';
import { parseMasterKey } from '../secrets.js';
import { loadGithubApp, saveGithubApp } from './github-app-store.js';
import type {
  GithubAppCredentials,
  GithubAppService,
  InstallationRepo,
  InstallationToken,
  InstallationTokenScope,
  StoredGithubApp,
} from './github-app-types.js';

// The GitHub App (GH1, GH2, GH7, GH8; I17). One service per install: the
// manifest flow that makes a self-hoster's own App, the install redirect,
// installation tokens minted with the App's JWT (RS256, signed here with
// node:crypto) and cached until five minutes before they expire, repository
// listings, and webhook signatures. Every call to GitHub goes through the
// outbound guard (S-8) held to GitHub's API host, with a 30 second timeout.
// No token is ever logged.
//
// The manifest flow's and the install's `state` is a short-lived token signed
// with a key derived from the master key and bound to the owner who started
// the flow (`signGithubState`), so a callback cannot bind an App or an
// installation to another owner, and single use (`consumeGithubState`), so a
// callback URL cannot be replayed. The state alone does not prove the owner
// may use the installation the callback names, though: anyone can type an
// `installation_id`. So the App asks for the user's authorization during
// install (`request_oauth_on_install`), the callback carries a `code`, and
// git-connections.ts binds the installation only when the user's own token
// lists it (`GET /user/installations`), keeping the repositories that token
// reaches in it (`GET /user/installations/{id}/repositories`) as the
// connection's whole reach. The user token is revoked right after. An App
// from GITHUB_APP_* must have
// "Request user authorization (OAuth) during installation" on, its callback
// URL at INSTALL_CALLBACK_PATH, and GITHUB_APP_CLIENT_ID and
// GITHUB_APP_CLIENT_SECRET set.

type GithubDeps = Pick<AppDeps, 'db' | 'config'> & Partial<Pick<AppDeps, 'net'>>;

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 8 * 1024 * 1024;
/** A cached token is used until this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long a flow's `state` holds. */
export const GITHUB_STATE_TTL_MS = 10 * 60_000;
/** GitHub's limit on an App's name. */
const APP_NAME_MAX = 34;

export const MANIFEST_CALLBACK_PATH = '/api/v1/git-connections/github-app/manifest/callback';
export const INSTALL_CALLBACK_PATH = '/api/v1/git-connections/github-app/callback';
/** Where the App's user sign-in (GH8, "Act as me") lands: the connectors' OAuth callback. */
export const APP_OAUTH_CALLBACK_PATH = '/api/v1/connectors/oauth/callback';

/** What the App asks for on every installation (I17). */
export const GITHUB_APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
  checks: 'read',
} as const;

/** GitHub answered with an error status. */
export class GithubApiError extends DomainError {
  constructor(
    readonly githubStatus: number,
    message: string,
  ) {
    super(502, 'GITHUB_ERROR', message);
    this.name = 'GithubApiError';
  }
}

/** The account an installation belongs to. */
export interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: 'user' | 'organization';
}

/** The service, plus the calls git-connections.ts needs beyond the shared contract. */
export interface GithubApp extends GithubAppService {
  /** `GET /app/installations/{id}` with the App's JWT. */
  installation(installationId: string): Promise<GithubInstallation>;
  /** `GET /user` with a pasted or OAuth token: whose it is. */
  tokenUser(token: string): Promise<{ login: string; type: 'user' | 'organization' }>;
  /** Every repository a user token reaches, all pages. */
  listTokenRepos(token: string): Promise<InstallationRepo[]>;
  /**
   * Exchanges the install's OAuth `code` for a user-to-server token, with
   * the App's client id and secret. The caller discards it after use.
   */
  userToken(code: string): Promise<string>;
  /** The ids of the App's installations the user's token may reach (`GET /user/installations`). */
  userInstallationIds(userToken: string): Promise<string[]>;
  /**
   * The repositories of one installation the user's token reaches, all
   * pages (`GET /user/installations/{id}/repositories`), with the user's
   * `push` and `admin` there.
   */
  userInstallationRepos(
    userToken: string,
    installationId: string,
  ): Promise<GitConnectionRepoAccess[]>;
  /** Revokes a user token (`DELETE /applications/{client_id}/token`). */
  revokeUserToken(userToken: string): Promise<void>;
  /**
   * github.com/login/oauth/authorize for the App's client, carrying `state`
   * and coming back to `redirectUri`: the user authorizes again, so a
   * connection's repositories can be read again. 409 without a client.
   */
  authorizeUrl(state: string, redirectUri: string): Promise<string>;
  /** How many installation tokens the cache holds (expired ones are evicted on every mint). */
  cachedTokenCount(): number;
}

/** A GitHub login (user or organization): letters, digits and single inner hyphens, 39 at most. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const NO_CLIENT_CREDENTIALS =
  'The GitHub App has no OAuth client, so OpenBots cannot check that the installation is yours. Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to the App\'s client id and secret, and turn on "Request user authorization (OAuth) during installation".';

export interface GithubAppOptions {
  /** GitHub's REST API base; tests stand in a fake. */
  apiBase?: string;
  /** github.com, for the manifest form and the install page. */
  webBase?: string;
  /** Unix milliseconds; tests stand in a clock. */
  now?: () => number;
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** An RS256 JWT for the App (iss its id, iat a minute back for clock drift, exp nine minutes on). */
export function appJwt(app: Pick<GithubAppCredentials, 'appId' | 'privateKey'>, nowMs: number) {
  const now = Math.floor(nowMs / 1000);
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }));
  const signature = rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), app.privateKey);
  return `${head}.${body}.${base64url(signature)}`;
}

interface GithubRepoJson {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string;
  description?: string | null;
  pushed_at?: string | null;
}

const toRepo = (r: GithubRepoJson): InstallationRepo => ({
  id: String(r.id),
  fullName: r.full_name,
  private: r.private,
  defaultBranch: r.default_branch ?? 'main',
  description: r.description ?? null,
  pushedAt: r.pushed_at ? new Date(r.pushed_at).toISOString() : null,
  remembered: false,
});

const accountType = (type: unknown): 'user' | 'organization' =>
  type === 'Organization' ? 'organization' : 'user';

/** A token scope's cache key: the installation, its sorted repositories and permissions. */
const scopeKey = (installationId: string, scope: InstallationTokenScope) =>
  JSON.stringify([
    installationId,
    [...(scope.repositories ?? [])].map((r) => r.toLowerCase()).sort(),
    Object.entries(scope.permissions).sort(([a], [b]) => a.localeCompare(b)),
  ]);

/** The App's public URL, https only: GitHub delivers webhooks and redirects there. */
function httpsPublicUrl(publicUrl: string): string {
  let url: URL | null;
  try {
    url = new URL(publicUrl);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') {
    throw new DomainError(
      400,
      'PUBLIC_URL_REQUIRED',
      'Making a GitHub App needs an https address GitHub can reach. Set OPENBOTS_PUBLIC_URL to it, then try again.',
    );
  }
  return publicUrl.replace(/\/+$/, '');
}

export function createGithubAppService(
  deps: GithubDeps,
  options: GithubAppOptions = {},
): GithubApp {
  const apiBase = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
  const webBase = (options.webBase ?? GITHUB_WEB).replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const netFor = (base: string): NetOptions => ({
    ...deps.net,
    allowlist: [new URL(base).hostname],
    timeoutMs: TIMEOUT_MS,
    maxRedirects: 3,
  });
  const net = netFor(apiBase);
  const webNet = netFor(webBase);
  const tokens = new Map<string, InstallationToken>();
  /** Drops cached tokens past their margin, so the cache holds only usable ones. */
  const evictExpired = () => {
    for (const [key, token] of tokens) {
      if (token.expiresAt.getTime() - TOKEN_MARGIN_MS <= now()) tokens.delete(key);
    }
  };

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    auth: { bearer: string } | { basic: string } | null,
    body?: unknown,
    on: { base: string; net: NetOptions } = { base: apiBase, net },
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'OpenBots',
      'x-github-api-version': '2022-11-28',
    };
    if (auth) {
      headers.authorization =
        'bearer' in auth
          ? `Bearer ${auth.bearer}`
          : `Basic ${Buffer.from(auth.basic).toString('base64')}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await guardedFetch(
        `${on.base}${path}`,
        { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
        MAX_BYTES,
        on.net,
      );
    } catch (error) {
      if (error instanceof BlockedAddressError) {
        throw new DomainError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached');
      }
      const name = (error as Error).name;
      const why = name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'failed';
      throw new DomainError(502, 'GITHUB_UNAVAILABLE', `The request to GitHub ${why}`);
    }
    let data: unknown;
    try {
      data = res.body.length ? JSON.parse(res.body.toString('utf8')) : null;
    } catch {
      data = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const said = (data as { message?: unknown } | null)?.message;
      throw new GithubApiError(
        res.status,
        `GitHub answered ${res.status}${typeof said === 'string' ? `: ${said.slice(0, 300)}` : ''}`,
      );
    }
    return data as T;
  }

  async function app(): Promise<GithubAppCredentials> {
    const loaded = await loadGithubApp(deps);
    if (!loaded) {
      throw new DomainError(409, 'GITHUB_APP_MISSING', 'This install has no GitHub App yet');
    }
    return loaded.app;
  }

  async function pages<T>(
    path: string,
    bearer: string,
    pick: (page: unknown) => T[],
  ): Promise<T[]> {
    const all: T[] = [];
    // 100 pages of 100: far past what a picker shows, and a bound on a loop.
    for (let page = 1; page <= 100; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = pick(await call('GET', `${path}${sep}per_page=100&page=${page}`, { bearer }));
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  const service: GithubApp = {
    async credentials() {
      return (await loadGithubApp(deps))?.app ?? null;
    },

    async manifestUrl(state, options = {}) {
      const organization = options.organization?.trim();
      if (organization !== undefined && !GITHUB_LOGIN.test(organization)) {
        throw new DomainError(
          400,
          'INVALID_ORGANIZATION',
          'That is not a GitHub organization name',
        );
      }
      if (deps.config.githubApp || deps.config.deployment === 'managed') {
        throw new DomainError(
          409,
          'GITHUB_APP_FROM_CONFIG',
          'This install uses the GitHub App from its configuration',
        );
      }
      const publicUrl = httpsPublicUrl(deps.config.publicUrl);
      if (await loadGithubApp(deps)) {
        throw new DomainError(409, 'GITHUB_APP_EXISTS', 'This install already has a GitHub App');
      }
      const host = new URL(publicUrl).host;
      const manifest = {
        name: `OpenBots (${host})`.slice(0, APP_NAME_MAX),
        url: publicUrl,
        hook_attributes: { url: `${publicUrl}${GITHUB_APP_WEBHOOK_PATH}`, active: true },
        redirect_url: `${publicUrl}${MANIFEST_CALLBACK_PATH}`,
        // The first is where the install's user authorization lands.
        callback_urls: [
          `${publicUrl}${INSTALL_CALLBACK_PATH}`,
          `${publicUrl}${APP_OAUTH_CALLBACK_PATH}`,
        ],
        // With request_oauth_on_install GitHub skips setup_url on install;
        // it is kept for updates, which come back with a code too.
        setup_url: `${publicUrl}${INSTALL_CALLBACK_PATH}`,
        setup_on_update: true,
        request_oauth_on_install: true,
        // Private: only the account that owns the App can install it. Made
        // under an organization, that organization can; made on the admin's
        // personal account, only that account can.
        public: false,
        default_permissions: { ...GITHUB_APP_PERMISSIONS },
        default_events: [...GITHUB_APP_MANIFEST_EVENTS],
      };
      const where = organization
        ? `/organizations/${encodeURIComponent(organization)}/settings/apps/new`
        : '/settings/apps/new';
      return { url: `${webBase}${where}?state=${encodeURIComponent(state)}`, manifest };
    },

    async completeManifest(code) {
      // Never over an existing App: its installations would be orphaned.
      if (await loadGithubApp(deps)) {
        throw new DomainError(409, 'GITHUB_APP_EXISTS', 'This install already has a GitHub App');
      }
      const made = await call<{
        id: number | string;
        slug: string;
        pem: string;
        client_id: string;
        client_secret: string;
        webhook_secret: string;
      }>('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`, null);
      if (!made?.id || !made.slug || !made.pem || !made.webhook_secret) {
        throw new DomainError(502, 'GITHUB_ERROR', 'GitHub did not return the new App');
      }
      const stored: StoredGithubApp = {
        appId: String(made.id),
        slug: made.slug,
        privateKeyPem: made.pem,
        clientId: made.client_id ?? '',
        clientSecret: made.client_secret ?? '',
        webhookSecret: made.webhook_secret,
        createdAt: new Date(now()).toISOString(),
      };
      await saveGithubApp(deps, stored);
      tokens.clear();
      return {
        appId: stored.appId,
        slug: stored.slug,
        privateKey: stored.privateKeyPem,
        webhookSecret: stored.webhookSecret,
        ...(stored.clientId && stored.clientSecret
          ? { clientId: stored.clientId, clientSecret: stored.clientSecret }
          : {}),
      };
    },

    async installUrl(state) {
      const { slug } = await app();
      return `${webBase}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
    },

    async installationToken(installationId, scope) {
      evictExpired();
      const key = scopeKey(installationId, scope);
      const cached = tokens.get(key);
      if (cached && cached.expiresAt.getTime() - TOKEN_MARGIN_MS > now()) return cached;
      const creds = await app();
      const repositories = scope.repositories?.map((r) => r.split('/').pop()!);
      const minted = await call<{
        token: string;
        expires_at: string;
        permissions?: Record<string, string>;
        repositories?: { full_name: string }[];
      }>(
        'POST',
        `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        { bearer: appJwt(creds, now()) },
        { ...(repositories ? { repositories } : {}), permissions: scope.permissions },
      );
      const token: InstallationToken = {
        token: minted.token,
        expiresAt: new Date(minted.expires_at),
        permissions: minted.permissions ?? { ...scope.permissions },
        ...(minted.repositories
          ? { repositories: minted.repositories.map((r) => r.full_name) }
          : {}),
      };
      tokens.set(key, token);
      return token;
    },

    async listInstallationRepos(installationId) {
      const { token } = await service.installationToken(installationId, {
        permissions: { metadata: 'read' },
      });
      return pages('/installation/repositories', token, (page) =>
        ((page as { repositories?: GithubRepoJson[] } | null)?.repositories ?? []).map(toRepo),
      );
    },

    async verifyWebhook(rawBody, signature256) {
      if (!signature256?.startsWith('sha256=')) return false;
      const creds = await service.credentials();
      if (!creds?.webhookSecret) return false;
      const expected = Buffer.from(
        `sha256=${createHmac('sha256', creds.webhookSecret).update(rawBody).digest('hex')}`,
      );
      const given = Buffer.from(signature256);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    async installation(installationId) {
      const creds = await app();
      const found = await call<{ id: number; account?: { login?: string; type?: string } }>(
        'GET',
        `/app/installations/${encodeURIComponent(installationId)}`,
        { bearer: appJwt(creds, now()) },
      );
      if (!found?.account?.login) {
        throw new DomainError(502, 'GITHUB_ERROR', 'GitHub did not say whose installation it is');
      }
      return {
        id: String(found.id ?? installationId),
        accountLogin: found.account.login,
        accountType: accountType(found.account.type),
      };
    },

    async tokenUser(token) {
      const user = await call<{ login?: string; type?: string }>('GET', '/user', {
        bearer: token,
      });
      if (!user?.login) throw new DomainError(502, 'GITHUB_ERROR', 'GitHub did not name the user');
      return { login: user.login, type: accountType(user.type) };
    },

    async userToken(code) {
      const creds = await app();
      if (!creds.clientId || !creds.clientSecret) {
        throw new DomainError(409, 'GITHUB_APP_NO_CLIENT', NO_CLIENT_CREDENTIALS);
      }
      const answer = await call<{ access_token?: string; error?: string }>(
        'POST',
        '/login/oauth/access_token',
        null,
        { client_id: creds.clientId, client_secret: creds.clientSecret, code },
        { base: webBase, net: webNet },
      );
      if (!answer?.access_token) {
        throw new DomainError(
          400,
          'GITHUB_CODE_INVALID',
          'GitHub did not accept the authorization. Start again.',
        );
      }
      return answer.access_token;
    },

    async userInstallationIds(userToken) {
      const found = await pages('/user/installations', userToken, (page) =>
        ((page as { installations?: { id: number | string }[] } | null)?.installations ?? []).map(
          (i) => String(i.id),
        ),
      );
      return found;
    },

    async userInstallationRepos(userToken, installationId) {
      type Json = { full_name?: string; permissions?: { push?: boolean; admin?: boolean } };
      return pages(
        `/user/installations/${encodeURIComponent(installationId)}/repositories`,
        userToken,
        (page) =>
          ((page as { repositories?: Json[] } | null)?.repositories ?? [])
            .filter((r): r is Json & { full_name: string } => typeof r.full_name === 'string')
            .map((r) => ({
              fullName: r.full_name,
              push: r.permissions?.push === true,
              admin: r.permissions?.admin === true,
            })),
      );
    },

    async revokeUserToken(userToken) {
      const creds = await app();
      if (!creds.clientId || !creds.clientSecret) return;
      await call(
        'DELETE',
        `/applications/${encodeURIComponent(creds.clientId)}/token`,
        { basic: `${creds.clientId}:${creds.clientSecret}` },
        { access_token: userToken },
      );
    },

    async authorizeUrl(state, redirectUri) {
      const creds = await app();
      if (!creds.clientId || !creds.clientSecret) {
        throw new DomainError(409, 'GITHUB_APP_NO_CLIENT', NO_CLIENT_CREDENTIALS);
      }
      const url = new URL(`${webBase}/login/oauth/authorize`);
      url.searchParams.set('client_id', creds.clientId);
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectUri);
      return url.toString();
    },

    cachedTokenCount() {
      return tokens.size;
    },

    async listTokenRepos(token) {
      return pages('/user/repos?sort=pushed', token, (page) =>
        (Array.isArray(page) ? (page as GithubRepoJson[]) : []).map(toRepo),
      );
    },
  };
  return service;
}

/** One service per install, kept by its config, so the token cache is shared. */
const services = new WeakMap<object, GithubApp>();

/** The install's GitHub App service. */
export function githubAppFor(deps: GithubDeps): GithubApp {
  let found = services.get(deps.config);
  if (!found) {
    found = createGithubAppService(deps);
    services.set(deps.config, found);
  }
  return found;
}

/** Puts a service in place for an install; tests point one at a fake GitHub. */
export function useGithubAppService(deps: Pick<AppDeps, 'config'>, service: GithubApp): void {
  services.set(deps.config, service);
}

// Signed, short-lived flow state, bound to the owner.

/** `reauth` reads an App connection's repositories again (GH2), for `connectionId`. */
export type GithubStatePurpose = 'manifest' | 'install' | 'reauth';

export interface GithubStateOwner {
  userId: string;
  workspaceId: string;
  /** The connection a `reauth` state is for. */
  connectionId?: string;
}

/** A verified state: its owner, its purpose, and what makes it single use. */
export interface VerifiedGithubState extends GithubStateOwner {
  purpose: GithubStatePurpose;
  nonce: string;
  expiresAt: number;
}

const stateKey = (config: Pick<AppDeps['config'], 'masterKey'>) =>
  createHmac('sha256', parseMasterKey(config.masterKey))
    .update('openbots:github-app-state')
    .digest();

const stateMac = (config: Pick<AppDeps['config'], 'masterKey'>, payload: string) =>
  createHmac('sha256', stateKey(config)).update(payload).digest();

/** `state` for a manifest or install flow: who started it, for what, until when. */
export function signGithubState(
  config: Pick<AppDeps['config'], 'masterKey'>,
  purpose: GithubStatePurpose,
  owner: GithubStateOwner,
  nowMs = Date.now(),
): string {
  const payload = base64url(
    JSON.stringify({
      p: purpose,
      u: owner.userId,
      w: owner.workspaceId,
      ...(owner.connectionId ? { c: owner.connectionId } : {}),
      e: nowMs + GITHUB_STATE_TTL_MS,
      n: randomBytes(9).toString('base64url'),
    }),
  );
  return `${payload}.${base64url(stateMac(config, payload))}`;
}

/**
 * The owner a `state` was made for, or null when it is forged, for another
 * flow (none of `purpose`, when a list) or expired. It does not spend the
 * state: `consumeGithubState` does.
 */
export function verifyGithubState(
  config: Pick<AppDeps['config'], 'masterKey'>,
  purpose: GithubStatePurpose | readonly GithubStatePurpose[],
  state: string | undefined,
  nowMs = Date.now(),
): VerifiedGithubState | null {
  const purposes: readonly unknown[] = typeof purpose === 'string' ? [purpose] : purpose;
  if (!state || state.length > 1024) return null;
  const [payload, mac, extra] = state.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = stateMac(config, payload);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: { p?: unknown; u?: unknown; w?: unknown; c?: unknown; e?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    return null;
  }
  if (!purposes.includes(parsed.p) || typeof parsed.e !== 'number' || parsed.e < nowMs) return null;
  if (typeof parsed.u !== 'string' || typeof parsed.w !== 'string') return null;
  if (typeof parsed.n !== 'string' || !parsed.n) return null;
  if (parsed.p === 'reauth' && typeof parsed.c !== 'string') return null;
  return {
    purpose: parsed.p as GithubStatePurpose,
    userId: parsed.u,
    workspaceId: parsed.w,
    ...(typeof parsed.c === 'string' ? { connectionId: parsed.c } : {}),
    nonce: parsed.n,
    expiresAt: parsed.e,
  };
}

/**
 * Spends a verified state: true the first time, false when its nonce was
 * used already (a replayed callback). Used nonces are kept until the state
 * would have expired anyway; expired ones are deleted here.
 */
export async function consumeGithubState(
  deps: Pick<AppDeps, 'db'>,
  state: Pick<VerifiedGithubState, 'nonce' | 'expiresAt'>,
  nowMs = Date.now(),
): Promise<boolean> {
  await deps.db
    .delete(schema.githubStateNonces)
    .where(lt(schema.githubStateNonces.expiresAt, new Date(nowMs)));
  const spent = await deps.db
    .insert(schema.githubStateNonces)
    .values({ nonce: state.nonce, expiresAt: new Date(state.expiresAt) })
    .onConflictDoNothing()
    .returning({ nonce: schema.githubStateNonces.nonce });
  return spent.length === 1;
}
