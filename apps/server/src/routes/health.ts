import { createRoute, z } from '@hono/zod-openapi';
import { notFound, unauthorized } from '../errors.js';
import { safeEqual } from '../hooks/verify.js';
import { collectRunGauges, registry, setDiskLow } from '../metrics.js';
import { createRouter, problemResponse } from '../openapi.js';
import { databaseReady, diskState, redisReady } from '../readiness.js';

// Liveness, readiness, and Prometheus metrics (plan 16.3). Liveness and
// readiness are unauthenticated. Metrics are off unless OPENBOTS_METRICS_TOKEN
// is set, and then need it as a bearer token (threat model S-17).

const CheckSchema = z.enum(['ok', 'error']);

const ReadinessSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({ database: CheckSchema, redis: CheckSchema.optional() }),
    disk: z.literal('low').optional().openapi({
      description:
        'The data disk is nearly full (the standalone image reports it). Still ready: a full disk never takes the server out of rotation',
    }),
  })
  .openapi('Readiness');

export const healthRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/healthz',
      tags: ['health'],
      summary: 'The process is up',
      responses: {
        200: {
          description: 'Up',
          content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
        },
      },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/readyz',
      tags: ['health'],
      summary: 'The database and, when configured, Redis are reachable',
      responses: {
        200: { description: 'Ready', content: { 'application/json': { schema: ReadinessSchema } } },
        503: {
          description: 'Not ready',
          content: { 'application/json': { schema: ReadinessSchema } },
        },
      },
    }),
    async (c) => {
      const { db, config } = c.var.deps;
      const [database, redis, disk] = await Promise.all([
        databaseReady(db),
        config.redisUrl ? redisReady(config.redisUrl) : undefined,
        diskState(),
      ]);
      setDiskLow(disk === 'low');
      const checks = {
        database: database ? ('ok' as const) : ('error' as const),
        ...(redis !== undefined && { redis: redis ? ('ok' as const) : ('error' as const) }),
      };
      const extra = disk === 'low' ? { disk: 'low' as const } : {};
      if (database && redis !== false) {
        return c.json({ status: 'ready' as const, checks, ...extra }, 200);
      }
      return c.json({ status: 'not_ready' as const, checks, ...extra }, 503);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/metrics',
      tags: ['health'],
      summary: 'Prometheus metrics',
      responses: {
        200: { description: 'Metrics', content: { 'text/plain': { schema: z.string() } } },
        401: problemResponse('Missing or wrong metrics token'),
        404: problemResponse('Metrics are off (no OPENBOTS_METRICS_TOKEN)'),
      },
    }),
    async (c) => {
      const token = c.var.deps.config.metricsToken;
      if (!token) throw notFound('Metrics are off; set OPENBOTS_METRICS_TOKEN to turn them on');
      const presented = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
      if (!safeEqual(presented, token)) {
        throw unauthorized('Send OPENBOTS_METRICS_TOKEN as a bearer token');
      }
      setDiskLow((await diskState()) === 'low');
      // A database outage leaves the run gauges at their last value rather than failing the scrape.
      await collectRunGauges(c.var.deps.db).catch((err: unknown) =>
        c.var.deps.logger.warn({ err }, 'run gauges not collected'),
      );
      return c.text(await registry.metrics(), 200, { 'content-type': registry.contentType });
    },
  );
