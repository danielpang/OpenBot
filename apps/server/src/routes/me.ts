import { createRoute, z } from '@hono/zod-openapi';
import { currentUserOf, requireAccount } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter } from '../openapi.js';
import { getOrganization, organizationSettings } from '../workspace.js';
import { LimitsSchema, RoleSchema } from '../schemas.js';

// The caller. On the managed service someone may be signed in with no
// organization yet (they have not made one) or in one where they are
// suspended: `workspace` is then null, or says `suspended`, and the web app
// shows its onboarding or organization picker (plan 21.5). A self-hosted
// install always answers with the implicit organization, for its owner only.

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

export const meRoutes = createRouter().openapi(
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
