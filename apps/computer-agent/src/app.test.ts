import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CookieSync } from './cookies.js';
import { AgentError } from './errors.js';
import type { ExecEvent, FsListing } from './protocol.js';
import { createTestAgent, fakeRun, json, program, tempHome, TEST_TOKEN } from './test-utils.js';
import { Users } from './users.js';

async function execEvents(res: Response): Promise<ExecEvent[]> {
  expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecEvent);
}

const output = (events: ExecEvent[], type: 'stdout' | 'stderr') =>
  events
    .filter((e): e is Extract<ExecEvent, { type: typeof type }> => e.type === type)
    .map((e) => e.data)
    .join('');

describe('token auth', () => {
  const routes: [string, string][] = [
    ['GET', '/healthz'],
    ['POST', '/exec'],
    ['GET', '/fs/'],
    ['PUT', '/fs/a.txt'],
    ['DELETE', '/fs/a.txt'],
    ['POST', '/screens'],
    ['DELETE', '/screens/0'],
    ['GET', '/screens/0/screenshot'],
    ['POST', '/screens/0/input'],
    ['POST', '/screens/0/browser/snapshot'],
    ['POST', '/wallpaper'],
    ['GET', '/nowhere'],
  ];

  it.each(routes)('rejects %s %s without the token', async (method, pathname) => {
    const { app } = await createTestAgent();
    const res = await app.request(pathname, { method });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('rejects a wrong token', async () => {
    const { app } = await createTestAgent();
    const res = await app.request('/healthz', {
      headers: { authorization: `Bearer ${TEST_TOKEN}x` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the token', async () => {
    const { request } = await createTestAgent();
    const res = await request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', screens: [] });
  });
});

describe('POST /exec', () => {
  it('streams stdout, stderr and the exit code as NDJSON', async () => {
    const { request } = await createTestAgent();
    const res = await request('/exec', json({ command: 'echo out; echo err >&2; exit 3' }));
    expect(res.status).toBe(200);
    const events = await execEvents(res);
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(output(events, 'stdout')).toBe('out\n');
    expect(output(events, 'stderr')).toBe('err\n');
    expect(events.at(-1)).toMatchObject({ type: 'exit', exitCode: 3, timedOut: false });
  });

  it('runs in the home directory by default, or in cwd, with env and stdin', async () => {
    const { request, home } = await createTestAgent();
    await mkdir(path.join(home, 'proj'));
    const atHome = await execEvents(await request('/exec', json({ command: 'pwd; echo $HOME' })));
    expect(output(atHome, 'stdout')).toBe(`${home}\n${home}\n`);

    const events = await execEvents(
      await request(
        '/exec',
        json({
          command: 'pwd; echo "$GREETING"; cat',
          cwd: 'proj',
          env: { GREETING: 'hi' },
          stdin: 'piped',
        }),
      ),
    );
    expect(output(events, 'stdout')).toBe(`${path.join(home, 'proj')}\nhi\npiped`);
  });

  it('runs the command without the agent token, even when the request sets it (S-7)', async () => {
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = TEST_TOKEN;
    try {
      const { request } = await createTestAgent();
      const events = await execEvents(
        await request(
          '/exec',
          json({
            command: 'env; echo "token=${OPENBOTS_AGENT_TOKEN-unset}"',
            env: { OPENBOTS_AGENT_TOKEN: 'smuggled-in-0123456789' },
          }),
        ),
      );
      const stdout = output(events, 'stdout');
      expect(stdout).toContain('token=unset\n');
      expect(stdout).not.toContain(TEST_TOKEN);
      expect(stdout).not.toContain('smuggled-in');
    } finally {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    }
  });

  it("gives a command for a screen's Bot that screen's display and cookie, whatever the request says (S-7)", async () => {
    const { request, home } = await createTestAgent();
    const events = await execEvents(
      await request(
        '/exec',
        json({
          command: 'echo "$DISPLAY $XAUTHORITY"',
          screen: 2,
          env: { DISPLAY: ':11', XAUTHORITY: '/home/bot/stolen' },
        }),
      ),
    );
    expect(output(events, 'stdout')).toBe(`:12 ${home}-run/screens/screen-2/Xauthority\n`);
    expect((await request('/exec', json({ command: 'true', screen: 90 }))).status).toBe(400);
  });

  it("runs commands as the bot user, with the group of the Bot's screen, through the helper (S-7)", async () => {
    const dir = await tempHome();
    // A stand-in for openbots-runas that says whom it would run the command as.
    const helper = path.join(dir, 'runas');
    await writeFile(helper, '#!/bin/sh\necho "as $1:$2"\nshift 3\nexec "$@"\n', { mode: 0o755 });
    const { request } = await createTestAgent({ users: new Users(helper) });
    const forScreen = await execEvents(
      await request('/exec', json({ command: 'echo ran', screen: 4 })),
    );
    expect(output(forScreen, 'stdout')).toBe('as 1000:2004\nran\n');
    const forNone = await execEvents(await request('/exec', json({ command: 'echo ran' })));
    expect(output(forNone, 'stdout')).toBe('as 1000:1000\nran\n');
  });

  it('kills the command at its timeout', async () => {
    const { request } = await createTestAgent();
    const started = Date.now();
    const events = await execEvents(
      await request('/exec', json({ command: 'echo begin; sleep 30; echo never', timeoutMs: 300 })),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(output(events, 'stdout')).toBe('begin\n');
    expect(events.at(-1)).toMatchObject({ type: 'exit', timedOut: true, signal: 'SIGTERM' });
  });

  it('does not wait for a background job that keeps stdout open', async () => {
    const { request } = await createTestAgent();
    const started = Date.now();
    const events = await execEvents(
      await request('/exec', json({ command: 'sleep 5 & echo done' })),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(events.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
  });

  it('reports a cwd that does not exist as an error event', async () => {
    const { request } = await createTestAgent();
    const events = await execEvents(await request('/exec', json({ command: 'true', cwd: 'nope' })));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('validates the body', async () => {
    const { request } = await createTestAgent();
    const res = await request('/exec', json({ command: '' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const bad = await request('/exec', { method: 'POST', body: '{' });
    expect(await bad.json()).toMatchObject({ status: 400, code: 'INVALID_JSON' });
  });
});

describe('/fs/*', () => {
  it('writes, reads, lists and deletes files under home', async () => {
    const { request, home } = await createTestAgent();
    const put = await request('/fs/notes/today.md', { method: 'PUT', body: '# Hello' });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({
      name: 'today.md',
      path: 'notes/today.md',
      type: 'file',
      size: 7,
    });
    expect(await readFile(path.join(home, 'notes/today.md'), 'utf8')).toBe('# Hello');

    const get = await request('/fs/notes/today.md');
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(await get.text()).toBe('# Hello');

    await request('/fs/notes/archive?dir=1', { method: 'PUT' });
    const listing = (await (await request('/fs/notes')).json()) as FsListing;
    expect(listing.path).toBe('notes');
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ['archive', 'dir'],
      ['today.md', 'file'],
    ]);

    const root = (await (await request('/fs/')).json()) as FsListing;
    expect(root).toMatchObject({
      path: '',
      entries: [{ name: 'notes', path: 'notes', type: 'dir' }],
    });
    expect((await request('/fs')).status).toBe(200);

    expect((await request('/fs/notes/today.md', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/fs/notes/today.md')).status).toBe(404);
  });

  it('keeps binary bodies byte for byte (A3)', async () => {
    const { request, home } = await createTestAgent();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00]);
    const put = await request('/fs/out/chart.png', { method: 'PUT', body: bytes });
    expect(await put.json()).toMatchObject({ size: bytes.byteLength });
    expect(new Uint8Array(await readFile(path.join(home, 'out/chart.png')))).toEqual(bytes);
    const get = await request('/fs/out/chart.png');
    expect(get.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('handles names that need URL encoding', async () => {
    const { request, home } = await createTestAgent();
    await request('/fs/My%20Files/caf%C3%A9.txt', { method: 'PUT', body: 'x' });
    expect(await readFile(path.join(home, 'My Files', 'café.txt'), 'utf8')).toBe('x');
    const listing = (await (await request('/fs/My%20Files')).json()) as FsListing;
    expect(listing.entries[0]).toMatchObject({ name: 'café.txt', path: 'My Files/café.txt' });
  });

  it('overwrites a file atomically and refuses to write over a directory', async () => {
    const { request } = await createTestAgent();
    await request('/fs/a.txt', { method: 'PUT', body: 'one' });
    await request('/fs/a.txt', { method: 'PUT', body: 'two' });
    expect(await (await request('/fs/a.txt')).text()).toBe('two');
    const listing = (await (await request('/fs/')).json()) as FsListing;
    expect(listing.entries.map((e) => e.name)).toEqual(['a.txt']);

    await request('/fs/d?dir=1', { method: 'PUT' });
    const res = await request('/fs/d', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'IS_A_DIRECTORY' });
  });

  it('deletes a non-empty directory only with ?recursive', async () => {
    const { request } = await createTestAgent();
    await request('/fs/d/e/f.txt', { method: 'PUT', body: 'x' });
    const refused = await request('/fs/d', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' });
    expect((await request('/fs/d?recursive=1', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/fs/d')).status).toBe(404);
  });

  it('never leaves home', async () => {
    const { request, home } = await createTestAgent();
    const outside = `${home}-outside`;
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'nope');
    await symlink(outside, path.join(home, 'link'));

    for (const p of [
      '/fs/..%2F..%2Fetc%2Fpasswd',
      '/fs/a/..%2F..%2F..%2Fx',
      '/fs/link/secret',
      '/fs/link',
    ]) {
      const res = await request(p);
      expect(res.status, p).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PATH_OUTSIDE_HOME' });
    }
    expect((await request('/fs/link/new.txt', { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await request('/fs/', { method: 'DELETE' })).status).toBe(409);
  });
});

describe('screens', () => {
  it('starts a screen once and stops it', async () => {
    const { request, spawned } = await createTestAgent();
    const res = await request('/screens', json({ n: 2 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      n: 2,
      display: ':12',
      width: 1280,
      height: 800,
      vncPort: 5912,
      cdpPort: 9224,
    });
    const again = await request('/screens', json({ n: 2 }));
    expect(again.status).toBe(200);
    expect(spawned.map(program)).toEqual(['Xvfb', 'openbox', 'x11vnc', '/opt/chromium/chrome']);

    const health = (await (await request('/healthz')).json()) as { screens: unknown[] };
    expect(health.screens).toHaveLength(1);
    expect((await request('/screens/2', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/screens/2', { method: 'DELETE' })).status).toBe(404);
    expect(spawned.every((s) => s.child.signalCode === 'SIGTERM')).toBe(true);
  });

  it('answers 404 for a screen that is not running', async () => {
    const { request } = await createTestAgent();
    for (const [method, p] of [
      ['GET', '/screens/1/screenshot'],
      ['POST', '/screens/1/input'],
      ['POST', '/screens/1/browser/snapshot'],
      ['GET', '/screens/abc/screenshot'],
    ] as const) {
      const res = await request(p, { method, body: method === 'POST' ? '{}' : undefined });
      expect(res.status, p).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'SCREEN_NOT_RUNNING' });
    }
  });

  it('validates the screen number', async () => {
    const { request } = await createTestAgent();
    expect((await request('/screens', json({ n: 90 }))).status).toBe(400);
    expect((await request('/screens', json({ n: -1 }))).status).toBe(400);
  });

  it('takes a screenshot of the display with ImageMagick', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fake = fakeRun(() => png);
    const { request } = await createTestAgent({ run: fake.run });
    await request('/screens', json({ n: 0 }));
    const res = await request('/screens/0/screenshot');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    const call = fake.calls.find((c) => c.command === 'import');
    expect(call).toMatchObject({
      args: ['-silent', '-window', 'root', 'png:-'],
      env: { DISPLAY: ':10', XAUTHORITY: expect.stringMatching(/screen-0\/Xauthority$/) },
      user: { uid: 2000, gid: 2000 },
    });
  });

  it('sends input to the display with xdotool', async () => {
    const fake = fakeRun((c) =>
      c.args[0] === 'getmouselocation' ? 'X=40\nY=30\nSCREEN=0\nWINDOW=1\n' : '',
    );
    const { request } = await createTestAgent({ run: fake.run });
    await request('/screens', json({ n: 1 }));
    const res = await request('/screens/1/input', json({ action: 'click', x: 10, y: 20 }));
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.calls.at(-1)).toMatchObject({
      command: 'xdotool',
      args: ['mousemove', '--sync', '10', '20', 'click', '--repeat', '1', '--delay', '80', '1'],
      env: { DISPLAY: ':11', XAUTHORITY: expect.stringMatching(/screen-1\/Xauthority$/) },
      user: { uid: 2001, gid: 2001 },
    });
    const pos = await request('/screens/1/input', json({ action: 'cursor_position' }));
    expect(await pos.json()).toEqual({ ok: true, x: 40, y: 30 });

    const bad = await request('/screens/1/input', json({ action: 'teleport' }));
    expect(bad.status).toBe(400);
  });

  it('rejects an unknown browser action', async () => {
    const { request } = await createTestAgent();
    await request('/screens', json({ n: 0 }));
    const res = await request('/screens/0/browser/hover', json({}));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_BROWSER_ACTION' });
  });
});

describe('shared cookies (K1)', () => {
  /** A cookie sync that records what the routes ask of it. */
  function recorder(log: string[]) {
    return () =>
      ({
        afterAction: vi.fn(async (n: number) => void log.push(`after ${n}`)),
        close: vi.fn(async (n: number) => void log.push(`close ${n}`)),
        sync: vi.fn(async (n?: number) => {
          log.push(`sync ${n ?? 'all'}`);
          return n === undefined ? [0, 1] : [n];
        }),
        cookies: () => [{ name: 'sid' }, { name: 'theme' }],
      }) as unknown as CookieSync;
  }

  it('exports cookies after a computer action and after a browser action, failed or not', async () => {
    const log: string[] = [];
    const { request, browsers } = await createTestAgent({ cookies: recorder(log) });
    await request('/screens', json({ n: 1 }));
    await request('/screens/1/input', json({ action: 'click', x: 1, y: 2 }));
    expect(log).toEqual(['after 1']);

    browsers.run = vi.fn(async () => ({ url: 'https://example.com/', title: 'Example' }));
    expect((await request('/screens/1/browser/snapshot', json({}))).status).toBe(200);
    browsers.run = vi.fn(async () => {
      throw new AgentError(422, 'BROWSER_ACTION_FAILED', 'no such ref');
    });
    expect((await request('/screens/1/browser/click', json({ ref: 'e9' }))).status).toBe(422);
    expect(log).toEqual(['after 1', 'after 1', 'after 1']);
  });

  it("exports a screen's cookies before it stops", async () => {
    const log: string[] = [];
    const { request, browsers } = await createTestAgent({ cookies: recorder(log) });
    const disconnect = browsers.disconnect.bind(browsers);
    browsers.disconnect = async (n) => {
      log.push(`disconnect ${n}`);
      await disconnect(n);
    };
    await request('/screens', json({ n: 2 }));
    expect((await request('/screens/2', { method: 'DELETE' })).status).toBe(204);
    expect(log).toEqual(['close 2', 'disconnect 2']);
  });

  it('syncs one running screen, or all of them, when the server asks', async () => {
    const log: string[] = [];
    const { request } = await createTestAgent({ cookies: recorder(log) });
    await request('/screens', json({ n: 1 }));
    const one = await request('/cookies/sync', json({ screen: 1 }));
    expect(await one.json()).toEqual({ screens: [1], cookies: 2 });
    const all = await request('/cookies/sync', json({}));
    expect(await all.json()).toEqual({ screens: [0, 1], cookies: 2 });
    expect(log).toEqual(['sync 1', 'sync all']);

    expect((await request('/cookies/sync', json({ screen: 4 }))).status).toBe(404);
    expect((await request('/cookies/sync', json({ screen: 'x' }))).status).toBe(400);
    expect(log).toHaveLength(2);
  });

  it('answers 404 to a sync on an agent that shares no cookies', async () => {
    const { request } = await createTestAgent();
    const res = await request('/cookies/sync', json({}));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NO_COOKIE_SYNC' });
  });
});

describe('POST /wallpaper', () => {
  it('sets the wallpaper for the hour on every running display', async () => {
    const { request, calls } = await createTestAgent();
    await request('/screens', json({ n: 0 }));
    await request('/screens', json({ n: 3 }));
    const res = await request('/wallpaper', json({ hour: 7 }));
    expect(await res.json()).toEqual({ hour: 7, screens: [0, 3] });
    const feh = calls.filter((c) => c.args[1]?.includes('feh'));
    expect(feh.map((c) => [c.env?.DISPLAY, c.user?.uid])).toEqual([
      [':10', 2000],
      [':13', 2003],
    ]);
    expect(feh[0]!.args.at(-1)).toMatch(/screen-0\/wallpaper\.png$/);
    expect(
      Buffer.from(feh[0]!.input as Uint8Array)
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  it('uses the current hour without a body', async () => {
    const { request } = await createTestAgent();
    const res = await request('/wallpaper', { method: 'POST' });
    expect(await res.json()).toEqual({ hour: new Date().getHours(), screens: [] });
  });
});
