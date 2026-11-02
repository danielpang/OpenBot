import { execFileSync, spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CHROMIUM_UMASK,
  chromiumArgs,
  claimLegacyRemoval,
  defaultWaitForDisplay,
  downloadsDir,
  legacyProfilesDir,
  legacyProfilesMarker,
  profileDir,
  removeLegacyProfiles,
  ScreenManager,
  screenInfo,
  screenPaths,
  shareDownloads,
} from './screens.js';
import {
  FakeChild,
  fakeRun,
  fakeSpawn,
  fakeVncServer,
  program,
  tempHome,
  TEST_TOKEN,
} from './test-utils.js';
import { Users } from './users.js';
import { xauthority } from './xauth.js';

const root = process.getuid?.() === 0;
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops) await stop();
  stops = [];
});

async function manager(overrides: Partial<ConstructorParameters<typeof ScreenManager>[0]> = {}) {
  const home = await tempHome();
  const { spawn, spawned } = fakeSpawn();
  const ready: string[] = [];
  const runtimeDir = `${home}-run`;
  const stateDir = `${home}-state`;
  const screens = new ScreenManager({
    home,
    runtimeDir,
    stateDir,
    width: 1280,
    height: 800,
    chromiumPath: () => '/opt/chrome',
    spawn,
    clearStaleDisplay: async () => {},
    waitForDisplay: async () => {},
    waitForBrowser: async () => {},
    onDisplayReady: async (info) => {
      ready.push(info.display);
    },
    ...overrides,
  });
  stops.push(() => screens.stopAll());
  return { home, runtimeDir, stateDir, screens, spawned, ready };
}

// Children that exit when the screen user's `kill` names them.
function privileged() {
  const fake = fakeRun();
  const children = new Map<number, FakeChild>();
  const run: typeof fake.run = async (command, args, opts) => {
    if (command === 'kill') children.get(Number(args.at(-1)))?.exit(null, 'SIGTERM');
    return fake.run(command, args, opts);
  };
  const { spawn, spawned } = fakeSpawn();
  const tracked: typeof spawn = (command, args, opts) => {
    const child = spawn(command, args, opts);
    children.set(child.pid!, spawned.at(-1)!.child);
    return child;
  };
  return { run, calls: fake.calls, spawn: tracked, spawned };
}

