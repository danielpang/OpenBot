import { hkdfSync } from 'node:crypto';
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthPlugin, type InternalAdapter } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { symmetricEncrypt } from 'better-auth/crypto';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { CLIENT_IP_HEADER } from './client-ip.js';
import type { Config } from './config.js';
import { schema, type Db } from './db/client.js';
import { asDirectory, inWorkspace, withScope } from './db/scope.js';
import { problem } from './errors.js';
import type { RateLimiter } from './infra/rate-limit.js';
import type { Logger } from './logger.js';
import { parseMasterKey } from './secrets.js';
import { recordAudit } from './services/audit.js';
import { ensureWorkspace, lockWorkspace } from './workspace.js';

// better-auth (plan section 3): email and password, optional GitHub and Google
// sign-in, cookie sessions, and API keys (U4). Mounted at `/api/auth/*`.
//
// Organizations (plan section 21): a self-hosted install (OPENBOTS_DEPLOYMENT)
// is one person's, in one implicit organization. Its first account is the
// owner and every later signup is refused, whatever the request. That policy
// lives in the user-create hooks so it covers every way an account is made,
// OAuth included. On the managed service the core makes no membership at
// signup: the managed build (ee/server) adds better-auth's organization
// plugin and its hooks through `plugins`, which decide who may sign up, make
// organizations, redeem invitations and pick a session's active organization.
//
// Rate limits (plan 17 control 6, S-6) are on in every environment, in the
// infra's limiter (Redis when REDIS_URL is set), keyed on the client address
// `createApp` resolves per TRUSTED_PROXIES and passes in CLIENT_IP_HEADER.
// A request without one is refused rather than counted in a shared bucket.
//
// Audit (S-11): every new session is an `auth.sign_in` (email, OAuth, and
// the sign-in that follows a signup) in the organization it is active in,
// signing out is `auth.sign_out`, and a refused email sign-in is
// `auth.sign_in_failed` with the address tried, in each organization the
// account belongs to.
//
// The Mac app's local mode (OPENBOTS_LOCAL_TOKEN, routes/local.ts) has no
// sign-in at all: `createLocalSession`, a server-only endpoint (no HTTP path),
// makes the owner if there is none yet, through the same user hooks as the
// setup wizard, and gives them an ordinary session. That owner has a
// placeholder email and no password, so nobody can sign in as them. Its
// session is audited as `auth.local_session` rather than `auth.sign_in`.
// With a local token configured nothing else makes a user or a session:
// email and OAuth sign-up and sign-in answer 403 LOCAL_ONLY (here and in the
// hooks below), so nobody who reaches the port can make the owner first with
// a password they know. An owner from before local mode keeps their account,
// and is signed in by the app; their password no longer works.
//
// Pairing a phone with a server that has no owner yet (headless first run,
// MOBILE_AND_VM_PLAN.md 8.3) makes the owner the same way, through
// `createPairingOwner`, another server-only endpoint: the same placeholder
// email, no password, and no session (the phone gets an API key instead,
// services/devices.ts).
//
// Sign-in providers' access and refresh tokens are encrypted at rest with the
// better-auth secret (`encryptOAuthTokens`, S-9); rows from before are
// encrypted at start-up by `encryptStoredOAuthTokens`.

export const API_KEY_PREFIX = 'obk_';

/**
 * The email of an owner the Mac app created (routes/local.ts). It is never
 * shown, and with no password nobody signs in with it.
 */
export const LOCAL_OWNER_EMAIL = 'owner@openbots.local';

/** better-auth's path for `createLocalSession`, which no HTTP request reaches. */
const LOCAL_SESSION_PATH = '/openbots/local-session';

/** better-auth's path for `createPairingOwner`, which no HTTP request reaches either. */
const PAIRING_OWNER_PATH = '/openbots/pairing-owner';

/** The server-only endpoints that may make the owner in local mode. */
const OWNER_PATHS = new Set([LOCAL_SESSION_PATH, PAIRING_OWNER_PATH]);

/** Every way in but the Mac app's, refused when it signs the owner in (see the top). */
const SIGN_IN_PATHS = /^\/api\/auth\/(sign-up|sign-in|callback|oauth2)(\/|$)/;

export const LOCAL_ONLY_MESSAGE = 'This OpenBots server signs in from the Mac app only.';

const localOnly = () =>
  new APIError('FORBIDDEN', { code: 'LOCAL_ONLY', message: LOCAL_ONLY_MESSAGE });

