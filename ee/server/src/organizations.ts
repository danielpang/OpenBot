import { and, asc, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Account, AppDeps, CurrentUser } from '@openbots/server/context';
import { schema, type Db } from '@openbots/server/db/client';
import { DomainError, forbidden, notFound } from '@openbots/server/errors';
import { endMembershipAccess } from '@openbots/server/membership';
import { recordAudit, userActor } from '@openbots/server/services/audit';
import { lockOrganization, organizationSlug, type Role } from '@openbots/server/workspace';
import { can } from './access.js';
import { errorText, sendInviteEmail, type EmailOptions } from './email.js';
import { INVITATION_DAYS, PENDING_INVITATIONS } from './plugin.js';
import { asDirectory, inWorkspace } from '@openbots/server/db/scope';

// Organizations, members and invitations on the managed service (plan
// 21.6). Creating an organization, switching to one and accepting an
// invitation go through better-auth's organization plugin, which needs the
// caller's session; the rest is done here on the same tables, under the
// organization's lock where the last-owner rule needs it, and audited in
// the organization.
//
// The rules the roles' statements (access.ts) cannot say:
// - Only an owner makes, demotes, suspends or removes an owner.
// - An organization always keeps an owner who is not suspended: the last
//   one cannot be demoted, suspended, removed or leave.
// - Nobody suspends or removes themselves here; leaving is its own route.
// Suspending or removing a member ends their access to that organization
// only (the core's `endMembershipAccess`); their data stays.

export interface OrganizationsDeps extends Pick<AppDeps, 'db' | 'config' | 'infra' | 'logger'> {
  auth: AppDeps['auth'];
  email: EmailOptions;
}

/** The organization plugin's endpoints routes.ts calls, as `auth.api` has them at run time. */
interface OrganizationApi {
  createOrganization(input: {
    body: { name: string; slug: string };
    headers: Headers;
  }): Promise<{ id: string; name: string; slug: string } | null>;
  setActiveOrganization(input: {
    body: { organizationId: string | null };
    headers: Headers;
  }): Promise<unknown>;
  acceptInvitation(input: { body: { invitationId: string }; headers: Headers }): Promise<unknown>;
}

const api = (deps: Pick<AppDeps, 'auth'>) => deps.auth.api as unknown as OrganizationApi;

/** Invitations an organization may send an hour, and organizations a person may make one. */
export const INVITATIONS_PER_HOUR = 30;
export const ORGANIZATIONS_PER_HOUR = 5;

export const lastOwner = () =>
  new DomainError(
    409,
    'LAST_OWNER',
    'The organization needs an owner. Make someone else an owner first.',
  );

const sessionRequired = () =>
  new DomainError(403, 'SESSION_REQUIRED', 'Do this signed in, not with an API key.');

const ownersOnly = () => forbidden('Only an owner can change an owner');

function assertSession(account: Pick<Account, 'via'>) {
  if (account.via !== 'session') throw sessionRequired();
}

function assertCan(user: Pick<CurrentUser, 'role'>, request: Parameters<typeof can>[1]) {
  if (!can(user.role, request)) throw forbidden('Only an owner or an admin can do this');
}

async function throttle(deps: Pick<AppDeps, 'infra'>, key: string, max: number) {
  const result = await deps.infra.limiter.consume(key, { window: 3600, max });
  if (!result.allowed) {
    throw new DomainError(429, 'RATE_LIMITED', 'Too many at once. Try again later.');
  }
}

async function audit(
  db: Db,
  workspaceId: string,
  actor: { id: string },
  action: string,
  target: { type: string; id: string | null },
  metadata: Record<string, unknown> = {},
) {
  await recordAudit(db, {
    workspaceId,
    actor: userActor(actor),
    action,
    targetType: target.type,
    targetId: target.id,
    metadata,
  });
}

// --- Organizations ---------------------------------------------------------------

export interface MyOrganization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  suspended: boolean;
  active: boolean;
}

/** The caller's organizations, oldest membership first, and which one this request works in. */
export async function listMyOrganizations(db: Db, account: Account): Promise<MyOrganization[]> {
  // Across organizations: the directory's to say (db/scope.ts).
  const rows = await asDirectory(() =>
    db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        role: schema.workspaceMembers.role,
        suspendedAt: schema.workspaceMembers.suspendedAt,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.userId, account.id))
      .orderBy(asc(schema.workspaceMembers.createdAt), asc(schema.workspaces.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    role: r.role as Role,
    suspended: r.suspendedAt !== null,
    active: account.membership?.workspaceId === r.id,
  }));
}

