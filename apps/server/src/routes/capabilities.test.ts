import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { readPackageVersion, RELAY_PROTOCOL_VERSION, serverVersion } from '../version.js';

/** The release version as scripts/release-version.mjs stamps it: the root package.json. */
const ROOT_VERSION = (
  JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

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
      relay: false,
      version: ROOT_VERSION,
      protocol: { relay: 1 },
      setupPairingOnly: false,
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
      relay: false,
      version: ROOT_VERSION,
      protocol: { relay: 1 },
      setupPairingOnly: false,
      auth: 'password',
    });
  });

  it('reports the relay when OPENBOTS_RELAY_URL is set', async () => {
    const relayed = await createTestApp({ OPENBOTS_RELAY_URL: 'wss://relay.example.com' });
    try {
      const res = await relayed.app.request('/api/v1/capabilities');
      expect(((await res.json()) as { relay: boolean }).relay).toBe(true);
      expect(relayed.deps.config.relayUrl).toBe('wss://relay.example.com');
    } finally {
      await relayed.close();
    }
  });

  it('reports local sign-in when the Mac app set a local token', async () => {
    const config = { ...t.deps.config, localToken: 'k'.repeat(43) };
    const res = await createApp({ ...t.deps, config }, { webDist: '' }).request(
      '/api/v1/capabilities',
    );
    expect(((await res.json()) as { auth: string }).auth).toBe('local');
  });

  it('reports the release version and the relay protocol, so a phone can ask for an update', async () => {
    const res = await t.app.request('/api/v1/capabilities');
    const body = (await res.json()) as { version: string; protocol: { relay: number } };
    expect(body.version).toBe(serverVersion());
    expect(body.version).toBe(ROOT_VERSION);
    expect(body.protocol).toEqual({ relay: RELAY_PROTOCOL_VERSION });
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
  });

  it('reads a package.json version, and nothing from a missing or versionless file', () => {
    const dir = new URL('../../../../', import.meta.url);
    expect(readPackageVersion(new URL('package.json', dir))).toBe(ROOT_VERSION);
    expect(readPackageVersion(new URL('no-such-file.json', dir))).toBeNull();
    expect(readPackageVersion(new URL('../../tsconfig.json', import.meta.url))).toBeNull();
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
