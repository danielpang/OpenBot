import { createRoute, z } from '@hono/zod-openapi';
import { renderPng } from '@openbots/avatars/png';
import { AvatarSchema } from '@openbots/shared';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import { getBot } from '../services/bots.js';

// Static avatar PNGs for notifications (I1, plan 13): the
// resting pose only; motion lives in the web component.

export const avatarRoutes = createRouter().openapi(
  createRoute({
    method: 'get',
    path: '/bots/{id}/avatar.png',
    tags: ['bots'],
    summary: "The Bot's avatar as a PNG",
    description: 'Generated avatars render at `size` px; an uploaded avatar redirects to its file.',
    middleware: [requireUser] as const,
    security: authenticated,
    request: {
      params: z.object({ id: z.uuid() }),
      query: z.object({ size: z.coerce.number().int().min(16).max(512).default(128) }),
    },
    responses: {
      200: {
        description: 'A square PNG',
        content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } },
      },
      302: { description: 'An uploaded avatar: redirects to `GET /api/v1/files/{id}`' },
      400: problemResponse('Invalid size'),
      404: problemResponse('No such Bot'),
      ...authProblems,
    },
  }),
  async (c) => {
    const { bot } = await getBot(c.var.deps.db, c.var.user, c.req.valid('param').id);
    const parsed = AvatarSchema.safeParse(bot.avatar);
    // Same fallback as the Bot object: an unset avatar is generated from the id.
    const avatar = parsed.success ? parsed.data : { kind: 'generated' as const, seed: bot.id };
    if (avatar.kind === 'upload') return c.redirect(`/api/v1/files/${avatar.file_id}`, 302);
    const png = renderPng(avatar, c.req.valid('query').size);
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=60',
    });
  },
);