/**
 * The part of the better-auth instance the server uses. Spelled out because the
 * inferred type is too large to emit; widen it when a route needs more.
 */
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string }; session: { id: string } } | null>;
    verifyApiKey(input: {
      body: { key: string };
    }): Promise<{ valid: boolean; key: { id: string; referenceId: string } | null }>;
    createApiKey(input: {
      body: { name: string; userId: string; expiresIn: number | null };
    }): Promise<{
      id: string;
      name: string | null;
      start: string | null;
      key: string;
      createdAt: Date;
      expiresAt: Date | null;
    }>;
    /**
     * Signs the install's owner in, creating them first (named `name`) when
     * there is no user yet. The response carries the session cookie.
     */
    createLocalSession(input: {
      body: { name: string };
      headers: Headers;
      asResponse: true;
    }): Promise<Response>;
    /**
     * The install's owner, created first (named `name`, no password, no
     * session) when there is none yet. For pairing on a fresh install.
     */
    createPairingOwner(input: {
      body: { name: string };
    }): Promise<{ user: { id: string; name: string }; created: boolean }>;
  };
}

const signupClosed = () =>
  new APIError('FORBIDDEN', {
    code: 'SIGNUP_CLOSED',
    message: 'This OpenBots server already has its owner. Sign in instead.',
  });