/** A new organization with the caller as its owner, now the session's active one. */
export async function createOrganization(
  deps: OrganizationsDeps,
  account: Account,
  headers: Headers,
  name: string,
) {
  assertSession(account);
  await throttle(deps, `org-create:${account.id}`, ORGANIZATIONS_PER_HOUR);
  let created: { id: string; name: string; slug: string } | null;
  try {
    created = await api(deps).createOrganization({
      body: { name, slug: organizationSlug(name) },
      headers,
    });
  } catch (error) {
    // The plugin's limit on organizations per person.
    const code = (error as { body?: { code?: string } }).body?.code;
    if (code === 'YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS') {
      throw new DomainError(
        409,
        'ORGANIZATION_LIMIT',
        'You belong to as many organizations as one person may.',
      );
    }
    throw error;
  }
  if (!created) throw new Error('The organization was not created');
  const { id } = created;
  await inWorkspace(id, () =>
    audit(deps.db, id, account, 'organization.create', { type: 'organization', id }, { name }),
  );
  return created;
}

/** Makes an organization the caller is in, and not suspended in, the session's active one. */
export async function activateOrganization(
  deps: OrganizationsDeps,
  account: Account,
  headers: Headers,
  workspaceId: string,
) {
  assertSession(account);
  const [member] = await inWorkspace(workspaceId, () =>
    deps.db
      .select({ suspendedAt: schema.workspaceMembers.suspendedAt })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, account.id),
        ),
      ),
  );
  if (!member) throw notFound('Organization not found');
  if (member.suspendedAt) {
    throw new DomainError(
      403,
      'MEMBER_SUSPENDED',
      'You are suspended in this organization. Ask an admin to restore your access.',
    );
  }
  await api(deps).setActiveOrganization({ body: { organizationId: workspaceId }, headers });
}

export async function renameOrganization(deps: OrganizationsDeps, user: CurrentUser, name: string) {
  assertCan(user, { organization: ['update'] });
  const [row] = await deps.db
    .update(schema.workspaces)
    .set({ name })
    .where(eq(schema.workspaces.id, user.workspaceId))
    .returning();
  await audit(
    deps.db,
    user.workspaceId,
    user,
    'organization.update',
    {
      type: 'organization',
      id: user.workspaceId,
    },
    { name },
  );
  return row!;
}

// --- Members ---------------------------------------------------------------------

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: Date;
  suspendedAt: Date | null;
}

/** The organization's members, oldest first. What they own stays theirs (U2). */
export async function listMembers(db: Db, workspaceId: string): Promise<MemberView[]> {
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.workspaceMembers.role,
      createdAt: schema.workspaceMembers.createdAt,
      suspendedAt: schema.workspaceMembers.suspendedAt,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(schema.workspaceMembers.createdAt), asc(schema.users.email));
  return rows.map((r) => ({ ...r, role: r.role as Role }));
}

async function memberRow(tx: Db, workspaceId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  if (!row) throw notFound('Member not found');
  return row;
}

/** Whether an owner other than `userId`, not suspended, would be left. */
async function otherOwner(tx: Db, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.role, 'owner'),
        sql`${schema.workspaceMembers.suspendedAt} is null`,
        ne(schema.workspaceMembers.userId, userId),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** Changes a member's role or suspends or restores them (see the rules at the top). */
export async function updateMember(
  deps: OrganizationsDeps,
  user: CurrentUser,
  userId: string,
  patch: { role?: Role; suspended?: boolean },
): Promise<MemberView> {
  assertCan(user, { member: ['update'] });
  const { workspaceId } = user;
  const suspending = await deps.db.transaction(async (tx) => {
    await lockOrganization(tx, workspaceId);
    const member = await memberRow(tx, workspaceId, userId);
    const role = patch.role ?? (member.role as Role);
    const suspendedAt =
      patch.suspended === undefined
        ? member.suspendedAt
        : patch.suspended
          ? (member.suspendedAt ?? new Date())
          : null;
    if (userId === user.id && patch.suspended) {
      throw new DomainError(409, 'CANNOT_SUSPEND_SELF', 'You cannot suspend yourself');
    }
    if (userId === user.id && role === 'owner' && member.role !== 'owner') throw ownersOnly();
    const touchesOwner = member.role === 'owner' || role === 'owner';
    if (touchesOwner && user.role !== 'owner') throw ownersOnly();
    const wasActiveOwner = member.role === 'owner' && member.suspendedAt === null;
    const staysActiveOwner = role === 'owner' && suspendedAt === null;
    if (wasActiveOwner && !staysActiveOwner && !(await otherOwner(tx, workspaceId, userId))) {
      throw lastOwner();
    }
    await tx
      .update(schema.workspaceMembers)
      .set({ role, suspendedAt })
      .where(eq(schema.workspaceMembers.id, member.id));
    const target = { type: 'user', id: userId };
    if (role !== member.role) {
      await audit(tx, workspaceId, user, 'member.role', target, { from: member.role, to: role });
    }
    const nowSuspended = member.suspendedAt === null && suspendedAt !== null;
    if (nowSuspended) await audit(tx, workspaceId, user, 'member.suspend', target);
    if (member.suspendedAt !== null && suspendedAt === null) {
      await audit(tx, workspaceId, user, 'member.restore', target);
    }
    return nowSuspended;
  });
  if (suspending) {
    await endMembershipAccess(deps, { userId, workspaceId, removed: false });
  }
  const member = (await listMembers(deps.db, workspaceId)).find((m) => m.id === userId);
  return member!;
}

