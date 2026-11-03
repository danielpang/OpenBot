import { createHash, timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CLIENT_IP_HEADER, clientIp, rateLimitKey } from '../client-ip.js';
import { DomainError, notFound } from '../errors.js';
import { createRouter, problemResponse } from '../openapi.js';

// The Mac app's sign-in for the stack it runs on This Mac (OPENBOTS_LOCAL_TOKEN).
// The app's main process holds the token and calls this before it loads the
// web app, and again whenever the window lands on /sign-in: the owner never
// sees a sign-in, sign-up or sign-out. The answer is an ordinary better-auth
// session cookie for the owner, who is created on the first call (auth.ts).
//
// Only the app's main process may call it. The token comes in a header, never
// the query string; the route sends no CORS headers (app.ts skips it), and a
// request with an Origin or Sec-Fetch-Site header, which every browser sends
// and Node's fetch does not, is refused before the token is looked at, so no
// web page can get the cookie set or read the answer. Without a token
// configured the route does not exist.

export const LOCAL_SESSION_PATH = '/api/v1/local/session';
export const LOCAL_TOKEN_HEADER = 'x-openbots-local-token';

/** The name an owner gets when the app sends none. */
export const DEFAULT_OWNER_NAME = 'Me';

/** Like better-auth's own sign-in rule: 3 per 10 seconds per address. */
const RATE_LIMIT = { window: 10, max: 3 };

const LocalSessionBody = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional().openapi({
      description: 'The owner’s name, used only when this call creates the owner',
    }),
  })
  .openapi('LocalSessionRequest');

const LocalSessionSchema = z
  .object({ user: z.object({ id: z.string(), name: z.string() }) })
  .openapi('LocalSession');

/** Compares the two in constant time, whatever their lengths. */
export function sameToken(sent: string | undefined, expected: string): boolean {
  if (sent == null) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(sent), digest(expected));
}

export const localRoutes = createRouter().openapi(
  createRoute({
    method: 'post',
    path: '/local/session',
    tags: ['auth'],
    summary: 'Sign in the owner of the Mac app’s local stack (its main process only)',
    description:
      'Needs OPENBOTS_LOCAL_TOKEN in the `x-openbots-local-token` header. Creates the owner when there is none, then sets an ordinary session cookie. Browsers are refused.',
    request: {
      headers: z.object({ [LOCAL_TOKEN_HEADER]: z.string().optional() }),
      body: { required: false, content: { 'application/json': { schema: LocalSessionBody } } },
    },
    responses: {
      200: {
        description: 'The owner, with the session cookie set',
        content: { 'application/json': { schema: LocalSessionSchema } },
      },
      401: problemResponse('The local token is missing or wrong'),
      403: problemResponse('The request came from a browser'),
      404: problemResponse('This install has no local token'),
      429: problemResponse('Too many attempts'),
    },
  }),
  async (c) => {
    const { config, auth, infra } = c.var.deps;
    if (!config.localToken) throw notFound();
    if (c.req.header('origin') != null || c.req.header('sec-fetch-site') != null) {
      throw new DomainError(403, 'ORIGIN_NOT_ALLOWED', 'Only the OpenBots Mac app signs in here');
    }
    const ip = clientIp(c);
    const limit = await infra.limiter.consume(
      `local-session:${rateLimitKey(c) ?? 'unknown'}`,
      RATE_LIMIT,
    );
    if (!limit.allowed) {
      c.header('retry-after', String(limit.retryAfter ?? RATE_LIMIT.window));
      throw new DomainError(429, 'RATE_LIMITED', 'Too many attempts; retry in a few seconds');
    }
    if (!sameToken(c.req.header(LOCAL_TOKEN_HEADER), config.localToken)) {
      throw new DomainError(401, 'LOCAL_TOKEN_INVALID', 'The local token is wrong');
    }
    const body = (c.req.valid('json') as z.infer<typeof LocalSessionBody> | undefined) ?? {};
    const headers = new Headers();
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    const userAgent = c.req.header('user-agent');
    if (userAgent) headers.set('user-agent', userAgent);
    const res = await auth.api.createLocalSession({
      body: { name: body.name ?? DEFAULT_OWNER_NAME },
      headers,
      asResponse: true,
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new DomainError(
        res.status as ContentfulStatusCode,
        problem.code ?? 'LOCAL_SESSION_FAILED',
        problem.message ?? 'The owner could not be signed in',
      );
    }
    const { user } = (await res.json()) as { user: { id: string; name: string } };
    for (const cookie of res.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true });
    }
    return c.json({ user: { id: user.id, name: user.name } }, 200);
  },
);