export function createAuth({
  config,
  db,
  logger,
  limiter,
  rateLimit = true,
  plugins = [],
}: {
  config: Config;
  db: Db;
  logger: Logger;
  limiter: RateLimiter;
  /** Tests that sign many people up from no address turn this off. */
  rateLimit?: boolean;
  /** better-auth plugins from the managed build (`ServerExtensions.authPlugins`). */
  plugins?: BetterAuthPlugin[];
}): Auth {
  const origin = new URL(config.publicUrl).origin;
  const { github, google } = config.oauth;
  // Read at each call: tests turn an install self-hosted while it runs.
  const selfHosted = () => config.deployment === 'self_hosted';

  const instance = betterAuth({
    appName: 'OpenBots',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: authSecret(config.masterKey),
    trustedOrigins: [origin],
    // better-auth's own queries are the directory's (db/scope.ts).
    database: drizzleAdapter(withScope(db, { directory: true }), {
      provider: 'pg',
      schema,
      usePlural: true,
    }),
    emailAndPassword: { enabled: true },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      ...(github && { github }),
      ...(google && { google }),
    },
    rateLimit: {
      enabled: rateLimit,
      // better-auth's own defaults, stated; sign-in and sign-up get its
      // stricter built-in rules (3 per 10 s).
      window: 10,
      max: 100,
      customStorage: {
        consume: (key, rule) => limiter.consume(`auth:${key}`, rule),
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.publicUrl.startsWith('https://'),
      // Postgres generates uuid ids (see db/schema/auth.ts).
      database: { generateId: false },
    },
    logger: {
      log: (level, message, ...args) => logger[level]({ args }, `better-auth: ${message}`),
    },
    plugins: [
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        // Keys stand in for a session on the whole API; quotas belong to the
        // routes, not the key.
        rateLimit: { enabled: false },
      }),
      ownerPlugin(db),
      ...plugins,
    ],
    databaseHooks: {
      user: {
        create: {
          // On a self-hosted install the first account is the owner and the
          // only one (U1). The managed build's plugin hooks run before these.
          before: async (_user, ctx) => {
            if (config.localToken && !OWNER_PATHS.has(ctx?.path ?? '')) throw localOnly();
            if (!selfHosted()) return;
            await ensureWorkspace(db);
            const [anyUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
            if (anyUser) throw signupClosed();
          },
          after: async (user) => {
            if (!selfHosted()) return;
            const workspace = await ensureWorkspace(db);
            const joined = await inWorkspace(workspace.id, () =>
              db.transaction(async (tx) => {
                await lockWorkspace(tx);
                const [owner] = await tx
                  .select({ id: schema.workspaceMembers.id })
                  .from(schema.workspaceMembers)
                  .where(
                    and(
                      eq(schema.workspaceMembers.workspaceId, workspace.id),
                      eq(schema.workspaceMembers.role, 'owner'),
                    ),
                  )
                  .limit(1);
                // Two first signups can both pass `before`; under the lock only
                // the first becomes the owner.
                if (owner) return false;
                await tx
                  .insert(schema.workspaceMembers)
                  .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
                return true;
              }),
            );
            if (!joined) {
              await db.delete(schema.users).where(eq(schema.users.id, user.id));
              throw signupClosed();
            }
          },
        },
      },
      session: {
        create: {
          // On a self-hosted install nobody but the owner signs in.
          before: async (session, ctx) => {
            if (config.localToken && ctx?.path !== LOCAL_SESSION_PATH) throw localOnly();
            if (!selfHosted()) return;
            const workspace = await ensureWorkspace(db);
            const [member] = await inWorkspace(workspace.id, () =>
              db
                .select({ role: schema.workspaceMembers.role })
                .from(schema.workspaceMembers)
                .where(
                  and(
                    eq(schema.workspaceMembers.userId, session.userId),
                    eq(schema.workspaceMembers.workspaceId, workspace.id),
                  ),
                ),
            );
            if (member && member.role !== 'owner') {
              throw new APIError('FORBIDDEN', {
                code: 'NOT_OWNER',
                message: 'This OpenBots server has one account, its owner.',
              });
            }
          },
          after: async (session, ctx) => {
            const active = activeOrganizationOf(session);
            if (ctx?.path === LOCAL_SESSION_PATH) {
              await auditAuth(db, config, 'auth.local_session', session.userId, active, {
                ip: session.ipAddress ?? null,
              });
              return;
            }
            await auditAuth(db, config, 'auth.sign_in', session.userId, active, {
              via: ctx?.path ?? null,
              ip: session.ipAddress ?? null,
            });
          },
        },
        delete: {
          after: async (session, ctx) => {
            // Expiry and revocation delete sessions too; only signing out counts.
            if (ctx?.path !== '/sign-out') return;
            await auditAuth(
              db,
              config,
              'auth.sign_out',
              session.userId,
              activeOrganizationOf(session),
              {},
            );
          },
        },
      },
    },
  });

  return {
    api: instance.api,
    async handler(request) {
      if (rateLimit && !request.headers.get(CLIENT_IP_HEADER)) {
        const body = problem(400, "The client's address is unknown", { code: 'CLIENT_IP_UNKNOWN' });
        return Response.json(body, {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      const { pathname } = new URL(request.url);
      if (config.localToken && SIGN_IN_PATHS.test(pathname)) {
        const body = problem(403, LOCAL_ONLY_MESSAGE, { code: 'LOCAL_ONLY' });
        return Response.json(body, {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      if (request.method !== 'POST' || pathname !== SIGN_IN_EMAIL) {
        return instance.handler(request);
      }
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { email?: unknown } | null;
      const response = await instance.handler(request);
      if (response.status === 401 || response.status === 403) {
        const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
        await auditFailedSignIn(
          db,
          config,
          email,
          request.headers.get(CLIENT_IP_HEADER),
          response.status,
        );
      }
      return response;
    },
  };
}

const SIGN_IN_EMAIL = '/api/auth/sign-in/email';

/** The owner of the implicit organization (a self-hosted install has only them). */
export async function findInstallOwner(db: Db): Promise<string | undefined> {
  const workspace = await ensureWorkspace(db);
  const [owner] = await inWorkspace(workspace.id, () =>
    db
      .select({ id: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspace.id),
          eq(schema.workspaceMembers.role, 'owner'),
        ),
      )
      .orderBy(asc(schema.workspaceMembers.createdAt))
      .limit(1),
  );
  return owner?.id;
}

/**
 * The install's owner, made first when there is none: through the user
 * hooks above, which make the first user the owner as for setup, with the
 * placeholder email and no password. `created` says whether this call made them.
 */
async function ensureOwner(
  adapter: InternalAdapter,
  db: Db,
  name: string,
  method: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await findInstallOwner(db);
  if (existing) return { id: existing, created: false };
  try {
    const user = await adapter.createUser(
      { email: LOCAL_OWNER_EMAIL, name, emailVerified: false },
      { method },
    );
    return { id: user.id, created: true };
  } catch (error) {
    // Two first calls at once: the other one made the owner.
    const other = await findInstallOwner(db);
    if (!other) throw error;
    return { id: other, created: false };
  }
}

/** `createLocalSession` and `createPairingOwner` (see the top of this file). */
function ownerPlugin(db: Db) {
  const body = z.object({ name: z.string().min(1).max(100) });
  return {
    id: 'openbots-owner',
    endpoints: {
      createLocalSession: createAuthEndpoint(
        LOCAL_SESSION_PATH,
        {
          method: 'POST',
          body,
          // Called from routes/local.ts only, never routed.
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          const owner = await ensureOwner(adapter, db, ctx.body.name, 'openbots-local');
          const user = await adapter.findUserById(owner.id);
          if (!user) throw new APIError('NOT_FOUND', { message: 'The owner is gone' });
          const session = await adapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, name: user.name } });
        },
      ),
      createPairingOwner: createAuthEndpoint(
        PAIRING_OWNER_PATH,
        {
          method: 'POST',
          body,
          // Called from services/devices.ts only, never routed.
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          const owner = await ensureOwner(adapter, db, ctx.body.name, 'openbots-pairing');
          const user = await adapter.findUserById(owner.id);
          if (!user) throw new APIError('NOT_FOUND', { message: 'The owner is gone' });
          return ctx.json({ user: { id: user.id, name: user.name }, created: owner.created });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

/** The session's active organization (the organization plugin's field), if any. */
function activeOrganizationOf(session: object): string | null {
  const value = (session as { activeOrganizationId?: unknown }).activeOrganizationId;
  return typeof value === 'string' ? value : null;
}

/**
 * The organizations an account's audit rows go to: the implicit one on a
 * self-hosted install, else the session's active organization, else every
 * organization the account belongs to.
 */
async function auditOrganizations(
  db: Db,
  config: Config,
  userId: string | null,
  activeOrganizationId: string | null,
): Promise<string[]> {
  if (config.deployment === 'self_hosted') return [(await ensureWorkspace(db)).id];
  if (activeOrganizationId) return [activeOrganizationId];
  if (!userId) return [];
  // Every organization of one account: the directory's to say.
  const rows = await asDirectory(() =>
    db
      .select({ id: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId)),
  );
  return rows.map((r) => r.id);
}

async function auditAuth(
  db: Db,
  config: Config,
  action: 'auth.sign_in' | 'auth.sign_out' | 'auth.local_session',
  userId: string,
  activeOrganizationId: string | null,
  metadata: Record<string, unknown>,
) {
  for (const workspaceId of await auditOrganizations(db, config, userId, activeOrganizationId)) {
    await inWorkspace(workspaceId, () =>
      recordAudit(db, {
        workspaceId,
        actor: { type: 'user', id: userId },
        action,
        targetType: 'user',
        targetId: userId,
        metadata,
      }),
    );
  }
}

/**
 * The account tried, when there is one, is the actor. On the managed service
 * the attempt is recorded in every organization the account belongs to; an
 * unknown address is recorded only on a self-hosted install.
 */
async function auditFailedSignIn(
  db: Db,
  config: Config,
  email: string | null,
  ip: string | null,
  status: number,
) {
  const [user] = email
    ? await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
    : [];
  for (const workspaceId of await auditOrganizations(db, config, user?.id ?? null, null)) {
    await inWorkspace(workspaceId, () =>
      recordAudit(db, {
        workspaceId,
        actor: { type: 'user', id: user?.id ?? null },
        action: 'auth.sign_in_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        metadata: { email, ip, status },
      }),
    );
  }
}

/** better-auth's own test for an encrypted token (`isLikelyEncrypted` in its oauth2 utils). */
export const isEncrypted = (token: string) =>
  token.startsWith('$ba$') || (token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token));

/**
 * Encrypts OAuth tokens stored in plain text before `encryptOAuthTokens` was
 * on (S-9). better-auth reads both, so this can run at any start; `main.ts`
 * calls it after the migrations. The id token is left alone, as better-auth
 * never encrypts it.
 */
export async function encryptStoredOAuthTokens({
  db,
  config,
}: {
  db: Db;
  config: Pick<Config, 'masterKey'>;
}): Promise<number> {
  const key = authSecret(config.masterKey);
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(or(isNotNull(schema.accounts.accessToken), isNotNull(schema.accounts.refreshToken)));
  let changed = 0;
  for (const row of rows) {
    const set: { accessToken?: string; refreshToken?: string } = {};
    for (const field of ['accessToken', 'refreshToken'] as const) {
      const token = row[field];
      if (token && !isEncrypted(token)) set[field] = await symmetricEncrypt({ key, data: token });
    }
    if (!Object.keys(set).length) continue;
    await db.update(schema.accounts).set(set).where(eq(schema.accounts.id, row.id));
    changed++;
  }
  return changed;
}

/**
 * better-auth's signing secret, derived from the master key so installs need
 * no extra variable. A new master key means a new secret: sessions end, and
 * `rotateMasterKey` re-encrypts the OAuth tokens.
 */
export function authSecret(masterKey: string): string {
  const key = hkdfSync('sha256', parseMasterKey(masterKey), '', 'openbots:better-auth', 32);
  return Buffer.from(key).toString('base64');
}