/** Removes a member from the active organization. Their data stays, out of reach. */
export async function removeMember(deps: OrganizationsDeps, user: CurrentUser, userId: string) {
  assertCan(user, { member: ['delete'] });
  if (userId === user.id) {
    throw new DomainError(409, 'CANNOT_REMOVE_SELF', 'Leave the organization instead');
  }
  const { workspaceId } = user;
  await deps.db.transaction(async (tx) => {
    await lockOrganization(tx, workspaceId);
    const member = await memberRow(tx, workspaceId, userId);
    if (member.role === 'owner' && user.role !== 'owner') throw ownersOnly();
    if (member.role === 'owner' && !(await otherOwner(tx, workspaceId, userId))) {
      throw lastOwner();
    }
    await tx.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, member.id));
    await audit(
      tx,
      workspaceId,
      user,
      'member.remove',
      { type: 'user', id: userId },
      {
        role: member.role,
      },
    );
  });
  await endMembershipAccess(deps, { userId, workspaceId, removed: true });
}

/** The caller leaves the active organization; the last owner cannot. */
export async function leaveOrganization(deps: OrganizationsDeps, user: CurrentUser) {
  const { workspaceId } = user;
  await deps.db.transaction(async (tx) => {
    await lockOrganization(tx, workspaceId);
    const member = await memberRow(tx, workspaceId, user.id);
    if (member.role === 'owner' && !(await otherOwner(tx, workspaceId, user.id))) {
      throw lastOwner();
    }
    await tx.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, member.id));
    await audit(tx, workspaceId, user, 'member.leave', { type: 'user', id: user.id });
  });
  await endMembershipAccess(deps, { userId: user.id, workspaceId, removed: true });
}

// --- Invitations -----------------------------------------------------------------

export type InvitationRow = typeof schema.invites.$inferSelect;

export function inviteLink(config: Pick<AppDeps['config'], 'publicUrl'>, id: string) {
  return `${config.publicUrl.replace(/\/$/, '')}/sign-up?invite=${id}`;
}

const pending = () =>
  and(eq(schema.invites.status, 'pending'), gt(schema.invites.expiresAt, new Date()));

/** Pending invitations, newest first, with who sent each. */
export async function listInvitations(db: Db, workspaceId: string) {
  return db
    .select({ invite: schema.invites, inviterEmail: schema.users.email })
    .from(schema.invites)
    .leftJoin(schema.users, eq(schema.users.id, schema.invites.inviterId))
    .where(and(eq(schema.invites.workspaceId, workspaceId), pending()))
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));
}

/**
 * Invites an address to the active organization, replacing a pending
 * invitation for it, and emails the link when Resend is set up.
 */
