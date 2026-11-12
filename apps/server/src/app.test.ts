import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('app', () => {
  let t: TestApp;
  let webDist: string;

  beforeAll(async () => {
    t = await createTestApp();
    webDist = mkdtempSync(join(tmpdir(), 'openbots-web-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>OpenBots</title>');
    writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  });
  afterAll(async () => {
    rmSync(webDist, { recursive: true, force: true });
    await t.close();
  });

  it('serves an OpenAPI document generated from the route definitions', async () => {
    const res = await t.app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/healthz',
        '/readyz',
        '/api/v1/me',
        '/api/v1/api-keys',
        '/api/v1/api-keys/{id}',
        '/api/v1/settings',
        '/api/v1/capabilities',
        '/api/v1/bots',
        '/api/v1/bots/{id}',
        '/api/v1/bots/{id}/duplicate',
        '/api/v1/bots/{id}/pin',
        '/api/v1/bots/{id}/unpin',
        '/api/v1/bots/{id}/hide',
        '/api/v1/bots/{id}/unhide',
        '/api/v1/bots/{id}/state',
        '/api/v1/bots/{id}/avatar.png',
        '/api/v1/bots/{id}/chat',
        '/api/v1/chats',
        '/api/v1/chats/{id}/members',
        '/api/v1/chats/{id}/members/{botId}',
        '/api/v1/chats/{id}/messages',
        '/api/v1/chats/{id}/resync',
        '/api/v1/messages/{id}/reactions',
        '/api/v1/files',
        '/api/v1/files/{id}',
        '/api/v1/providers',
        '/api/v1/providers/presets',
        '/api/v1/providers/{id}',
        '/api/v1/providers/{id}/test',
        '/api/v1/providers/{id}/discover',
        '/api/v1/providers/{id}/models',
        '/api/v1/models',
        '/api/v1/runs/{id}',
        '/api/v1/runs/{id}/steps',
        '/api/v1/runs/{id}/events',
        '/api/v1/runs/{id}/cancel',
        '/api/v1/messages/{id}/widgets/{part}/action',
        '/api/v1/bots/{id}/memories',
        '/api/v1/bots/{id}/memories/{memoryId}',
        '/api/v1/approvals',
        '/api/v1/approvals/{id}/decide',
        '/api/v1/connectors/catalog',
        '/api/v1/connectors',
        '/api/v1/connectors/import',
        '/api/v1/connectors/{id}',
        '/api/v1/connectors/{id}/test',
        '/api/v1/connectors/{id}/tools',
        '/api/v1/connectors/{id}/oauth/start',
        '/api/v1/connectors/oauth/callback',
        '/api/v1/connector-policy',
        '/api/v1/bots/{id}/connectors',
        '/api/v1/artifacts/{id}',
        '/api/v1/artifacts/{id}/versions',
        '/api/v1/artifacts/{id}/versions/{version}/content',
        '/api/v1/artifacts/{id}/download',
        '/api/v1/bots/{id}/artifacts',
        '/api/v1/computer',
        '/api/v1/computer/start',
        '/api/v1/computer/stop',
        '/api/v1/computer/files',
        '/api/v1/computer/files/{path}',
        '/api/v1/bots/{id}/screen/control',
        '/api/v1/bots/{id}/routines',
        '/api/v1/routines/{id}',
        '/api/v1/routines/{id}/run-now',
        '/api/v1/routines/{id}/runs',
        '/api/v1/skills',
        '/api/v1/skills/{id}',
        '/api/v1/skills/{id}/blocked-bots',
        '/api/v1/bots/{id}/endpoints',
        '/api/v1/endpoints/{id}',
        '/api/v1/endpoints/{id}/rotate',
        '/api/v1/endpoints/{id}/deliveries',
        '/api/v1/endpoints/{id}/deliveries/{did}/replay',
        '/api/v1/endpoints/{id}/test',
        '/api/v1/event-subscriptions',
        '/api/v1/event-subscriptions/{id}',
        '/api/v1/event-subscriptions/{id}/deliveries',
        '/api/v1/setup',
        '/api/v1/setup/admin',
        '/api/v1/setup/sandbox-image',
      ]),
    );
    expect(doc.components.schemas).toHaveProperty('Me');
    expect(doc.components.schemas).toHaveProperty('Problem');
    expect(doc.components.securitySchemes).toHaveProperty('apiKey');
  });

  it('answers unknown API paths with a problem document', async () => {
    const res = await t.app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 404, title: 'Not found' });
  });

  it('serves the built web app with SPA fallback when it exists', async () => {
    const app = createApp(t.deps, { webDist });
    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log(1)');

    for (const path of ['/', '/bots/123']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>OpenBots</title>');
    }
    expect((await app.request('/api/v1/nope')).status).toBe(404);
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('does not return SPA HTML for missing build assets', async () => {
    const app = createApp(t.deps, { webDist });
    for (const path of ['/assets/old-chunk.js', '/assets/old-style.css']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('cache-control') ?? '').not.toContain('immutable');
    }
  });

  it('serves the current index on deep links after a rebuild', async () => {
    const app = createApp(t.deps, { webDist });
    const index = join(webDist, 'index.html');
    try {
      writeFileSync(index, '<!doctype html><title>New build</title>');
      const res = await app.request('/bots/123');
      expect(await res.text()).toContain('<title>New build</title>');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    } finally {
      writeFileSync(index, '<!doctype html><title>OpenBots</title>');
    }
  });

  it('has no SPA fallback without a web build', async () => {
    expect((await t.app.request('/bots/123')).status).toBe(404);
  });

  it('marks session cookies secure when the public URL is https', async () => {
    const https = await createTestApp({ OPENBOTS_PUBLIC_URL: 'https://bots.example.com' });
    try {
      const res = await https.app.request('https://bots.example.com/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://bots.example.com' },
        body: JSON.stringify({
          name: 'ada',
          email: 'ada@example.com',
          password: 'correct horse battery',
        }),
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.getSetCookie().find((c) => c.includes('session_token='));
      expect(cookie).toMatch(/^__Secure-/);
      expect(cookie).toMatch(/;\s*Secure/i);
    } finally {
      await https.close();
    }
  });
});
