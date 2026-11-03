import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Account, AppDeps, AppEnv, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { asDirectory, inWorkspace } from '../db/scope.js';
import { DomainError, forbidden, notFound, unauthorized } from '../errors.js';
import { touchDevice } from '../services/devices.js';
import { ensureWorkspace, isOrgAdmin, type Role } from '../workspace.js';

// Every route that needs a caller uses one of these. A request authenticates
// with the better-auth session cookie or with an API key (U4), sent as
// `Authorization: Bearer <key>` or `x-api-key: <key>`; both reach the same
// routes with the same permissions.
//
// The active organization (plan 21.2) is resolved on every request: the
// implicit one on a self-hosted install, else the session's active
// organization, or the organization an API key was made in. `requireUser`
// needs the caller to be a member of it and not suspended there, so a
// suspended member's sessions and API keys stop working in that organization
// only, and a session whose organization they left gets 403 NO_ORGANIZATION.
// On a self-hosted install only the owner gets in: accounts left from a
// managed install are refused, since nobody there can manage them.

// Behind these, the request's database work runs in its organization
// (db/scope.ts): Postgres then keeps every other organization's rows out of
// reach, whatever a query forgets to filter.

export const requireAccount = createMiddleware<AppEnv>(async (c, next) => {
  const account = await authenticateAccount(c.var.deps, c.req.raw.headers);
  c.set('account', account);
  const workspaceId = account.membership?.workspaceId;
  await (workspaceId ? inWorkspace(workspaceId, next) : next());
});

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await authenticate(c);
  c.set('user', user);
  await inWorkspace(user.workspaceId, next);
});

/** Owners and admins of the active organization. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = await authenticate(c);
  if (!isOrgAdmin(user.role)) throw forbidden('Only an admin can do this');
  c.set('user', user);
  await inWorkspace(user.workspaceId, next);
});

/**
 * Organization administration and the audit log belong to the managed
 * service. A self-hosted install has one owner and none of them: these
 * routes answer 404 there, before any sign-in check. Put it first.
 */
export const requireManaged = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.deps.config.deployment !== 'managed') throw notFound();
  await next();
});

/**
 * The first-run wizard's account step and sandbox image pull: a self-hosted
 * install's, answering 404 on the managed service, where people sign up and
 * the operator prepares the image (plan 21.5). Put it first.
 */
export const requireSelfHosted = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.deps.config.deployment !== 'self_hosted') throw notFound();
  await next();
});

export function apiKeyFrom(headers: Headers): string | undefined {
  const authorization = headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? headers.get('x-api-key') ?? undefined;
}

function authenticate(c: Context<AppEnv>): Promise<CurrentUser> {
  return authenticateHeaders(c.var.deps, c.req.raw.headers);
}

type AuthDeps = Pick<AppDeps, 'auth' | 'db' | 'config' | 'extensions'>;

/**
 * The caller behind a set of request headers, as a member of the active
 * organization. Throws 401 or 403. Used by the middleware above and the WS
 * upgrade.
 */
export async function authenticateHeaders(deps: AuthDeps, headers: Headers): Promise<CurrentUser> {
  return currentUserOf(deps, await authenticateAccount(deps, headers));
}

/** The member a signed-in account is in its active organization; throws 403 otherwise. */
export function currentUserOf(deps: Pick<AppDeps, 'config'>, account: Account): CurrentUser {
  const { membership, ...user } = account;
  if (!membership) {
    if (deps.config.deployment === 'self_hosted') {
      throw forbidden('This account is not a member of the workspace');
    }
    throw noOrganization();
  }
  if (membership.suspended) throw memberSuspended();
  if (deps.config.deployment === 'self_hosted' && membership.role !== 'owner') throw notOwner();
  return { ...user, role: membership.role, workspaceId: membership.workspaceId };
}

/** The signed-in account behind the headers, and its active membership if any. Throws 401. */
export async function authenticateAccount(deps: AuthDeps, headers: Headers): Promise<Account> {
  const { auth, db, config } = deps;
  const key = apiKeyFrom(headers);

  let userId: string | undefined;
  let via: Account['via'];
  let sessionId: string | null = null;
  let apiKeyId: string | null = null;
  let organizationId: string | null = null;
  if (key) {
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key) throw unauthorized('Invalid API key');
    userId = result.key.referenceId;
    via = 'api_key';
    apiKeyId = result.key.id;
    // The key's organization is the directory's to say.
    const [row] = await asDirectory(() =>
      db
        .select({ workspaceId: schema.apikeys.workspaceId })
        .from(schema.apikeys)
        .where(eq(schema.apikeys.id, result.key!.id)),
    );
    organizationId = row?.workspaceId ?? null;
  } else {
    const session = await auth.api.getSession({ headers });
    userId = session?.user.id;
    via = 'session';
    if (session) {
      sessionId = session.session.id;
      const [row] = await db
        .select({ active: schema.sessions.activeOrganizationId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.session.id));
      organizationId = row?.active ?? null;
    }
  }
  if (!userId) throw unauthorized();

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw unauthorized();
  // The managed build verifies email: an account that has not done it uses nothing yet.
  if (deps.extensions?.requireVerifiedEmail && !user.emailVerified) throw emailNotVerified();
  if (config.deployment === 'self_hosted') organizationId = (await implicitId(db)) ?? null;
  const membership = organizationId ? await membershipOf(db, user.id, organizationId) : null;
  // A paired device's key: when it was last seen (services/devices.ts).
  if (apiKeyId && organizationId) {
    await touchDevice(db, { workspaceId: organizationId, apiKeyId }).catch(() => undefined);
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    via,
    sessionId,
    apiKeyId,
    membership,
  };
}

/** A user's membership in an organization, or null when they are not in it. */
export async function membershipOf(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<Account['membership']> {
  const [member] = await inWorkspace(workspaceId, () =>
    db
      .select({
        role: schema.workspaceMembers.role,
        suspendedAt: schema.workspaceMembers.suspendedAt,
      })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      ),
  );
  if (!member) return null;
  return { workspaceId, role: member.role as Role, suspended: member.suspendedAt !== null };
}

// The implicit organization never changes once made, so it is looked up once per database.
const implicitIds = new WeakMap<Db, string>();

async function implicitId(db: Db): Promise<string> {
  const cached = implicitIds.get(db);
  if (cached) return cached;
  const { id } = await ensureWorkspace(db);
  implicitIds.set(db, id);
  return id;
}

export const emailNotVerified = () =>
  new DomainError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email first. We sent you a link.');

export const notOwner = () =>
  new DomainError(403, 'NOT_OWNER', 'This OpenBots server has one account, its owner.');

export const noOrganization = () =>
  new DomainError(403, 'NO_ORGANIZATION', 'Create or pick an organization first.');

export const memberSuspended = () =>
  new DomainError(
    403,
    'MEMBER_SUSPENDED',
    'You are suspended in this organization. Ask an admin to restore your access.',
  );
