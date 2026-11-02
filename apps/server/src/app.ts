import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { APIError } from 'better-auth/api';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { CLIENT_IP_HEADER, clientIp } from './client-ip.js';
import type { AppDeps, AppEnv } from './context.js';
import { DomainError, problem, zodProblem, type Problem } from './errors.js';
import { TOKEN_PREFIX } from './hooks/verify.js';
import { httpMetrics } from './metrics.js';
import { apiKeyFrom } from './middleware/auth.js';
import { OPENAPI_PATH, openApiDocument } from './openapi.js';
import { mountRoutes } from './routes/index.js';
import { LOCAL_SESSION_PATH } from './routes/local.js';

/** `apps/web/dist`, from both `src/` and `dist/`. Leaf 0.5 builds it. */
export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface AppOptions {
  /** The built web app to serve with SPA fallback, when the directory exists. */
  webDist?: string;
}

export function createApp(deps: AppDeps, { webDist = WEB_DIST }: AppOptions = {}) {
  const { auth, config, logger } = deps;
  const origin = new URL(config.publicUrl).origin;
  const app = new OpenAPIHono<AppEnv>();

  app.use(securityHeaders(config.publicUrl));
  app.use(requestId());
  app.use(async (c, next) => {
    c.set('deps', deps);
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId: c.var.requestId,
        method: c.req.method,
        path: (deps.extensions?.redactPath ?? ((p: string) => p))(redactPath(c.req.path)),
        status: c.res.status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      },
      'request',
    );
  });
  app.use(httpMetrics);
  // No CORS for the Mac app's local sign-in (routes/local.ts): no page may read it.
  const apiCors = cors({ origin, credentials: true, maxAge: 600 });
  app.use('/api/*', (c, next) => (c.req.path === LOCAL_SESSION_PATH ? next() : apiCors(c, next)));
  app.use('/api/*', async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && crossOriginWithCookie(c.req.raw.headers, origin)) {
      throw new DomainError(403, 'ORIGIN_NOT_ALLOWED', `This request must come from ${origin}`);
    }
    await next();
  });

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(withClientIp(c)));
  mountRoutes(app);
  // The managed build's routes (plan 21.5), before the SPA fallback.
  deps.extensions?.routes?.(app);
  app.get(OPENAPI_PATH, (c) => c.json(openApiDocument(app)));

  const index = webDist && join(webDist, 'index.html');
  if (index && existsSync(index)) {
    const html = readFileSync(index, 'utf8');
    app.use('*', serveStatic({ root: webDist }));
    app.get('*', (c, next) => (isServerPath(c.req.path) ? next() : c.html(html)));
  }

  app.notFound((c) => c.json(problem(404, 'Not found', { code: 'NOT_FOUND' }), 404, problemType));

  app.onError((error, c) => {
    const body = toProblem(error);
    if (body.status >= 500) {
      logger.error({ err: error, requestId: c.var.requestId }, 'unhandled error');
    }
    return c.json(body, body.status as ContentfulStatusCode, problemType);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

const problemType = { 'content-type': 'application/problem+json' };

/**
 * Headers on every response (plan 17 control 8, S-19). A route that sets one
 * of them keeps its own: files and artifacts send a stricter CSP.
 */
function securityHeaders(publicUrl: string): MiddlewareHandler {
  const url = new URL(publicUrl);
  const socketOrigin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  const headers: Record<string, string> = {
    // The SPA: its own scripts only; inline styles for xterm.js and noVNC;
    // avatars and Markdown images from anywhere; blob: for previews (PDFs in
    // an iframe); the API and the realtime, terminal and screen sockets.
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' ${socketOrigin}`,
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...(url.protocol === 'https:' && { 'strict-transport-security': 'max-age=31536000' }),
  };
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A browser request riding the session cookie from another origin (S-19).
 * `SameSite=Lax` lets a sibling subdomain through, so the Origin must be ours;
 * without one, `Sec-Fetch-Site` decides. API keys are not ambient, so bearer
 * requests (scripts, the desktop app) are not checked.
 */
function crossOriginWithCookie(headers: Headers, origin: string): boolean {
  if (apiKeyFrom(headers) || !headers.get('cookie')) return false;
  const sent = headers.get('origin');
  if (sent) return sent !== origin;
  const site = headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

/** The request for better-auth, with the client address it rate-limits on (S-6). */
function withClientIp(c: Context<AppEnv>): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = clientIp(c);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(c.req.raw, { headers });
}

/** Webhook path tokens (`/hooks/{bot}/whk_…`) stay out of the request log (S-13). */
export function redactPath(path: string): string {
  return path.replace(new RegExp(`/${TOKEN_PREFIX}[^/]*`, 'g'), `/${TOKEN_PREFIX}[redacted]`);
}

/** Paths the SPA fallback must never answer. */
function isServerPath(path: string): boolean {
  return /^\/(api|hooks|ws)(\/|$)|^\/(healthz|readyz|metrics)$/.test(path);
}

function toProblem(error: unknown): Problem {
  if (error instanceof ZodError) return zodProblem(error);
  if (error instanceof DomainError) {
    return problem(error.status, error.message, { code: error.code });
  }
  if (error instanceof APIError) {
    const body = error.body as { code?: string; message?: string } | undefined;
    return problem(error.statusCode, body?.message ?? error.message, { code: body?.code });
  }
  if (error instanceof HTTPException) return problem(error.status, error.message || 'Error');
  return problem(500, 'Internal server error', { code: 'INTERNAL' });
}
