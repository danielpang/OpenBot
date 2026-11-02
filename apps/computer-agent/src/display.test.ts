import { existsSync } from 'node:fs';
import { chown, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from './app.js';
import { BrowserPool } from './browser.js';
import { dropToBot, layOut } from './privileges.js';
import { createRun, type Run } from './proc.js';
import type { BrowserResult, ExecEvent } from './protocol.js';
import { downloadsDir, ScreenManager, shareDownloads } from './screens.js';
import { fakeVncServer, json, tempHome, TEST_TOKEN } from './test-utils.js';
import { BOT_ID, RUNAS_PATH, UNPRIVILEGED, Users } from './users.js';
import { Wallpaper } from './wallpaper.js';
import { attachWebSockets } from './ws.js';

// Against real Xvfb, openbox, x11vnc, xdotool, ImageMagick, feh and Chromium.
// Runs only where an X stack is installed and DISPLAY is set (the computer
// image, or a dev machine with those packages); a screen far from the usual
// displays keeps clear of anything already running. Run as root where
// openbots-runas is installed (the computer image), it lays the screens out
// and drops to the bot user as the agent does, so each screen runs as its
// own user and the cases marked "as root" run too.

const chromiumPath = process.env.OPENBOTS_CHROMIUM ?? chromium.executablePath();
const N = 50;
const OTHER = 51;
/** Screens whose display or VNC port a command takes first. */
const SQUATTED = 52;
const ABSTRACT = 53;
const privileged = process.getuid?.() === 0 && existsSync(RUNAS_PATH);

describe.skipIf(!process.env.DISPLAY)('a real screen', () => {
  let server: Server;
  let base: string;
  let screens: ScreenManager;
  let browsers: BrowserPool;
  let closeSockets: () => Promise<void>;
  let run: Run;
  let home: string;

  const request = (pathname: string, init: RequestInit = {}) =>
    fetch(base + pathname, {
      ...init,
      headers: { authorization: `Bearer ${TEST_TOKEN}`, ...init.headers },
    });
  const browser = async (action: string, body: unknown = {}) => {
    const res = await request(`/screens/${N}/browser/${action}`, json(body));
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as BrowserResult;
  };
  const exec = async (body: unknown) => {
    const events = (await (await request('/exec', json(body))).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ExecEvent);
    const out = (type: 'stdout' | 'stderr') =>
      events.map((e) => (e.type === type ? e.data : '')).join('');
    const exit = events.find((e) => e.type === 'exit');
    return {
      exitCode: exit?.type === 'exit' ? exit.exitCode : null,
      stdout: out('stdout'),
      stderr: out('stderr'),
    };
  };

  beforeAll(async () => {
    home = await tempHome();
    const dirs = { runtimeDir: `${home}-run`, stateDir: `${home}-state` };
    if (privileged) {
      await layOut(dirs);
      await chown(home, BOT_ID, BOT_ID);
      dropToBot();
    }
    await shareDownloads(home);
    const users = privileged ? new Users(RUNAS_PATH) : UNPRIVILEGED;
    run = createRun(users);
    screens = new ScreenManager({
      home,
      width: 1024,
      height: 768,
      ...dirs,
      users,
      run,
      chromiumPath: () => chromiumPath,
    });
    const wallpaper = new Wallpaper({
      run,
      targets: () => screens.list(),
      place: (t) => ({ file: screens.paths(t.n).wallpaper, x: screens.x(t.n) }),
    });
    browsers = new BrowserPool((info) => screens.devtools(info.n));
    const app = createApp({ token: TEST_TOKEN, home, run, screens, browsers, wallpaper, users });
    server = createServer(getRequestListener(app.fetch));
    closeSockets = attachWebSockets(server, { token: TEST_TOKEN, home, screens, users }).close;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await closeSockets?.();
    await browsers?.disconnectAll();
    await screens?.stopAll();
    await new Promise((r) => server?.close(r));
  });

  it('starts the screen', async () => {
    const res = await request('/screens', json({ n: N }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ display: `:${10 + N}`, width: 1024, height: 768 });
  }, 60_000);

  it('takes a screenshot at the screen size', async () => {
    const res = await request(`/screens/${N}/screenshot`);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 768]);
  });

  it('moves the pointer with xdotool', async () => {
    await request(`/screens/${N}/input`, json({ action: 'move', x: 100, y: 120 }));
    const res = await request(`/screens/${N}/input`, json({ action: 'cursor_position' }));
    expect(await res.json()).toEqual({ ok: true, x: 100, y: 120 });
    const key = await request(`/screens/${N}/input`, json({ action: 'key', keys: 'shift' }));
    expect(key.status).toBe(200);
  });

  it('drives Chromium by aria refs', async () => {
    const page =
      '<title>Form</title><label>Name <input id="name"></label>' +
      "<button onclick=\"document.title='Hi '+document.getElementById('name').value\">Go</button>";
    await browser('navigate', { url: `data:text/html,${encodeURIComponent(page)}` });
    const snap = await browser('snapshot');
    expect(snap.title).toBe('Form');
    const ref = (pattern: RegExp) => pattern.exec(snap.snapshot ?? '')?.[1];
    const textbox = ref(/textbox "Name" \[ref=(\w+)\]/);
    const button = ref(/button "Go" \[ref=(\w+)\]/);
    expect(textbox, snap.snapshot).toBeDefined();
    expect(button, snap.snapshot).toBeDefined();
    await browser('type', { ref: textbox, text: 'Ada' });
    const clicked = await browser('click', { ref: button });
    expect(clicked.title).toBe('Hi Ada');
    await browser('press', { key: 'Tab' });
    await browser('wait', { ms: 10 });

    const missing = await request(
      `/screens/${N}/browser/click`,
      json({ ref: 'e9999', timeoutMs: 500 }),
    );
    expect(missing.status).toBe(422);
  }, 60_000);

  /** Logs in to screen `n`'s preview and returns the size in its ServerInit. */
  async function preview(n: number): Promise<[number, number]> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/vnc/${n}`, ['binary'], {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const received: Buffer[] = [];
    let wake: (() => void) | undefined;
    ws.on('message', (data) => {
      received.push(data as Buffer);
      wake?.();
    });
    const take = async (count: number) => {
      for (;;) {
        const all = Buffer.concat(received);
        if (all.length >= count) {
          received.length = 0;
          if (all.length > count) received.push(all.subarray(count));
          return all.subarray(0, count);
        }
        await new Promise<void>((r) => (wake = r));
      }
    };
    expect((await take(12)).toString()).toBe('RFB 003.008\n');
    ws.send(Buffer.from('RFB 003.008\n'));
    expect([...(await take(2))]).toEqual([1, 1]);
    ws.send(Buffer.from([1]));
    expect((await take(4)).readUInt32BE(0)).toBe(0);
    ws.send(Buffer.from([1])); // ClientInit, shared
    const init = await take(4);
    ws.close();
    return [init.readUInt16BE(0), init.readUInt16BE(2)];
  }

  /** The security types x11vnc offers over `conn`. */
  const securityTypes = (conn: Duplex) =>
    new Promise<number[]>((resolve, reject) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d: Buffer) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        if (all.length === 12) conn.write('RFB 003.008\n');
        if (all.length > 13 && all.length >= 13 + all[12]!) {
          conn.destroy();
          resolve([...all.subarray(13, 13 + all[12]!)]);
        }
      });
      conn.on('error', reject);
    });

  const refused = (port: number, host: string) =>
    new Promise<boolean>((resolve) => {
      const tcp = connect({ host, port });
      tcp.on('connect', () => {
        tcp.destroy();
        resolve(false);
      });
      tcp.on('error', () => resolve(true));
    });

  it('bridges the preview to x11vnc, logging in with the screen password', async () => {
    expect(await preview(N)).toEqual([1024, 768]);
  });

  it('keeps x11vnc behind a password on its unix socket, off TCP, and Chromium off TCP (S-7)', async () => {
    const info = screens.require(N);
    const offered = await securityTypes(screens.vnc(N));
    expect(offered).toContain(2);
    expect(offered).not.toContain(1);
    expect(await refused(info.vncPort, '127.0.0.1')).toBe(true);
    expect(await refused(info.vncPort, '::1')).toBe(true);
    expect(await refused(5900, '::1')).toBe(true);
    await expect(fetch(`http://127.0.0.1:${info.cdpPort}/json/version`)).rejects.toThrow();
  });

  it("saves Chromium's downloads where the Bot's commands and the file browser find them (K1)", async () => {
    const files = createServer((_req, res) =>
      res
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report-50.txt"',
        })
        .end('downloaded on screen 50'),
    );
    await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(files.address() as AddressInfo).port}/report`;
      const page = `<title>Files</title><a href="${url}">Get the report</a>`;
      await browser('navigate', { url: `data:text/html,${encodeURIComponent(page)}` });
      const snap = await browser('snapshot');
      const link = /link "Get the report" \[ref=(\w+)\]/.exec(snap.snapshot ?? '')?.[1];
      expect(link, snap.snapshot).toBeDefined();
      await browser('click', { ref: link });
      const file = path.join(downloadsDir(home), 'report-50.txt');
      const deadline = Date.now() + 15_000;
      while (!existsSync(file) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(await readFile(file, 'utf8')).toBe('downloaded on screen 50');
      const s = await lstat(file);
      if (privileged) expect([s.uid, s.gid, s.mode & 0o777]).toEqual([2000 + N, BOT_ID, 0o664]);

      // The Bot's command, another Bot's, the terminal's user and the file browser.
      for (const screen of [N, OTHER, undefined]) {
        const cat = await exec({
          ...(screen === undefined ? {} : { screen }),
          command: `cat ${file}`,
        });
        expect(cat, cat.stderr).toMatchObject({ exitCode: 0, stdout: 'downloaded on screen 50' });
      }
      const write = await exec({ command: `echo ', checked' >> ${file}` });
      expect(write.exitCode, write.stderr).toBe(0);
      const fs = await request('/fs/Downloads/report-50.txt');
      expect(await fs.text()).toBe('downloaded on screen 50, checked\n');
      const remove = await exec({ screen: N, command: `rm ${file}` });
      expect(remove.exitCode, remove.stderr).toBe(0);
    } finally {
      await new Promise((r) => files.close(r));
    }
  }, 60_000);

  describe('another screen (S-7)', () => {
    const xdotool = (env: NodeJS.ProcessEnv) =>
      run('xdotool', ['getmouselocation'], {
        env,
        ...(privileged ? { user: screens.x(N).user! } : {}),
      });

    it('starts a second screen', async () => {
      expect((await request('/screens', json({ n: OTHER }))).status).toBe(201);
    }, 60_000);

    it('refuses an X client without the screen cookie', async () => {
      await expect(xdotool({ DISPLAY: `:${10 + N}`, XAUTHORITY: '/dev/null' })).rejects.toThrow(
        /xdotool failed/,
      );
      await expect(xdotool(screens.xEnv(N))).resolves.toBeDefined();
    });

    it("refuses one screen's cookie on another screen", async () => {
      const env = { DISPLAY: `:${10 + OTHER}`, XAUTHORITY: screens.xEnv(N).XAUTHORITY };
      await expect(xdotool(env)).rejects.toThrow(/xdotool failed/);
    });

    it("lets a Bot's command drive its own screen and no other", async () => {
      const own = await exec({ screen: N, command: 'xdotool getmouselocation' });
      expect(own.exitCode, own.stderr).toBe(0);
      expect(own.stdout).toMatch(/^x:\d+ y:\d+/);
      const other = await exec({
        screen: N,
        command: `DISPLAY=:${10 + OTHER} xdotool getmouselocation`,
      });
      expect(other.exitCode).not.toBe(0);
      const none = await exec({ command: `DISPLAY=:${10 + N} xdotool getmouselocation` });
      expect(none.exitCode).not.toBe(0);
      const overridden = await exec({
        screen: N,
        command: 'xdotool getmouselocation',
        env: { DISPLAY: `:${10 + OTHER}` },
      });
      // The request's DISPLAY gives way to the screen's.
      expect(overridden.exitCode).toBe(0);
    });

    it.skipIf(!privileged)(
      "keeps another Bot's command from the screen's cookie, password and profile (as root)",
      async () => {
        const paths = screens.paths(N);
        for (const screen of [OTHER, undefined]) {
          const peek = await exec({
            ...(screen === undefined ? {} : { screen }),
            command: `cat ${paths.xauthority}; ls ${paths.run}; ls ${paths.profile}`,
          });
          expect(peek.stdout).toBe('');
          expect(peek.stderr.match(/Permission denied/g)).toHaveLength(3);
        }
        const id = await exec({ screen: N, command: 'id -u; id -G; test -r "$XAUTHORITY"' });
        expect(id).toMatchObject({ exitCode: 0, stdout: `${BOT_ID}\n${2000 + N}\n` });
        const ps = await exec({
          command: "ps -o uid= -C Xvfb,x11vnc | tr -d ' ' | sort -u | tr '\\n' ' '",
        });
        expect(ps.stdout.trim().split(' ').sort()).toEqual([`${2000 + N}`, `${2000 + OTHER}`]);
      },
    );

    it('stops the second screen', async () => {
      expect((await request(`/screens/${OTHER}`, { method: 'DELETE' })).status).toBe(204);
    }, 30_000);
  });

  describe('a display or VNC port taken first (S-7)', () => {
    const display = 10 + SQUATTED;
    const lock = `/tmp/.X${display}-lock`;
    const socket = `/tmp/.X11-unix/X${display}`;
    const cleanups: (() => Promise<unknown>)[] = [];

    afterAll(async () => {
      for (const c of cleanups) await c().catch(() => undefined);
    });

    it('starts the screen anyway, and the preview shows it, not the squatter', async () => {
      // A command (here the agent, as the bot user) takes the lock, the
      // socket path and the old VNC port before the screen starts.
      await writeFile(lock, `${String(process.pid).padStart(10)}\n`);
      cleanups.push(() => rm(lock, { force: true }));
      const fakeX = createNetServer((c) => c.destroy());
      await new Promise<void>((r) => fakeX.listen(socket, r));
      cleanups.push(() => new Promise((r) => fakeX.close(r)));
      const fakeVnc = await fakeVncServer('anything', 5900 + display);
      cleanups.push(() => new Promise((r) => fakeVnc.server.close(r)));

      const res = await request('/screens', json({ n: SQUATTED }));
      expect(res.status, await res.clone().text()).toBe(201);
      const shot = await request(`/screens/${SQUATTED}/screenshot`);
      expect(shot.headers.get('content-type')).toBe('image/png');
      expect(await preview(SQUATTED)).toEqual([1024, 768]);
      expect(fakeVnc.logins).toEqual({ ok: 0, failed: 0 });
      expect((await request(`/screens/${SQUATTED}`, { method: 'DELETE' })).status).toBe(204);
    }, 60_000);

    it('refuses to start rather than put a screen on a squatted abstract socket', async () => {
      // Root cannot take back an abstract socket name, so this stays a denial
      // of service; but nothing starts on a display Xvfb does not hold.
      const squatter = createNetServer((c) => c.destroy());
      await new Promise<void>((r) => squatter.listen(`\0/tmp/.X11-unix/X${10 + ABSTRACT}`, r));
      try {
        const res = await request('/screens', json({ n: ABSTRACT }));
        expect(res.status).toBe(500);
        expect(screens.get(ABSTRACT)).toBeUndefined();
      } finally {
        await new Promise((r) => squatter.close(r));
      }
    }, 60_000);
  });

  it('sets the wallpaper on the screen', async () => {
    const res = await request('/wallpaper', json({ hour: 22 }));
    expect(await res.json()).toEqual({ hour: 22, screens: [N] });
  });

  it('stops the screen', async () => {
    expect((await request(`/screens/${N}`, { method: 'DELETE' })).status).toBe(204);
    expect(existsSync(`/tmp/.X11-unix/X${10 + N}`)).toBe(false);
  }, 30_000);
});
