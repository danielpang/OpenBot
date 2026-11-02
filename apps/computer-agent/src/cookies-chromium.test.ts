import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool } from './browser.js';
import { CookieSync } from './cookies.js';
import { DevToolsBridge } from './devtools.js';
import { screenInfo } from './screens.js';

// Shared logins against real Chromium (K1): headless, each "screen" its own
// profile, reached the way the agent reaches it, over the DevTools pipe and
// Playwright. Runs wherever Playwright's Chromium (or OPENBOTS_CHROMIUM) is
// installed; the X side of a screen is display.test.ts's.

const chromiumPath = process.env.OPENBOTS_CHROMIUM ?? chromium.executablePath();

describe.skipIf(!existsSync(chromiumPath))('shared cookies in real Chromium (K1)', () => {
  let site: Server;
  let origin: string;
  const running = new Map<number, { child: ChildProcess; bridge: DevToolsBridge }>();
  const browsers = new BrowserPool((info) => running.get(info.n)!.bridge.endpoint());
  let saved: string | undefined;
  const errors: unknown[] = [];
  const profiles: string[] = [];
  const newSync = () =>
    new CookieSync({
      jar: (n) => browsers.context(screenInfo(n, 800, 600)),
      screens: () => [...running.keys()],
      load: async () => saved,
      save: async (text) => {
        saved = text;
      },
      onError: (error) => errors.push(error),
    });
  let sync = newSync();

  async function launch(n: number, profile?: string) {
    const dir = profile ?? (await mkdtemp(path.join(tmpdir(), `openbots-profile-${n}-`)));
    profiles.push(dir);
    const child = spawn(
      chromiumPath,
      [
        '--headless=new',
        `--user-data-dir=${dir}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    );
    const bridge = await DevToolsBridge.listen(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable,
    );
    await bridge.ready();
    running.set(n, { child, bridge });
    await sync.open(n);
    return dir;
  }

  async function quit(n: number) {
    const screen = running.get(n)!;
    await sync.close(n);
    await browsers.disconnect(n);
    running.delete(n);
    const exited = new Promise((resolve) => screen.child.once('exit', resolve));
    screen.child.kill();
    await exited;
    await screen.bridge.close();
  }

  /** Opens `pathname` on screen `n` as a Bot's browser action would, then syncs. */
  async function visit(n: number, pathname: string) {
    await browsers.run(screenInfo(n, 800, 600), 'navigate', { url: origin + pathname });
    await sync.afterAction(n);
    const page = await browsers.page(screenInfo(n, 800, 600));
    return (await page.textContent('body'))?.trim() ?? '';
  }

  beforeAll(async () => {
    site = createServer((req, res) => {
      const headers: Record<string, string | string[]> = { 'content-type': 'text/plain' };
      if (req.url === '/login') {
        headers['set-cookie'] = ['sid=signed-in; Path=/; HttpOnly; Max-Age=3600'];
      } else if (req.url === '/logout') {
        headers['set-cookie'] = ['sid=; Path=/; HttpOnly; Max-Age=0'];
      } else if (req.url === '/session') {
        headers['set-cookie'] = ['tab=open; Path=/'];
      }
      res.writeHead(200, headers);
      res.end(`cookies: ${req.headers.cookie ?? 'none'}`);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(site.address() as AddressInfo).port}`;
    await sync.init();
  }, 60_000);

  afterAll(async () => {
    for (const n of [...running.keys()]) await quit(n);
    await new Promise<void>((resolve) => site.close(() => resolve()));
    for (const dir of profiles) await rm(dir, { recursive: true, force: true });
  });

  it('carries a login on one screen over to another, and a logout too', async () => {
    await launch(1);
    await launch(2);
    expect(await visit(2, '/whoami')).toBe('cookies: none');
    await visit(1, '/login');
    expect(await visit(2, '/whoami')).toBe('cookies: sid=signed-in');

    await visit(2, '/logout');
    expect(await visit(1, '/whoami')).toBe('cookies: none');
    expect(errors).toEqual([]);
  }, 60_000);

  it("gives a new screen the store's logins, session cookies included, after the agent restarts", async () => {
    await visit(1, '/login');
    await visit(1, '/session');
    await quit(1);
    await quit(2);

    sync = newSync();
    await sync.init();
    await launch(3);
    expect(await visit(3, '/whoami')).toBe('cookies: sid=signed-in; tab=open');
    expect(errors).toEqual([]);
  }, 60_000);

  it('keeps a profile that was offline from bringing back a cookie removed elsewhere', async () => {
    const profile = await launch(4);
    expect(await visit(4, '/whoami')).toContain('sid=signed-in');
    await quit(4);

    await visit(3, '/logout');
    await launch(4, profile);
    expect(await visit(4, '/whoami')).toBe('cookies: tab=open');
    expect(await visit(3, '/whoami')).toBe('cookies: tab=open');
    expect(errors).toEqual([]);
  }, 60_000);
});
