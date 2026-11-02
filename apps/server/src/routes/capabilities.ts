import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../openapi.js';
import { computerAvailable } from '../services/computer.js';

// What this install has turned on, for clients deciding what to show before
// sign-in (GitHub and Google buttons, U1), whether there is a computer
// (Phase 4), and what kind of install it is: self-hosted has one owner and no
// admin screens; managed has organizations, which the managed build adds. `auth` says
// whether the Mac app signs the owner in itself (routes/local.ts). Public: it
// names no secrets.

const CapabilitiesSchema = z
  .object({
    oauth: z.object({ github: z.boolean(), google: z.boolean() }),
    // Optional for the same reason; always sent.
    computer: z.boolean().optional().openapi({
      description: 'A computer provider (Docker or a remote agent) is configured',
    }),
    deployment: z.enum(['self_hosted', 'managed']).openapi({
      description:
        '`self_hosted`: one account, its owner, with sign-up closed once it exists and no members, invites or audit log. `managed`: the hosted service, with admins and members.',
    }),
    // Optional, like `computer`: older servers do not send it. Always sent.
    customStdio: z.boolean().optional().openapi({
      description:
        'Admins may turn on custom command (stdio) connectors (OPENBOTS_CUSTOM_STDIO; off by default on the managed service)',
    }),
    localEndpoints: z.boolean().optional().openapi({
      description:
        'Admins may mark endpoints as on their own network (OPENBOTS_LOCAL_ENDPOINTS; off by default on the managed service)',
    }),
    auth: z.enum(['password', 'local']).optional().openapi({
      description:
        '`local`: the Mac app on This Mac signs its owner in itself (OPENBOTS_LOCAL_TOKEN), so there is no sign-in, sign-up or sign-out. `password`: the usual sign-in.',
    }),
  })
  .openapi('Capabilities');

export const capabilityRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/capabilities',
    tags: ['auth'],
    summary: 'Sign-in providers and features this install has enabled',
    responses: {
      200: {
        description: 'Enabled capabilities',
        content: { 'application/json': { schema: CapabilitiesSchema } },
      },
    },
  }),
  (c) => {
    const { oauth, deployment, localToken, customStdio, localEndpoints } = c.var.deps.config;
    return c.json(
      {
        oauth: { github: !!oauth.github, google: !!oauth.google },
        computer: computerAvailable(c.var.deps),
        deployment,
        customStdio,
        localEndpoints,
        auth: localToken ? ('local' as const) : ('password' as const),
      },
      200,
    );
  },
);
