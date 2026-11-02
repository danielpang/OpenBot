import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from './app.js';
import { createTestApp, ORIGIN, type TestApp } from './test-app.js';

// The HTTP edge (plan 17 controls 6 and 8): security headers on every
// response, the Origin check on cookie-authenticated writes, request-log
// redaction, and better-auth's rate limit keyed on the client address.

describe('http edge', () => {
  let t: TestApp;
  let cookie: string;
  let webDist: string;

  beforeAll(async () => {
    t = await createTestApp();
    cookie = (await t.signUp('ada@example.com')).cookie!;
    webDist = mkdtempSync(join(tmpdir(), 'openbots-web-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>OpenBots</title>');
    writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  });
  afterAll(async () => {
    rmSync(webDist, { recursive: true, force: true });
    await t.close();
  });

  const expectSecurityHeaders = (res: Response) => {
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    return csp;
  };

  it('sends security headers on the API, its errors, and the SPA', async () => {
    const app = createApp(t.deps, { webDist });
    expectSecurityHeaders(await app.request('/api/v1/capabilities'));
    expectSecurityHeaders(await app.request('/api/v1/nothing-here'));
    expectSecurityHeaders(await app.request('/healthz'));
    expectSecurityHeaders(await app.request('/assets/app.js'));

    // The computer page hosts the terminal (xterm.js) and the screen (noVNC):
    // both open WebSockets and set inline styles, and PDFs preview in a blob iframe.
    const page = await app.request('/computer');
    expect(await page.text()).toContain('<title>OpenBots</title>');
    const csp = expectSecurityHeaders(page);
    expect(csp).toContain("connect-src 'self' ws://localhost:3000");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-src 'self' blob:");
    expect(page.headers.get('strict-transport-security')).toBeNull();
  });

  it('adds HSTS and a wss: socket source when the public URL is https', async () => {
    const config = { ...t.deps.config, publicUrl: 'https://bots.example.com' };
    const app = createApp({ ...t.deps, config }, { webDist });
    for (const path of ['/computer', '/api/v1/capabilities']) {
      const res = await app.request(path);
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(res.headers.get('content-security-policy')).toContain('wss://bots.example.com');
    }
  });

  it('refuses cookie-authenticated writes from another origin', async () => {
    const createBot = (headers: Record<string, string>) =>
      t.app.request('/api/v1/bots', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Origin check' }),
      });

    const crossSite: Record<string, string>[] = [
      { cookie, origin: 'https://evil.example' },
      // A sibling subdomain is same-site, so SameSite=Lax alone lets it through.
      { cookie, origin: 'http://evil.localhost:3000' },
      { cookie, origin: 'null' },
      { cookie, 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of crossSite) {
      const refused = await createBot(headers);
      expect(refused.status).toBe(403);
      expect((await refused.json()) as unknown).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    }
    expect((await createBot({ cookie, origin: ORIGIN })).status).toBe(201);
    expect((await createBot({ cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(201);
    // Reads are not checked; the cookie never leaves for another site's reads anyway.
    const read = await t.app.request('/api/v1/bots', {
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(read.status).toBe(200);

    // An API key is not ambient authority: the desktop app and scripts are exempt.
    const issued = await t.app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify({ name: 'desktop' }),
    });
    expect(issued.status).toBe(201);
    const { key } = (await issued.json()) as { key: string };
    expect(
      (await createBot({ authorization: `Bearer ${key}`, origin: 'https://evil.example' })).status,
    ).toBe(201);
  });

  it('keeps webhook path tokens out of the request log', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const app = createApp({ ...t.deps, logger: pino(sink) }, { webDist: '' });
    const token = 'whk_c2VjcmV0LXBhdGgtdG9rZW4tZG8tbm90LWxvZw';
    await app.request(`/hooks/nobody/alerts/${token}`, { method: 'POST', body: '{}' });
    await app.request(`/hooks/nobody/${token}`, { method: 'POST', body: '{}' });

    const requests = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.filter((r) => r['msg'] === 'request').map((r) => r['path'])).toEqual([
      '/hooks/nobody/alerts/whk_[redacted]',
      '/hooks/nobody/whk_[redacted]',
    ]);
    expect(lines.join('')).not.toContain(token);
  });
});

// Each sign-in hashes a password, which is CPU-bound: give these tests room on
// a machine running other suites at the same time.
describe('auth rate limit', { timeout: 20_000 }, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({}, { rateLimit: true });
  });
  afterAll(async () => {
    await t.close();
  });
  // Each refused sign-in hashes a password, so on a loaded machine a few of
  // them can outlast the 10 s window. Freeze the clock the buckets read.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Client addresses unique to this run, as Redis-backed buckets outlive it.
  const run = 1 + Math.floor(Math.random() * 250);
  const ip = (n: number) => `10.${run}.0.${n}`;

  const signIn = (peer: string | undefined, headers: Record<string, string> = {}) =>
    t.app.request(
      '/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong password' }),
      },
      peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined,
    );

  it('gives each client address its own bucket (3 sign-ins per 10 s)', async () => {
    for (let i = 0; i < 3; i++) expect((await signIn(ip(1))).status).toBe(401);
    const limited = await signIn(ip(1));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect((await signIn(ip(2))).status).toBe(401);
  });

  it('ignores a spoofed X-Forwarded-For unless the peer is a trusted proxy', async () => {
    for (let i = 0; i < 3; i++) {
      const spoofed = { 'x-forwarded-for': `203.0.113.${i}` };
      expect((await signIn(ip(3), spoofed)).status).toBe(401);
    }
    // A fresh forged address does not buy a fresh bucket.
    const forged = { 'x-forwarded-for': '203.0.113.99' };
    expect((await signIn(ip(3), forged)).status).toBe(429);
    // Nor does sending the internal header directly.
    expect((await signIn(ip(3), { 'x-openbots-client-ip': '203.0.113.98' })).status).toBe(429);

    const { config } = t.ownerDeps;
    config.trustedProxies = ['172.16.0.0/12'];
    try {
      // Behind the tunnel each client, by its right-most untrusted hop, is counted apart.
      for (let i = 0; i < 3; i++) {
        expect((await signIn('172.18.0.4', { 'x-forwarded-for': ip(10) })).status).toBe(401);
      }
      const tunnelled = { 'x-forwarded-for': `${ip(3)}, ${ip(10)}` };
      expect((await signIn('172.18.0.4', tunnelled)).status).toBe(429);
      expect((await signIn('172.18.0.4', { 'x-forwarded-for': ip(11) })).status).toBe(401);
    } finally {
      config.trustedProxies = [];
    }
  });

  it('refuses a request whose address is unknown instead of sharing a bucket', async () => {
    const res = await signIn(undefined);
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ code: 'CLIENT_IP_UNKNOWN' });
  });
});
