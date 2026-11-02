import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ExtensionContext } from '@openbots/server';
import type { Config } from '@openbots/server/config';
import { schema } from '@openbots/server/db/client';
import { parseMasterKey } from '@openbots/server/secrets';
import { recordAudit } from '@openbots/server/services/audit';
import { ac, roles } from './access.js';
import { invitationProof, UUID } from './invitations.js';
import { signUpAllowed, inviteRequired } from './sign-up.js';
import { asDirectory, inWorkspace } from '@openbots/server/db/scope';

// better-auth on the managed service (plan 21.5): the organization plugin,
// mapped onto the core's tables, and the policy the core leaves to this
// build.
//
// The plugin's models are the core's: `organization` is `workspaces`,
// `member` is `workspace_members` (with the core's `suspended_at` as the
// `suspendedAt` field) and `invitation` is `invites`, so the core and the
// plugin read the same rows and the core keeps scoping everything by
// `workspace_id`. Its HTTP endpoints (`/api/auth/organization/*`) are not
// served: routes.ts calls the ones it needs through `auth.api`, with the
// checks they need and an audit row, and does the rest itself.
//
// Sign-up (OPENBOTS_SIGNUP_MODE): `open` lets anyone sign up; `invite`
// (and `first_user_admin`, its old name) lets only the first user and
// someone who brings the invitation from their link for the address they
// sign up with: `invite` in the sign-up body (as /sign-up?invite=<id>
// sends it), or for a GitHub or Google sign-up, a short-lived signed
// cookie set when they start it from that page (`inviteCookie`), checked
// against the provider's verified address. Knowing an invited address is
// not enough.
//
// Email sign-up is sign-up.ts: the email first, confirmed with a code, then
// the name and password. better-auth's own /sign-up/email and verification
// links are not served. The core also refuses an unconfirmed account's
// requests (`requireVerifiedEmail`).
//
// A new session works in the organization its user joined last, among
// those they are not suspended in, unless it names one already.

export const INVITATION_DAYS = 7;
/** Organizations one person may belong to (the plugin counts memberships). */
export const ORGANIZATIONS_PER_USER = 10;
/** Pending invitations one organization may have. */
export const PENDING_INVITATIONS = 100;
/** Members one organization may have. */
export const MEMBERS_PER_ORGANIZATION = 500;
/** How long the invite cookie of a GitHub or Google sign-up lasts. */
export const INVITE_COOKIE_SECONDS = 600;
export const INVITE_COOKIE = 'openbots_oauth_invite';

export const pluginSchema = {
  organization: { modelName: 'workspace' },
  member: {
    modelName: 'workspaceMember',
    fields: { organizationId: 'workspaceId' },
    additionalFields: {
      suspendedAt: { type: 'date', required: false, input: false },
    },
  },
  invitation: {
    modelName: 'invite',
    fields: { organizationId: 'workspaceId' },
  },
} as const;

export function organizationPlugin() {
  return organization({
    ac,
    roles,
    creatorRole: 'owner',
    allowUserToCreateOrganization: true,
    organizationLimit: ORGANIZATIONS_PER_USER,
    membershipLimit: MEMBERS_PER_ORGANIZATION,
    invitationLimit: PENDING_INVITATIONS,
    invitationExpiresIn: INVITATION_DAYS * 86_400,
    cancelPendingInvitationsOnReInvite: true,
    // Accounts confirm their email before they can accept (routes.ts); an
    // invitation is for one address and its id is the secret.
    requireEmailVerificationOnInvitation: false,
    disableOrganizationDeletion: true,
    schema: pluginSchema,
  });
}

// --- The invite cookie of a GitHub or Google sign-up ---------------------------

function cookieKey(config: Pick<Config, 'masterKey'>) {
  return Buffer.from(
    hkdfSync('sha256', parseMasterKey(config.masterKey), '', 'openbots:oauth-invite', 32),
  );
}

