import { createRoute, z } from '@hono/zod-openapi';
import {
  requireAccount,
  requireAdmin,
  requireManaged,
  requireUser,
} from '@openbots/server/middleware/auth';
import {
  adminProblems,
  authenticated,
  authProblems,
  createRouter,
  problemResponse,
} from '@openbots/server/openapi';
import { listAudit, type AuditListing } from '@openbots/server/services/audit';
import { getOrganization } from '@openbots/server/workspace';
import type { Context } from 'hono';
import type { AppEnv } from '@openbots/server/context';
import { setCookie } from 'hono/cookie';
import { and, eq, gt } from 'drizzle-orm';
import { schema } from '@openbots/server/db/client';
import { notFound } from '@openbots/server/errors';
import type { EmailOptions } from './email.js';
import { INVITE_COOKIE, INVITE_COOKIE_SECONDS, signInviteCookie } from './plugin.js';
import {
  acceptInvitation,
  activateOrganization,
  cancelInvitation,
  createInvitation,
  createOrganization,
  invitationFor,
  inviteLink,
  leaveOrganization,
  listInvitations,
  listMembers,
  listMyOrganizations,
  removeMember,
  renameOrganization,
  updateMember,
  type MemberView,
  type OrganizationsDeps,
} from './organizations.js';
import { asDirectory } from '@openbots/server/db/scope';

// The managed service's organization routes (plan 21.5), under /api/v1:
//
// - /organizations: the caller's organizations, create one, switch to one.
// - /organization: the active one, its members, invitations and audit log,
//   for its owners and admins; leaving it, for anyone in it.
// - /invitations/{id}: an invitation as its recipient sees it, and accepting it;
//   /invitations/{id}/oauth, before a GitHub or Google sign-up from its link.
//
// Creating, switching and accepting need a session (they change it); the
// rest also take an API key, which works in the organization it was made in.

const RoleSchema = z.enum(['owner', 'admin', 'member']).openapi('OrganizationRole');
const name = z.string().trim().min(1).max(80);

const OrganizationSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    role: RoleSchema,
    suspended: z.boolean(),
    active: z.boolean().openapi({ description: 'The organization this request works in' }),
  })
  .openapi('Organization');

const MemberSchema = z
  .object({
    id: z.uuid().openapi({ description: 'The user id' }),
    name: z.string(),
    email: z.string(),
    role: RoleSchema,
    createdAt: z.iso.datetime().openapi({ description: 'When they joined' }),
    suspendedAt: z.iso.datetime().nullable(),
  })
  .openapi('OrganizationMember');

const InvitationSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: RoleSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    invitedBy: z.string().nullable().openapi({ description: 'The email of who sent it' }),
    link: z.string().openapi({ description: 'The link that accepts it' }),
  })
  .openapi('OrganizationInvitation');

const ReceivedInvitationSchema = z
  .object({
    id: z.uuid(),
    organization: z.string(),
    role: RoleSchema,
    invitedBy: z.string().nullable(),
    expiresAt: z.iso.datetime(),
  })
  .openapi('ReceivedInvitation');

const AuditEntrySchema = z
  .object({
    id: z.uuid(),
    actorType: z.enum(['user', 'bot', 'system']),
    actorId: z.uuid().nullable(),
    actorLabel: z
      .string()
      .nullable()
      .openapi({ description: "The user's email or the Bot's name, while they exist" }),
    action: z.string().openapi({ example: 'auth.sign_in' }),
    targetType: z.string().nullable(),
    targetId: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .openapi('AuditEntry');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});

const iso = (date: Date) => date.toISOString();

const toMember = (m: MemberView) => ({
  id: m.id,
  name: m.name,
  email: m.email,
  role: m.role,
  createdAt: iso(m.createdAt),
  suspendedAt: m.suspendedAt ? iso(m.suspendedAt) : null,
});

const toEntry = (row: AuditListing['items'][number]) => ({
  id: row.id,
  actorType: row.actorType as 'user' | 'bot' | 'system',
  actorId: row.actorId,
  actorLabel: row.actorLabel,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  metadata: row.metadata as Record<string, unknown>,
  createdAt: iso(row.createdAt),
});