describe('ScreenManager', () => {
  it('gives screen n display :10+n and its own ports', () => {
    expect(screenInfo(0, 800, 600)).toEqual({
      n: 0,
      display: ':10',
      width: 800,
      height: 600,
      vncPort: 5910,
      cdpPort: 9222,
    });
    expect(screenInfo(5, 800, 600)).toMatchObject({ display: ':15', vncPort: 5915, cdpPort: 9227 });
  });

  it('starts Xvfb, the window manager, x11vnc and Chromium on the display', async () => {
    const { screens, spawned, runtimeDir, stateDir, ready } = await manager();
    const { info, created } = await screens.start({ n: 1, width: 1024, height: 768 });
    expect(created).toBe(true);
    expect(info.display).toBe(':11');
    expect(spawned.map(program)).toEqual(['Xvfb', 'openbox', 'x11vnc', '/opt/chrome']);
    const paths = screenPaths(runtimeDir, stateDir, 1);
    expect(spawned[0]!.args).toEqual([
      ':11',
      '-screen',
      '0',
      '1024x768x24',
      '-auth',
      paths.xauthority,
      '-nolisten',
      'tcp',
      '-nolock',
      '-displayfd',
      '3',
    ]);
    expect(spawned[2]!.args).toEqual(expect.arrayContaining(['-display', ':11']));
    for (const s of spawned.slice(1)) expect(s.env.DISPLAY).toBe(':11');
    expect(spawned[3]!.args).toContain(`--user-data-dir=${profileDir(stateDir, 1)}`);
    expect(spawned[3]!.args).toContain('--remote-debugging-pipe');
    expect(spawned[3]!.env.HOME).toBe(paths.state);
    expect(ready).toEqual([':11']);
    expect(screens.list()).toEqual([info]);
  });

  it('keeps one Chromium profile per screen in a private directory, off the shared home (S-7)', async () => {
    const { screens, spawned, home, stateDir } = await manager();
    await screens.start({ n: 0 });
    await screens.start({ n: 1 });
    const profiles = spawned
      .filter((s) => program(s) === '/opt/chrome')
      .map((s) => s.args.find((a) => a.startsWith('--user-data-dir='))!.split('=')[1]!);
    expect(profiles).toEqual([profileDir(stateDir, 0), profileDir(stateDir, 1)]);
    expect(profiles.some((p) => p.startsWith(home + path.sep))).toBe(false);
    for (const profile of profiles) {
      expect((await stat(profile)).isDirectory()).toBe(true);
      expect((await stat(path.dirname(profile))).mode & 0o777).toBe(0o700);
    }
  });

  it('starts from an empty profile when asked for a fresh screen, restarting a running one', async () => {
    const { screens, stateDir, spawned } = await manager();
    await screens.start({ n: 0 });
    await writeFile(path.join(profileDir(stateDir, 0), 'Cookies'), 'old-bot');
    expect((await screens.start({ n: 0 })).created).toBe(false);
    const { created } = await screens.start({ n: 0, fresh: true });
    expect(created).toBe(true);
    expect(spawned.slice(0, 4).every((s) => s.child.signalCode === 'SIGTERM')).toBe(true);
    await expect(stat(path.join(profileDir(stateDir, 0), 'Cookies'))).rejects.toThrow();
    expect((await stat(profileDir(stateDir, 0))).isDirectory()).toBe(true);
  });

  it('clears a profile lock left by another container', async () => {
    const { screens, stateDir } = await manager();
    const profile = profileDir(stateDir, 0);
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'SingletonLock'), 'old-host-123');
    await screens.start({ n: 0 });
    await expect(stat(path.join(profile, 'SingletonLock'))).rejects.toThrow();
  });

  it('starts a screen once, even when asked twice at the same time', async () => {
    const { screens, spawned } = await manager();
    const [a, b] = await Promise.all([screens.start({ n: 0 }), screens.start({ n: 0 })]);
    expect(a.info).toEqual(b.info);
    expect(spawned).toHaveLength(4);
    expect((await screens.start({ n: 0 })).created).toBe(false);
  });

  it('stops clients before the X server', async () => {
    const { screens, spawned } = await manager();
    await screens.start({ n: 0 });
    const order: string[] = [];
    for (const s of spawned) s.child.once('exit', () => order.push(program(s)));
    expect(await screens.stop(0)).toBe(true);
    expect(order).toEqual(['/opt/chrome', 'x11vnc', 'openbox', 'Xvfb']);
    expect(screens.list()).toEqual([]);
    expect(await screens.stop(0)).toBe(false);
  });

  it('tears the screen down when Xvfb dies', async () => {
    const exits: string[] = [];
    const { screens, spawned } = await manager({ onExit: (_n, name) => exits.push(name) });
    await screens.start({ n: 0 });
    spawned[0]!.child.exit(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual(['xvfb']);
    expect(screens.get(0)).toBeUndefined();
    expect(spawned.slice(1).every((s) => s.child.signalCode === 'SIGTERM')).toBe(true);
  });

  it('relaunches Chromium when its window was closed', async () => {
    const { screens, spawned } = await manager();
    await screens.start({ n: 0 });
    await screens.ensureBrowser(0);
    expect(spawned).toHaveLength(4);
    spawned[3]!.child.exit(0);
    await screens.ensureBrowser(0);
    expect(spawned.map(program)).toEqual([
      'Xvfb',
      'openbox',
      'x11vnc',
      '/opt/chrome',
      '/opt/chrome',
    ]);
  });

  it("tells the cookie sync each time the screen's Chromium has started, once the screen runs (K1)", async () => {
    const opened: string[] = [];
    const { screens, spawned } = await manager({
      onBrowserReady: async (info) => {
        opened.push(`${info.n}:${screens.get(info.n) ? 'running' : 'not yet'}`);
      },
    });
    await screens.start({ n: 0 });
    await screens.ensureBrowser(0);
    expect(opened).toEqual(['0:running']);
    spawned[3]!.child.exit(0);
    await screens.ensureBrowser(0);
    expect(opened).toEqual(['0:running', '0:running']);
  });

  it('keeps the screen up when loading the cookies fails', async () => {
    const { screens } = await manager({
      onBrowserReady: async () => {
        throw new Error('no CDP');
      },
    });
    await screens.start({ n: 0 });
    expect(screens.get(0)).toBeDefined();
  });

  it('cleans up when a step fails to come up', async () => {
    const { screens, spawned } = await manager({
      waitForBrowser: async () => {
        throw new Error('Timed out waiting for Chromium');
      },
    });
    await expect(screens.start({ n: 0 })).rejects.toThrow('Timed out');
    expect(screens.get(0)).toBeUndefined();
    expect(spawned.every((s) => s.child.signalCode === 'SIGTERM')).toBe(true);
  });

  it('passes Chromium a persistent, debuggable, unsandboxed profile', () => {
    const args = chromiumArgs(screenInfo(0, 1280, 800), '/home/bot/p');
    expect(args).toEqual(
      expect.arrayContaining([
        '--user-data-dir=/home/bot/p',
        '--remote-debugging-pipe',
        '--no-sandbox',
      ]),
    );
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
});

describe('ScreenManager secrets (S-7)', () => {
  it('gives each screen its own x11vnc password in a private file, not on the command line', async () => {
    const { screens, spawned, runtimeDir } = await manager();
    await screens.start({ n: 0 });
    await screens.start({ n: 1 });
    const [a, b] = [screens.vncPassword(0)!, screens.vncPassword(1)!];
    expect(a).toMatch(/^[\w-]{8}$/);
    expect(b).toMatch(/^[\w-]{8}$/);
    expect(a).not.toBe(b);

    const vnc = spawned.find((s) => s.command === 'x11vnc')!;
    expect(vnc.args).not.toContain('-nopw');
    const file = path.join(runtimeDir, 'screens', 'screen-0', 'vnc.passwd');
    expect(vnc.args).toEqual(expect.arrayContaining(['-passwdfile', `rm:${file}`]));
    expect(await readFile(file, 'utf8')).toBe(`${a}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o710);
    for (const s of spawned) {
      expect(s.args.join(' ')).not.toContain(a);
      expect(Object.values(s.env)).not.toContain(a);
    }
    expect(JSON.stringify(screens.list())).not.toContain(a);
  });

  it('forgets the password and removes its file when the screen stops', async () => {
    const { screens, runtimeDir } = await manager();
    await screens.start({ n: 0 });
    await screens.stop(0);
    expect(screens.vncPassword(0)).toBeUndefined();
    await expect(
      stat(path.join(runtimeDir, 'screens', 'screen-0', 'vnc.passwd')),
    ).rejects.toThrow();
  });

  it('starts every screen process without the agent token', async () => {
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = TEST_TOKEN;
    try {
      const { screens, spawned } = await manager();
      await screens.start({ n: 0 });
      expect(spawned).toHaveLength(4);
      for (const s of spawned) {
        expect(s.env.OPENBOTS_AGENT_TOKEN).toBeUndefined();
        expect(Object.values(s.env)).not.toContain(TEST_TOKEN);
      }
    } finally {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    }
  });

  it('reaches Chromium only through its pipe, behind the screen secret', async () => {
    const { screens, spawned } = await manager();
    await screens.start({ n: 0 });
    const chromium = spawned.find((s) => program(s) === '/opt/chrome')!;
    const [fd3, fd4] = [chromium.child.stdio[3]!, chromium.child.stdio[4]!];
    const endpoint = screens.devtools(0);
    expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser$/);
    expect(endpoint.headers.authorization).toMatch(/^Bearer [\w-]{43}$/);
    await screens.start({ n: 1 });
    expect(screens.devtools(1).headers).not.toEqual(endpoint.headers);

    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(endpoint.url, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
      });
    expect(await status({})).toBe(401);
    expect(await status({ authorization: 'Bearer nope' })).toBe(401);
    expect(await status(screens.devtools(1).headers)).toBe(401);

    const ws = new WebSocket(endpoint.url, { headers: endpoint.headers });
    await new Promise((r) => ws.once('open', r));
    expect(await status(endpoint.headers)).toBe(409);
    const command = new Promise<string>((r) => fd3.once('data', (d: Buffer) => r(d.toString())));
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await command).toBe('{"id":1,"method":"Browser.getVersion"}\0');
    const reply = new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    fd4.write('{"id":1,"result"');
    fd4.write(':{}}\0');
    expect(await reply).toBe('{"id":1,"result":{}}');

    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    chromium.child.exit(0);
    expect(await closed).toBe(1001);
  });
});

describe('ScreenManager Xauthority (S-7)', () => {
  it('gives each screen its own cookie, and every X program on it that cookie', async () => {
    const { screens, spawned, runtimeDir, stateDir } = await manager();
    await screens.start({ n: 0 });
    await screens.start({ n: 1 });
    const [a, b] = [0, 1].map((n) => screenPaths(runtimeDir, stateDir, n));
    const [cookieA, cookieB] = [await readFile(a!.xauthority), await readFile(b!.xauthority)];
    // One FamilyWild entry for the screen's display, with a 16-byte cookie.
    expect(cookieA.subarray(0, 10)).toEqual(xauthority(10, Buffer.alloc(16)).subarray(0, 10));
    expect(cookieA).toHaveLength(xauthority(10, Buffer.alloc(16)).length);
    expect(cookieB.subarray(4, 8).toString()).toBe('\u0000\u000211');
    expect(cookieA.subarray(-16)).not.toEqual(cookieB.subarray(-16));
    expect((await stat(a!.xauthority)).mode & 0o777).toBe(0o640);

    const onScreen0 = spawned.slice(0, 4);
    expect(onScreen0[0]!.args).toEqual(expect.arrayContaining(['-auth', a!.xauthority]));
    expect(onScreen0[2]!.args).toEqual(expect.arrayContaining(['-auth', a!.xauthority]));
    for (const s of onScreen0.slice(1)) expect(s.env.XAUTHORITY).toBe(a!.xauthority);
    for (const s of spawned.slice(4)) expect(s.env.XAUTHORITY).toBe(b!.xauthority);
    expect(screens.x(1)).toEqual({
      env: { DISPLAY: ':11', XAUTHORITY: b!.xauthority },
      user: { uid: 2001, gid: 2001 },
    });
  });
});

describe('ScreenManager users (S-7)', () => {
  it('starts every screen process as the screen user, through the helper', async () => {
    const { run, calls, spawn, spawned } = privileged();
    const { screens, runtimeDir, stateDir } = await manager({
      users: new Users('/usr/local/libexec/openbots/runas'),
      run,
      spawn,
    });
    await screens.start({ n: 3 });
    expect(spawned).toHaveLength(4);
    for (const s of spawned) {
      expect(s.command).toBe('/usr/local/libexec/openbots/runas');
      expect(s.args.slice(0, 3)).toEqual(['2003', '2003', '--']);
      // The agent changes to a directory it may enter before the helper drops.
      expect(s.cwd).toBe('/');
    }
    expect(spawned.map((s) => s.args[3])).toEqual(['Xvfb', 'openbox', 'x11vnc', '/bin/sh']);
    expect(spawned.map(program)).toEqual(['Xvfb', 'openbox', 'x11vnc', '/opt/chrome']);

    // The screen user writes its own files; the secrets go over stdin.
    const prepare = calls.find((c) => c.command === '/bin/sh')!;
    const paths = screenPaths(runtimeDir, stateDir, 3);
    expect(prepare.user).toEqual({ uid: 2003, gid: 2003 });
    expect(prepare.args.slice(3)).toEqual([paths.run, paths.state, '0']);
    const input = Buffer.from(prepare.input as Uint8Array);
    expect(input.subarray(0, 9).toString()).toBe(`${screens.vncPassword(3)}\n`);
    expect(input.subarray(9).subarray(0, 8)).toEqual(
      xauthority(13, Buffer.alloc(16)).subarray(0, 8),
    );
    expect(prepare.args.join(' ')).not.toContain(screens.vncPassword(3));
  });

  it('stops the screen processes as the screen user, which may signal them', async () => {
    const { run, calls, spawn, spawned } = privileged();
    const { screens } = await manager({ users: new Users('/runas'), run, spawn });
    await screens.start({ n: 2 });
    expect(await screens.stop(2)).toBe(true);
    const kills = calls.filter((c) => c.command === 'kill');
    expect(kills.map((c) => c.args)).toEqual(
      [3, 2, 1, 0].map((i) => ['-s', 'TERM', String(spawned[i]!.child.pid)]),
    );
    expect(kills.every((c) => c.user?.uid === 2002 && c.user.gid === 2002)).toBe(true);
    expect(spawned.every((s) => s.child.killedWith.length === 0)).toBe(true);
  });
});

describe('ScreenManager downloads (K1, S-7)', () => {
  it("saves downloads to the shared directory, keeping the profile's other settings", async () => {
    const { screens, spawned, home, stateDir } = await manager();
    const paths = screenPaths(`${home}-run`, stateDir, 0);
    await mkdir(path.dirname(paths.preferences), { recursive: true });
    await writeFile(paths.preferences, JSON.stringify({ homepage: 'kept', download: { x: 1 } }));
    await screens.start({ n: 0 });
    expect(JSON.parse(await readFile(paths.preferences, 'utf8'))).toEqual({
      homepage: 'kept',
      download: {
        x: 1,
        default_directory: downloadsDir(home),
        prompt_for_download: false,
        directory_upgrade: true,
      },
      savefile: { default_directory: downloadsDir(home) },
    });
    expect((await stat(paths.preferences)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.profile)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.state)).mode & 0o777).toBe(0o700);

    // Chromium starts under a umask that leaves its downloads group-writable.
    const chromium = spawned.find((s) => program(s) === '/opt/chrome')!;
    expect([chromium.command, ...chromium.args.slice(0, 3)]).toEqual([
      '/bin/sh',
      '-c',
      'umask 002 && exec "$0" "$@"',
      '/opt/chrome',
    ]);
  });

  it('writes the download setting into a fresh profile too, as the screen user', async () => {
    const { run, calls, spawn } = privileged();
    const { screens, home } = await manager({ users: new Users('/runas'), run, spawn });
    await screens.start({ n: 4, fresh: true });
    const prefs = calls.find((c) => c.command === process.execPath)!;
    expect(prefs.user).toEqual({ uid: 2004, gid: 2004 });
    expect(prefs.args.slice(2)).toEqual([screens.paths(4).preferences, downloadsDir(home)]);
  });

  it('makes the downloads directory setgid and sticky, open to every screen user', async () => {
    const home = await tempHome();
    await chmod(home, 0o750);
    await shareDownloads(home);
    const dir = await lstat(downloadsDir(home));
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o7777).toBe(0o3777);
    expect(dir.uid).toBe(process.geteuid!());
    // Enterable by the screens' users, not listable.
    expect((await lstat(home)).mode & 0o777).toBe(0o751);
    // Again, over an existing directory and its files.
    await writeFile(path.join(downloadsDir(home), 'kept.pdf'), 'pdf');
    await chmod(downloadsDir(home), 0o700);
    await shareDownloads(home);
    expect((await lstat(downloadsDir(home))).mode & 0o7777).toBe(0o3777);
    expect(await readFile(path.join(downloadsDir(home), 'kept.pdf'), 'utf8')).toBe('pdf');
  });

  it('refuses a downloads path that is not a directory', async () => {
    const home = await tempHome();
    await symlink('/etc', downloadsDir(home));
    await expect(shareDownloads(home)).rejects.toThrow(/not a directory/);
    expect((await lstat('/etc')).mode & 0o002).toBe(0);
  });

  it.skipIf(!root)(
    "gives the bot user a screen user's downloads to read and write (as root)",
    async () => {
      const home = await tempHome();
      await chown(home, 1000, 1000);
      await chmod(home, 0o750);
      const asUser = (uid: number, gid: number, script: string) =>
        execFileSync(process.execPath, ['-e', script], {
          uid,
          gid,
          encoding: 'utf8',
          cwd: '/',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      // As the agent does once it is the bot user, which owns the home.
      await shareDownloads(home);
      await chown(downloadsDir(home), 1000, 1000);
      expect((await lstat(downloadsDir(home))).mode & 0o7777).toBe(0o3777);
      const file = path.join(downloadsDir(home), 'report.txt');
      asUser(
        2003,
        2003,
        `process.umask(0o${CHROMIUM_UMASK});
        require('node:fs').writeFileSync(${JSON.stringify(file)}, 'from screen 3')`,
      );
      const s = await lstat(file);
      expect([s.uid, s.gid, s.mode & 0o777]).toEqual([2003, 1000, 0o664]);
      const bot = `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(file)}, ', edited');
        process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, 'utf8'))`;
      expect(asUser(1000, 1000, bot)).toBe('from screen 3, edited');
      // Another screen's user may read it, as anyone may, but not remove it.
      expect(() =>
        asUser(2004, 2004, `require('node:fs').unlinkSync(${JSON.stringify(file)})`),
      ).toThrow();
      asUser(1000, 2007, `require('node:fs').unlinkSync(${JSON.stringify(file)})`);
    },
  );

  it('removes the old profiles once per computer, marked on the state volume', async () => {
    const stateDir = await tempHome();
    expect(await claimLegacyRemoval(stateDir)).toBe(true);
    expect((await stat(legacyProfilesMarker(stateDir))).mode & 0o777).toBe(0o600);
    expect(await claimLegacyRemoval(stateDir)).toBe(false);
    await expect(claimLegacyRemoval(path.join(stateDir, 'missing'))).rejects.toThrow(/ENOENT/);
  });

  it('deletes the profiles left on the shared home before 8.4j', async () => {
    const home = await tempHome();
    const old = path.join(legacyProfilesDir(home), 'screen-0', 'Default');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'Cookies'), 'session');
    await writeFile(path.join(home, '.config', 'openbots', 'kept'), 'other');
    expect(await removeLegacyProfiles(home)).toBe(true);
    await expect(lstat(legacyProfilesDir(home))).rejects.toThrow();
    expect(await readFile(path.join(home, '.config', 'openbots', 'kept'), 'utf8')).toBe('other');
    expect(await removeLegacyProfiles(home)).toBe(false);
  });
});

describe('ScreenManager x11vnc socket (S-7)', () => {
  it('puts x11vnc on a unix socket in the screen directory, on no TCP port', async () => {
    const { screens, spawned, runtimeDir, stateDir } = await manager();
    const paths = screenPaths(runtimeDir, stateDir, 1);
    await mkdir(paths.run, { recursive: true });
    await writeFile(paths.vncSocket, 'left from the last run');
    await screens.start({ n: 1 });
    const vnc = spawned.find((s) => s.command === 'x11vnc')!;
    expect(vnc.args).toEqual(
      expect.arrayContaining(['-unixsock', paths.vncSocket, '-rfbport', '0', '-rfbportv6', '0']),
    );
    expect(vnc.args).not.toContain('-localhost');
    expect(vnc.args).not.toContain(String(screens.get(1)!.vncPort));
    expect(path.dirname(paths.vncSocket)).toBe(paths.run);
    // The old socket is gone, so x11vnc can listen.
    await expect(lstat(paths.vncSocket)).rejects.toThrow();
  });

  it("connects the preview to x11vnc's socket", async () => {
    const { screens, runtimeDir, stateDir } = await manager();
    await screens.start({ n: 2 });
    const fake = await fakeVncServer('pw', screenPaths(runtimeDir, stateDir, 2).vncSocket);
    stops.push(() => new Promise<void>((r) => fake.server.close(() => r())));
    const conn = screens.vnc(2);
    expect(await greeting(conn)).toBe('RFB 003.008\n');
    conn.destroy();
    expect(() => screens.vnc(5)).toThrow(/not running/);
  });

  it('reaches the socket through a relay run as the screen user', async () => {
    const { run, spawn, spawned } = privileged();
    // The relay for real, without the helper; the screen's processes faked.
    const relays: ChildProcess[] = [];
    const spawnBoth: typeof spawn = (command, args, opts) => {
      if (args[3] !== process.execPath) return spawn(command, args, opts);
      const relay = spawnChild(args[3], args.slice(4), opts);
      relays.push(relay);
      return relay;
    };
    const { screens, runtimeDir, stateDir } = await manager({
      users: new Users('/runas'),
      run,
      spawn: spawnBoth,
    });
    await screens.start({ n: 3 });
    const socket = screenPaths(runtimeDir, stateDir, 3).vncSocket;
    await mkdir(path.dirname(socket), { recursive: true });
    const fake = await fakeVncServer('pw', socket);
    stops.push(() => new Promise<void>((r) => fake.server.close(() => r())));
    const conn = screens.vnc(3);
    expect(spawned).toHaveLength(4);
    expect(relays).toHaveLength(1);
    expect(relays[0]!.spawnargs.slice(-1)).toEqual([socket]);
    expect(await greeting(conn)).toBe('RFB 003.008\n');
    conn.destroy();
    await new Promise((r) => (relays[0]!.exitCode !== null ? r(null) : relays[0]!.once('exit', r)));
  });

  it('starts the relay through the helper as the screen user, from the root directory', async () => {
    const { run, spawn, spawned } = privileged();
    const { screens } = await manager({ users: new Users('/runas'), run, spawn });
    await screens.start({ n: 3 });
    screens.vnc(3).on('error', () => {});
    const relay = spawned.at(-1)!;
    expect(relay.command).toBe('/runas');
    expect(relay.args.slice(0, 5)).toEqual(['2003', '2003', '--', process.execPath, '-e']);
    expect(relay.args.at(-1)).toBe(screens.paths(3).vncSocket);
    expect(relay.cwd).toBe('/');
  });
});

describe('ScreenManager X display (S-7)', () => {
  it('clears the display socket as the agent without the helper', async () => {
    const { run, calls } = fakeRun();
    const { screens } = await manager({ run, clearStaleDisplay: undefined });
    await screens.start({ n: 5 });
    expect(calls.find((c) => c.command === 'rm')!.args).toEqual(['-f', '/tmp/.X11-unix/X15']);
  });

  it('clears the display socket as root through the helper before Xvfb starts', async () => {
    const { run, spawn, spawned } = privileged();
    const { screens } = await manager({
      users: new Users('/runas'),
      run,
      spawn,
      clearStaleDisplay: undefined,
    });
    const started = screens.start({ n: 5 });
    await waitFor(() => spawned.length === 1);
    expect([spawned[0]!.command, ...spawned[0]!.args]).toEqual(['/runas', '--clear-display', '5']);
    expect(spawned[0]!.cwd).toBe('/');
    spawned[0]!.child.exit(0);
    await started;
    expect(spawned.slice(1).map((s) => s.args[3])).toEqual([
      'Xvfb',
      'openbox',
      'x11vnc',
      '/bin/sh',
    ]);
  });

  it('does not start Xvfb when the display cannot be cleared', async () => {
    const { run, spawn, spawned } = privileged();
    const { screens } = await manager({
      users: new Users('/runas'),
      run,
      spawn,
      clearStaleDisplay: undefined,
    });
    const started = screens.start({ n: 5 });
    await waitFor(() => spawned.length === 1);
    spawned[0]!.child.exit(126);
    await expect(started).rejects.toThrow(/Could not clear :15/);
    expect(spawned).toHaveLength(1);
  });

  it('counts the display as up only once Xvfb writes its number', async () => {
    const info = screenInfo(3, 800, 600);
    const xvfb = () => {
      const child = new FakeChild();
      child.stdio = [null, null, null, new PassThrough()];
      return child;
    };
    const up = xvfb();
    const ready = defaultWaitForDisplay(info, up as unknown as ChildProcess);
    up.stdio[3]!.write('1');
    up.stdio[3]!.write('3\n');
    await expect(ready).resolves.toBeUndefined();

    // Xvfb that cannot listen, say because a command holds its socket, exits.
    const refused = xvfb();
    const waiting = defaultWaitForDisplay(info, refused as unknown as ChildProcess);
    refused.exit(1);
    await expect(waiting).rejects.toThrow(/did not start on :13/);

    const other = xvfb();
    const wrong = defaultWaitForDisplay(info, other as unknown as ChildProcess);
    other.stdio[3]!.write('14\n');
    await expect(wrong).rejects.toThrow(/did not start/);
  });
});

/** The first 12 bytes a VNC server sends. */
function greeting(conn: Duplex): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    conn.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 12) resolve(got.subarray(0, 12).toString());
    });
    conn.on('error', reject);
  });
}

async function waitFor(check: () => boolean) {
  while (!check()) await new Promise((r) => setTimeout(r, 1));
}