/** `<invite>.<expiry ms>.<hmac>`: the invite a social sign-up started from, for 10 minutes. */
export function signInviteCookie(
  config: Pick<Config, 'masterKey'>,
  invite: string,
  now = Date.now(),
) {
  const payload = `${invite}.${now + INVITE_COOKIE_SECONDS * 1000}`;
  const mac = createHmac('sha256', cookieKey(config)).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** The invite id in a signed, unexpired cookie value, or null. */
export function readInviteCookie(
  config: Pick<Config, 'masterKey'>,
  value: string | undefined,
  now = Date.now(),
): string | null {
  const [invite, expires, mac] = (value ?? '').split('.');
  if (!invite || !expires || !mac || !UUID.test(invite)) return null;
  const expected = createHmac('sha256', cookieKey(config)).update(`${invite}.${expires}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!(Number(expires) > now)) return null;
  return invite;
}

function cookieFrom(headers: Headers | undefined, name: string): string | undefined {
  for (const part of headers?.get('cookie')?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

type HookContext =
  | {
      path?: string;
      body?: unknown;
      request?: Request;
      headers?: Headers;
    }
  | null
  | undefined;

const isOAuthCallback = (ctx: HookContext) => ctx?.path?.startsWith('/callback') ?? false;

/** The invite a sign-up proves, from its body or, for GitHub and Google, its cookie. */
function inviteOf(config: Pick<Config, 'masterKey'>, ctx: HookContext): unknown {
  if (isOAuthCallback(ctx)) {
    return readInviteCookie(
      config,
      cookieFrom(ctx?.request?.headers ?? ctx?.headers, INVITE_COOKIE),
    );
  }
  return (ctx?.body as { invite?: unknown } | undefined)?.invite;
}

/** The policy plugin: sign-up, email codes, the session's organization, and closed endpoints. */
export function managedPolicyPlugin({ config, db }: ExtensionContext): BetterAuthPlugin {
  // Accepted at account creation through a GitHub or Google sign-up, by request.
  const acceptOnCreate = new WeakMap<object, { id: string; workspaceId: string; role: string }>();

  return {
    id: 'openbots-managed',
    init: () => ({
      options: {
        emailAndPassword: { enabled: true, requireEmailVerification: true },
        databaseHooks: {
          user: {
            create: {
              before: async (user, ctx) => {
                // sign-up.ts checks the policy itself, at both ends of its flow.
                if (ctx?.path === '/sign-up/complete') return;
                const invite = inviteOf(config, ctx);
                // A GitHub or Google address the provider verified, with the
                // invite from its link, joins on creation (below).
                if (isOAuthCallback(ctx) && user.emailVerified && ctx) {
                  const proof = await invitationProof(db, user.email, invite);
                  if (proof) acceptOnCreate.set(ctx, proof);
                }
                // A provider address nobody verified proves no invite.
                const proof = isOAuthCallback(ctx) && !user.emailVerified ? null : invite;
                if (!(await signUpAllowed(config, db, user.email, proof))) throw inviteRequired();
              },
              after: async (user, ctx) => {
                const proof = ctx ? acceptOnCreate.get(ctx) : undefined;
                if (!proof || !ctx) return;
                acceptOnCreate.delete(ctx);
                // In the invitation's organization (db/scope.ts).
                await inWorkspace(proof.workspaceId, () =>
                  db.transaction(async (tx) => {
                    // Once: only a pending invitation turns accepted.
                    const [accepted] = await tx
                      .update(schema.invites)
                      .set({ status: 'accepted' })
                      .where(
                        and(eq(schema.invites.id, proof.id), eq(schema.invites.status, 'pending')),
                      )
                      .returning({ id: schema.invites.id });
                    if (!accepted) return;
                    await tx
                      .insert(schema.workspaceMembers)
                      .values({ workspaceId: proof.workspaceId, userId: user.id, role: proof.role })
                      .onConflictDoNothing();
                    await recordAudit(tx, {
                      workspaceId: proof.workspaceId,
                      actor: { type: 'user', id: user.id },
                      action: 'invitation.accept',
                      targetType: 'invite',
                      targetId: proof.id,
                      metadata: { role: proof.role, via: 'oauth' },
                    });
                  }),
                );
              },
            },
          },
          session: {
            create: {
              before: async (session) => {
                const named = (session as { activeOrganizationId?: string | null })
                  .activeOrganizationId;
                if (named) return;
                // Across organizations: the directory's to say (db/scope.ts).
                const [latest] = await asDirectory(() =>
                  db
                    .select({ workspaceId: schema.workspaceMembers.workspaceId })
                    .from(schema.workspaceMembers)
                    .where(
                      and(
                        eq(schema.workspaceMembers.userId, session.userId),
                        isNull(schema.workspaceMembers.suspendedAt),
                      ),
                    )
                    .orderBy(desc(schema.workspaceMembers.createdAt))
                    .limit(1),
                );
                if (!latest) return;
                return { data: { ...session, activeOrganizationId: latest.workspaceId } };
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path?.startsWith('/organization/') ?? false,
          // Only HTTP requests carry one; `auth.api` calls from routes.ts do not.
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request) throw new APIError('NOT_FOUND', { message: 'Not found' });
          }),
        },
        {
          // Email sign-up is sign-up.ts. better-auth's own, which makes the
          // account before the email is confirmed, and its verification
          // links are not served.
          matcher: (ctx) =>
            ['/sign-up/email', '/send-verification-email', '/verify-email'].includes(
              ctx.path ?? '',
            ),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.request) throw new APIError('NOT_FOUND', { message: 'Not found' });
          }),
        },
      ],
      after: [
        {
          // The invite cookie of a GitHub or Google sign-up is used once.
          matcher: (ctx) => ctx.path?.startsWith('/callback') ?? false,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.setCookie(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
          }),
        },
      ],
    },
  };
}
