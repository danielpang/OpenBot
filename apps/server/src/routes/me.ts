import { createRoute, z } from '@hono/zod-openapi';
import { LOCAL_ONLY_MESSAGE } from '../auth.js';
import { DomainError } from '../errors.js';
import { currentUserOf, requireAccount, requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { recordAudit, userActor } from '../services/audit.js';
import { getOrganization, organizationSettings } from '../workspace.js';
import { LimitsSchema, RoleSchema } from '../schemas.js';

// The caller. On the managed service someone may be signed in with no
// organization yet (they have not made one) or in one where they are
// suspended: `workspace` is then null, or says `suspended`, and the web app
// shows its onboarding or organization picker (plan 21.5). A self-hosted
// install always answers with the implicit organization, for its owner only.
//
// `POST /me/credentials` gives an owner made by pairing a phone (headless
// first run, MOBILE_AND_VM_PLAN.md 8.3 step 5), who has the placeholder email
// and no password, an email and a password for the web app. A device key may
// call it: the phone is how such an owner gets in. It works once (409
// CREDENTIALS_SET after), 5 times an hour per account at most, and is audited.

/** Per account: 5 tries an hour. */
export const CREDENTIALS_LIMIT = { window: 3600, max: 5 };

const CredentialsSchema = z
  .strictObject({
    email: z.email().max(254),
    password: z.string().min(1).max(1024).openapi({
      description: "At least 8 characters (better-auth's rule)",
    }),
  })
  .openapi('SetCredentials');

export const MeSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      email: z.string(),
      name: z.string(),
      image: z.string().nullable(),
      emailVerified: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
    // Copies of the named schemas: `.nullable()` on them would make the components nullable too.
    role: z.enum(RoleSchema.options).nullable().openapi({
      description: 'Their role in the active organization; null without one',
    }),
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string(),
        suspended: z.boolean().openapi({
          description: 'They are suspended here: every other route refuses them in it',
        }),
      })
      .nullable()
      .openapi({ description: 'The active organization; null when they have none' }),
    limits: z.object(LimitsSchema.shape).nullable().openapi({
      description: "The active organization's limits; null without one",
    }),
  })
  .openapi('Me');

export const meRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/me/credentials',
      tags: ['auth'],
      summary: 'Set an email and a password for the web app (an owner made by pairing, once)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        body: { required: true, content: { 'application/json': { schema: CredentialsSchema } } },
      },
      responses: {
        204: { description: 'Set: sign in on the web with them' },
        400: problemResponse('Invalid email or password'),
        403: problemResponse('A server that signs in from the Mac app only (LOCAL_ONLY)'),
        409: problemResponse(
          'The account has credentials already (CREDENTIALS_SET), or EMAIL_TAKEN',
        ),
        429: problemResponse('Too many tries'),
        ...authProblems,
      },
    }),
    async (c) => {
      const { auth, config, db, infra } = c.var.deps;
      const user = c.var.user;
      if (config.localToken) throw new DomainError(403, 'LOCAL_ONLY', LOCAL_ONLY_MESSAGE);
      const limit = await infra.limiter.consume(`me-credentials:${user.id}`, CREDENTIALS_LIMIT);
      if (!limit.allowed) {
        c.header('retry-after', String(limit.retryAfter ?? CREDENTIALS_LIMIT.window));
        throw new DomainError(429, 'RATE_LIMITED', 'Too many tries; try again later');
      }
      const { email, password } = c.req.valid('json');
      const set = await auth.api.setOwnerCredentials({
        body: { userId: user.id, email, password },
      });
      await recordAudit(db, {
        workspaceId: user.workspaceId,
        actor: userActor(user),
        action: 'auth.credentials_set',
        targetType: 'user',
        targetId: user.id,
        metadata: { email: set.user.email, via: user.via },
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: ['auth'],
      summary: 'The signed-in user, the active organization, their role there, and its limits',
      middleware: [requireAccount] as const,
      security: authenticated,
      responses: {
        200: { description: 'The caller', content: { 'application/json': { schema: MeSchema } } },
        ...authProblems,
      },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      const account = c.var.account;
      // A self-hosted install lets only its owner in, here too.
      if (config.deployment === 'self_hosted') currentUserOf(c.var.deps, account);
      const membership = account.membership;
      const workspace = membership ? await getOrganization(db, membership.workspaceId) : null;
      const settings = membership
        ? await organizationSettings(c.var.deps, membership.workspaceId)
        : null;
      return c.json(
        {
          user: {
            id: account.id,
            email: account.email,
            name: account.name,
            image: account.image,
            emailVerified: account.emailVerified,
            createdAt: account.createdAt.toISOString(),
          },
          role: membership?.role ?? null,
          workspace:
            workspace && membership
              ? { id: workspace.id, name: workspace.name, suspended: membership.suspended }
              : null,
          limits: settings?.limits ?? null,
        },
        200,
      );
    },
  );