export function organizationRoutes(email: EmailOptions) {
  const deps = (c: Context<AppEnv>): OrganizationsDeps => ({ ...c.var.deps, email });
  const id = z.object({ id: z.uuid() });

  return createRouter()
    .openapi(
      createRoute({
        method: 'get',
        path: '/organizations',
        tags: ['organizations'],
        summary: "The caller's organizations",
        middleware: [requireManaged, requireAccount] as const,
        security: authenticated,
        responses: {
          200: json(z.object({ items: z.array(OrganizationSchema) }), 'Oldest membership first'),
          ...authProblems,
        },
      }),
      async (c) => c.json({ items: await listMyOrganizations(c.var.deps.db, c.var.account) }, 200),
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/organizations',
        tags: ['organizations'],
        summary: 'Create an organization, with the caller as its owner, and switch to it',
        middleware: [requireManaged, requireAccount] as const,
        security: authenticated,
        request: body(z.strictObject({ name }).openapi('CreateOrganization')),
        responses: {
          201: json(OrganizationSchema, 'The new organization, now the active one'),
          400: problemResponse('Invalid name'),
          403: problemResponse('An API key; this needs a session'),
          409: problemResponse('The caller belongs to as many organizations as one may'),
          429: problemResponse('Too many at once'),
          ...authProblems,
        },
      }),
      async (c) => {
        const created = await createOrganization(
          deps(c),
          c.var.account,
          c.req.raw.headers,
          c.req.valid('json').name,
        );
        return c.json({ ...created, role: 'owner' as const, suspended: false, active: true }, 201);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/organizations/{id}/activate',
        tags: ['organizations'],
        summary: 'Work in another of the caller’s organizations',
        middleware: [requireManaged, requireAccount] as const,
        security: authenticated,
        request: { params: id },
        responses: {
          204: { description: 'The session works there now' },
          403: problemResponse('Suspended there, or an API key'),
          404: problemResponse('Not one of the caller’s organizations'),
          ...authProblems,
        },
      }),
      async (c) => {
        await activateOrganization(
          deps(c),
          c.var.account,
          c.req.raw.headers,
          c.req.valid('param').id,
        );
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/organization',
        tags: ['organizations'],
        summary: 'The active organization',
        middleware: [requireManaged, requireUser] as const,
        security: authenticated,
        responses: {
          200: json(
            z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: RoleSchema }),
            'The organization and the caller’s role there',
          ),
          ...authProblems,
        },
      }),
      async (c) => {
        const org = await getOrganization(c.var.deps.db, c.var.user.workspaceId);
        return c.json({ id: org.id, name: org.name, slug: org.slug, role: c.var.user.role }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'patch',
        path: '/organization',
        tags: ['organizations'],
        summary: 'Rename the active organization',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: body(z.strictObject({ name }).openapi('UpdateOrganization')),
        responses: {
          200: json(z.object({ id: z.uuid(), name: z.string() }), 'The organization'),
          400: problemResponse('Invalid name'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const row = await renameOrganization(deps(c), c.var.user, c.req.valid('json').name);
        return c.json({ id: row.id, name: row.name }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/organization/leave',
        tags: ['organizations'],
        summary: 'Leave the active organization',
        description: 'The last owner cannot leave (409 LAST_OWNER). What they had there stays.',
        middleware: [requireManaged, requireUser] as const,
        security: authenticated,
        responses: {
          204: { description: 'Left' },
          409: problemResponse('The last owner'),
          ...authProblems,
        },
      }),
      async (c) => {
        await leaveOrganization(deps(c), c.var.user);
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/organization/members',
        tags: ['organizations'],
        summary: 'The active organization’s members',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        responses: {
          200: json(z.object({ items: z.array(MemberSchema) }), 'Oldest first'),
          ...adminProblems,
        },
      }),
      async (c) =>
        c.json(
          {
            items: (await listMembers(c.var.deps.db, c.var.user.workspaceId)).map(toMember),
          },
          200,
        ),
    )
    .openapi(
      createRoute({
        method: 'patch',
        path: '/organization/members/{id}',
        tags: ['organizations'],
        summary: "Change a member's role, or suspend or restore them",
        description:
          'Only an owner changes an owner. The organization keeps an owner who is not suspended (409 LAST_OWNER), and nobody suspends themselves (409 CANNOT_SUSPEND_SELF).',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: {
          params: id,
          ...body(
            z
              .strictObject({ role: RoleSchema.optional(), suspended: z.boolean().optional() })
              .openapi('UpdateOrganizationMember'),
          ),
        },
        responses: {
          200: json(MemberSchema, 'The member'),
          404: problemResponse('No such member'),
          409: problemResponse('The last owner, or the caller themselves'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const member = await updateMember(
          deps(c),
          c.var.user,
          c.req.valid('param').id,
          c.req.valid('json'),
        );
        return c.json(toMember(member), 200);
      },
    )
    .openapi(
      createRoute({
        method: 'delete',
        path: '/organization/members/{id}',
        tags: ['organizations'],
        summary: 'Remove a member',
        description: 'Their access ends; what they had there stays, out of everyone’s reach.',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: { params: id },
        responses: {
          204: { description: 'Removed' },
          404: problemResponse('No such member'),
          409: problemResponse('The last owner, or the caller themselves'),
          ...adminProblems,
        },
      }),
      async (c) => {
        await removeMember(deps(c), c.var.user, c.req.valid('param').id);
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/organization/invitations',
        tags: ['organizations'],
        summary: 'Pending invitations',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        responses: {
          200: json(z.object({ items: z.array(InvitationSchema) }), 'Newest first'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const rows = await listInvitations(c.var.deps.db, c.var.user.workspaceId);
        return c.json(
          {
            items: rows.map(({ invite, inviterEmail }) => ({
              id: invite.id,
              email: invite.email,
              role: invite.role as z.infer<typeof RoleSchema>,
              createdAt: iso(invite.createdAt),
              expiresAt: iso(invite.expiresAt),
              invitedBy: inviterEmail,
              link: inviteLink(c.var.deps.config, invite.id),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/organization/invitations',
        tags: ['organizations'],
        summary: 'Invite someone by email',
        description:
          'Emails the link when the server can send email (`emailed`); the link works either way, for 7 days, for that address only. Only an owner invites an owner.',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: body(
          z
            .strictObject({ email: z.email(), role: RoleSchema.default('member') })
            .openapi('CreateOrganizationInvitation'),
        ),
        responses: {
          201: json(
            InvitationSchema.extend({ emailed: z.boolean() }).openapi('CreatedInvitation'),
            'The invitation',
          ),
          400: problemResponse('Invalid email'),
          409: problemResponse('A member already, or too many pending'),
          429: problemResponse('Too many invitations this hour'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const { invite, link, emailed } = await createInvitation(
          deps(c),
          c.var.user,
          c.req.valid('json'),
        );
        return c.json(
          {
            id: invite.id,
            email: invite.email,
            role: invite.role as z.infer<typeof RoleSchema>,
            createdAt: iso(invite.createdAt),
            expiresAt: iso(invite.expiresAt),
            invitedBy: c.var.user.email,
            link,
            emailed,
          },
          201,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'delete',
        path: '/organization/invitations/{id}',
        tags: ['organizations'],
        summary: 'Revoke a pending invitation',
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: { params: id },
        responses: {
          204: { description: 'Revoked: its link opens nothing' },
          404: problemResponse('No such pending invitation'),
          ...adminProblems,
        },
      }),
      async (c) => {
        await cancelInvitation(deps(c), c.var.user, c.req.valid('param').id);
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/organization/audit',
        tags: ['organizations'],
        summary: "Read the active organization's audit log",
        middleware: [requireManaged, requireAdmin] as const,
        security: authenticated,
        request: {
          query: z.object({
            actorId: z.uuid().optional(),
            action: z.string().max(100).optional().openapi({
              description: 'An action (`auth.sign_in`), or a group ending in `.` (`auth.`)',
            }),
            from: z.iso.datetime().optional().openapi({ description: 'At or after' }),
            to: z.iso.datetime().optional().openapi({ description: 'At or before' }),
            cursor: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          }),
        },
        responses: {
          200: json(
            z
              .object({ items: z.array(AuditEntrySchema), nextCursor: z.uuid().nullable() })
              .openapi('AuditPage'),
            'Entries, newest first',
          ),
          400: problemResponse('Invalid filters'),
          ...adminProblems,
        },
      }),
      async (c) => {
        const { actorId, action, from, to, cursor, limit } = c.req.valid('query');
        const page = await listAudit(c.var.deps.db, c.var.user.workspaceId, {
          ...(actorId ? { actorId } : {}),
          ...(action ? { action } : {}),
          ...(from ? { from: new Date(from) } : {}),
          ...(to ? { to: new Date(to) } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        });
        return c.json({ items: page.items.map(toEntry), nextCursor: page.nextCursor }, 200);
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/invitations/{id}',
        tags: ['organizations'],
        summary: 'An invitation, for the address it was sent to',
        middleware: [requireManaged, requireAccount] as const,
        security: authenticated,
        request: { params: id },
        responses: {
          200: json(ReceivedInvitationSchema, 'The invitation'),
          404: problemResponse('Used, expired, revoked, or for another address'),
          ...authProblems,
        },
      }),
      async (c) => {
        const { invite, organization, inviter } = await invitationFor(
          c.var.deps.db,
          c.var.account,
          c.req.valid('param').id,
        );
        return c.json(
          {
            id: invite.id,
            organization,
            role: invite.role as z.infer<typeof RoleSchema>,
            invitedBy: inviter,
            expiresAt: iso(invite.expiresAt),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/invitations/{id}/oauth',
        tags: ['organizations'],
        summary: 'Carry an invite through a GitHub or Google sign-up',
        description:
          'Sets a signed, HttpOnly cookie for 10 minutes. The account the provider then creates joins the invitation when its verified address is the invited one. The invite stays out of the OAuth state.',
        middleware: [requireManaged] as const,
        request: { params: id },
        responses: {
          204: { description: 'The cookie is set' },
          404: problemResponse('No such pending invitation'),
        },
      }),
      async (c) => {
        const { db, config } = c.var.deps;
        const invite = c.req.valid('param').id;
        // No account or organization yet: the directory's to say (db/scope.ts).
        const [row] = await asDirectory(() =>
          db
            .select({ id: schema.invites.id })
            .from(schema.invites)
            .where(
              and(
                eq(schema.invites.id, invite),
                eq(schema.invites.status, 'pending'),
                gt(schema.invites.expiresAt, new Date()),
              ),
            ),
        );
        if (!row) throw notFound('No such invitation');
        setCookie(c, INVITE_COOKIE, signInviteCookie(config, invite), {
          httpOnly: true,
          sameSite: 'Lax',
          secure: config.publicUrl.startsWith('https://'),
          path: '/',
          maxAge: INVITE_COOKIE_SECONDS,
        });
        return c.body(null, 204);
      },
    )
    .openapi(
      createRoute({
        method: 'post',
        path: '/invitations/{id}/accept',
        tags: ['organizations'],
        summary: 'Accept an invitation and switch to its organization',
        middleware: [requireManaged, requireAccount] as const,
        security: authenticated,
        request: { params: id },
        responses: {
          200: json(z.object({ organizationId: z.uuid() }), 'Joined'),
          403: problemResponse('An API key; this needs a session'),
          404: problemResponse('Used, expired, revoked, or for another address'),
          ...authProblems,
        },
      }),
      async (c) => {
        const organizationId = await acceptInvitation(
          deps(c),
          c.var.account,
          c.req.raw.headers,
          c.req.valid('param').id,
        );
        return c.json({ organizationId }, 200);
      },
    );
}
