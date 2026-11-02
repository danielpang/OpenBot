import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { observeProviderStep, observeRun, observeWebhook } from '../metrics.js';
import { createTestApp, type TestApp } from '../test-app.js';

const METRICS_TOKEN = 'metrics-token-for-tests';

describe('health routes', () => {
  let t: TestApp;
  const metrics = (token = METRICS_TOKEN) =>
    t.app.request('/metrics', { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    t = await createTestApp({ OPENBOTS_METRICS_TOKEN: METRICS_TOKEN });
  });
  afterAll(() => t.close());

  it('reports the process up', async () => {
    const res = await t.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    const res = await t.app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('reports not ready when the database is unreachable', async () => {
    const down = {
      execute: () => Promise.reject(new Error('connection refused')),
    } as unknown as Db;
    const res = await createApp({ ...t.deps, db: down }, { webDist: '' }).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not_ready', checks: { database: 'error' } });
  });

  it('reports not ready when Redis is configured but unreachable', async () => {
    const config = { ...t.deps.config, redisUrl: 'redis://127.0.0.1:1' };
    const res = await createApp({ ...t.deps, config }, { webDist: '' }).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'ok', redis: 'error' },
    });
  });

  it('serves Prometheus metrics with the request histogram', async () => {
    await t.app.request('/healthz');
    const res = await metrics();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/healthz"[^}]*\} \d+/);
  });

  it('serves the run, queue, webhook and provider metrics', async () => {
    const at = new Date('2026-10-24T00:00:00Z');
    observeRun({ status: 'running', trigger: 'message', startedAt: at, finishedAt: null });
    observeRun({
      status: 'completed',
      trigger: 'routine',
      startedAt: at,
      finishedAt: new Date(at.getTime() + 3_000),
    });
    observeWebhook('inbound', 'started');
    observeWebhook('outbound', 'failed');
    observeProviderStep('anthropic', 'claude-opus-5-5', 1_500);
    const body = await (await metrics()).text();
    expect(body).toMatch(/openbots_runs_finished_total\{status="completed",trigger="routine"\} 1/);
    expect(body).not.toContain('status="running",trigger');
    expect(body).toMatch(/openbots_run_duration_seconds_sum\{status="completed"\} 3/);
    for (const status of ['queued', 'running', 'waiting']) {
      expect(body).toContain(`openbots_runs{status="${status}"} 0`);
    }
    expect(body).toMatch(
      /openbots_webhook_deliveries_total\{direction="inbound",outcome="started"\} 1/,
    );
    expect(body).toMatch(
      /openbots_webhook_deliveries_total\{direction="outbound",outcome="failed"\} 1/,
    );
    expect(body).toMatch(
      /openbots_provider_step_duration_seconds_sum\{provider="anthropic",model="claude-opus-5-5"\} 1.5/,
    );
  });

  it('serves metrics only with the metrics token', async () => {
    expect((await t.app.request('/metrics')).status).toBe(401);
    expect((await metrics('wrong-token-of-some-length')).status).toBe(401);
    const res = await t.app.request('/metrics', {
      headers: { authorization: `Basic ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('keeps metrics off when no token is configured', async () => {
    const config = { ...t.deps.config, metricsToken: undefined };
    const app = createApp({ ...t.deps, config }, { webDist: '' });
    const res = await app.request('/metrics', {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
