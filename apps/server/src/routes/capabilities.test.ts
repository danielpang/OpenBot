import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createTestApp, type TestApp } from '../test-app.js';

describe('capabilities route', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('reports no OAuth providers when none are configured, without a session', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      oauth: { github: false, google: false },
      computer: false,
      deployment: 'self_hosted',
      customStdio: true,
      localEndpoints: true,
      auth: 'password',
    });
  });

  it('reports the providers whose id and secret are both set', async () => {
    const config = {
      ...t.deps.config,
      oauth: { github: { clientId: 'id', clientSecret: 'secret' } },
    };
    const res = await createApp({ ...t.deps, config }, { webDist: '' }).request(
      '/api/v1/capabilities',
    );
    expect(await res.json()).toEqual({
      oauth: { github: true, google: false },
      computer: false,
      deployment: 'self_hosted',
      customStdio: true,
      localEndpoints: true,
      auth: 'password',
    });
  });

  it('reports local sign-in when the Mac app set a local token', async () => {
    const config = { ...t.deps.config, localToken: 'k'.repeat(43) };
    const res = await createApp({ ...t.deps, config }, { webDist: '' }).request(
      '/api/v1/capabilities',
    );
    expect(((await res.json()) as { auth: string }).auth).toBe('local');
  });

  it('keeps custom stdio and local endpoints off on the managed service by default', async () => {
    const managed = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed' });
    try {
      const res = await managed.app.request('/api/v1/capabilities');
      expect(await res.json()).toMatchObject({
        deployment: 'managed',
        customStdio: false,
        localEndpoints: false,
      });
    } finally {
      await managed.close();
    }
  });
});