export async function createInvitation(
  deps: OrganizationsDeps,
  user: CurrentUser,
  input: { email: string; role: Role },
): Promise<{ invite: InvitationRow; link: string; emailed: boolean }> {
  assertCan(user, { invitation: ['create'] });
  if (input.role === 'owner' && user.role !== 'owner') {
    throw forbidden('Only an owner can invite an owner');
  }
  const email = input.email.trim().toLowerCase();
  const { workspaceId } = user;
  const [member] = await deps.db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(
      and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.users.email, email)),
    );
  if (member) throw new DomainError(409, 'ALREADY_MEMBER', 'They are a member already');
  await throttle(deps, `invite:${workspaceId}`, INVITATIONS_PER_HOUR);
  const invite = await deps.db.transaction(async (tx) => {
    await lockOrganization(tx, workspaceId);
    // A new invitation replaces the pending one for the same address.
    await tx
      .update(schema.invites)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(schema.invites.workspaceId, workspaceId),
          eq(schema.invites.email, email),
          eq(schema.invites.status, 'pending'),
        ),
      );
    const [open] = await tx
      .select({ n: count() })
      .from(schema.invites)
      .where(and(eq(schema.invites.workspaceId, workspaceId), pending()));
    if ((open?.n ?? 0) >= PENDING_INVITATIONS) {
      throw new DomainError(
        409,
        'INVITATION_LIMIT',
        'Too many pending invites. Revoke some first.',
      );
    }
    const [row] = await tx
      .insert(schema.invites)
      .values({
        workspaceId,
        email,
        role: input.role,
        status: 'pending',
        inviterId: user.id,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
      })
      .returning();
    await audit(
      tx,
      workspaceId,
      user,
      'invitation.create',
      { type: 'invite', id: row!.id },
      {
        email,
        role: input.role,
      },
    );
    return row!;
  });
  const link = inviteLink(deps.config, invite.id);
  const [organization] = await deps.db
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  const emailed = await sendInviteEmail(
    deps.email,
    { to: email, organization: organization!.name, inviter: user.name, role: input.role, link },
    // The invitation's id is its link's secret: the log names the organization only.
    (error) => deps.logger.warn({ err: errorText(error), workspaceId }, 'invite email failed'),
  );
  return { invite, link, emailed };
}

/** Revokes a pending invitation of the active organization, so its link opens nothing. */
export async function cancelInvitation(deps: OrganizationsDeps, user: CurrentUser, id: string) {
  assertCan(user, { invitation: ['cancel'] });
  const [row] = await deps.db
    .update(schema.invites)
    .set({ status: 'canceled' })
    .where(
      and(
        eq(schema.invites.id, id),
        eq(schema.invites.workspaceId, user.workspaceId),
        eq(schema.invites.status, 'pending'),
      ),
    )
    .returning();
  if (!row) throw notFound('Invite not found');
  await audit(
    deps.db,
    user.workspaceId,
    user,
    'invitation.cancel',
    { type: 'invite', id },
    {
      email: row.email,
    },
  );
}

/**
 * An invitation as its recipient sees it: pending, unexpired and for their
 * address, or not found. Nobody else learns anything from an id.
 */
export async function invitationFor(db: Db, account: Pick<Account, 'email'>, id: string) {
  // Before the caller is in its organization: the directory's to say (db/scope.ts).
  const [row] = await asDirectory(() =>
    db
      .select({
        invite: schema.invites,
        organization: schema.workspaces.name,
        inviter: schema.users.name,
      })
      .from(schema.invites)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.invites.workspaceId))
      .leftJoin(schema.users, eq(schema.users.id, schema.invites.inviterId))
      .where(and(eq(schema.invites.id, id), pending())),
  );
  if (!row || row.invite.email.toLowerCase() !== account.email.toLowerCase()) {
    throw notFound('This invite is used, expired, revoked, or for another email address');
  }
  return row;
}

/**
 * Accepts an invitation for the caller: they join with its role (once:
 * the plugin spends it with a conditional update), and it becomes the
 * session's active organization.
 */
export async function acceptInvitation(
  deps: OrganizationsDeps,
  account: Account,
  headers: Headers,
  id: string,
) {
  assertSession(account);
  const { invite } = await invitationFor(deps.db, account, id);
  // The rest in the invitation's organization.
  return inWorkspace(invite.workspaceId, () => accept(deps, account, headers, invite));
}

async function accept(
  deps: OrganizationsDeps,
  account: Account,
  headers: Headers,
  invite: typeof schema.invites.$inferSelect,
) {
  const { id } = invite;
  const [already] = await deps.db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, invite.workspaceId),
        eq(schema.workspaceMembers.userId, account.id),
      ),
    );
  if (already) {
    // A member already: the invitation is spent, and nothing else changes.
    await deps.db
      .update(schema.invites)
      .set({ status: 'accepted' })
      .where(and(eq(schema.invites.id, id), eq(schema.invites.status, 'pending')));
  } else {
    await api(deps).acceptInvitation({ body: { invitationId: id }, headers });
  }
  await api(deps).setActiveOrganization({ body: { organizationId: invite.workspaceId }, headers });
  await audit(
    deps.db,
    invite.workspaceId,
    account,
    'invitation.accept',
    {
      type: 'invite',
      id,
    },
    { role: invite.role },
  );
  return invite.workspaceId;
}
