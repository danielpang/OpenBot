import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createApp } from './app.js';
import { BrowserPool } from './browser.js';
import type { CookieSync } from './cookies.js';
import type { Run, SpawnDaemon } from './proc.js';
import type { Identity, Users } from './users.js';
import { ByteReader, vncAuthResponse } from './rfb.js';
import { ScreenManager } from './screens.js';
import { Wallpaper } from './wallpaper.js';

// Stand-ins for the X programs, so the agent's handlers can be tested
// without a display.

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  child: FakeChild;
}

export class FakeChild extends EventEmitter {
  static nextPid = 4000;
  pid: number | undefined = FakeChild.nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals[] = [];
  /** A PassThrough for each `'pipe'` in the spawn's stdio; Chromium's fds 3 and 4. */
  stdio: (PassThrough | null)[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    for (const pipe of this.stdio) pipe?.destroy();
    this.emit('exit', code, signal);
  }
}

/**
 * The program a spawned process runs in the end: past the helper's
 * `UID GID --` and the `umask` wrapper Chromium starts under.
 */
export function program(s: Pick<Spawned, 'command' | 'args'>): string {
  let argv = [s.command, ...s.args];
  if (argv[3] === '--') argv = argv.slice(4);
  if (argv[0] === '/bin/sh' && argv[2]?.startsWith('umask ')) argv = argv.slice(3);
  return argv[0]!;
}

export function fakeSpawn(): { spawn: SpawnDaemon; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const spawn: SpawnDaemon = (command, args, opts) => {
    const child = new FakeChild();
    if (Array.isArray(opts.stdio))
      child.stdio = opts.stdio.map((s) => (s === 'pipe' ? new PassThrough() : null));
    spawned.push({
      command,
      args,
      env: opts.env ?? {},
      ...(typeof opts.cwd === 'string' ? { cwd: opts.cwd } : {}),
      child,
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, spawned };
}

export interface RunCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  user?: Identity;
  input?: Uint8Array | string;
}

export function fakeRun(stdout: (call: RunCall) => Buffer | string = () => ''): {
  run: Run;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const run: Run = async (command, args, opts) => {
    const call = { command, args, env: opts?.env, user: opts?.user, input: opts?.input };
    calls.push(call);
    const out = stdout(call);
    return { stdout: typeof out === 'string' ? Buffer.from(out) : out, stderr: '' };
  };
  return { run, calls };
}

export async function tempHome(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), 'openbots-home-')));
}

/** The app over a temporary home, fake X programs and a fake `run`. */
export async function createTestAgent(
  opts: {
    run?: Run;
    home?: string;
    users?: Users;
    /** The cookie sync, made from the screens and browsers; none when unset. */
    cookies?: (parts: { screens: ScreenManager; browsers: BrowserPool }) => CookieSync;
  } = {},
) {
  const home = opts.home ?? (await tempHome());
  const { spawn, spawned } = fakeSpawn();
  const fake = fakeRun();
  const run = opts.run ?? fake.run;
  const screens = new ScreenManager({
    home,
    width: 1280,
    height: 800,
    runtimeDir: `${home}-run`,
    stateDir: `${home}-state`,
    chromiumPath: () => '/opt/chromium/chrome',
    spawn,
    clearStaleDisplay: async () => {},
    waitForDisplay: async () => {},
    waitForBrowser: async () => {},
  });
  const wallpaper = new Wallpaper({
    run,
    targets: () => screens.list(),
    place: (t) => ({ file: screens.paths(t.n).wallpaper, x: screens.x(t.n) }),
  });
  const browsers = new BrowserPool((info) => screens.devtools(info.n));
  const cookies = opts.cookies?.({ screens, browsers });
  const app = createApp({
    token: TEST_TOKEN,
    home,
    run,
    screens,
    browsers,
    wallpaper,
    ...(cookies ? { cookies } : {}),
    ...(opts.users ? { users: opts.users } : {}),
  });
  const request = (pathname: string, init: RequestInit = {}) =>
    app.request(pathname, {
      ...init,
      headers: { authorization: `Bearer ${TEST_TOKEN}`, ...init.headers },
    });
  return { app, home, screens, browsers, cookies, spawned, calls: fake.calls, request };
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

/**
 * A stand-in x11vnc: RFB 3.8 with VNC authentication against `password`,
 * then a fake ServerInit, then it echoes. `logins` counts each outcome. It
 * listens on a unix socket, as x11vnc does (`at`, or a new one), or on the
 * TCP port `at` of 127.0.0.1.
 */
export async function fakeVncServer(password: string, at?: number | string) {
  const logins = { ok: 0, failed: 0 };
  const server = createTcpServer((socket) => {
    const reader = new ByteReader();
    socket.on('data', (d: Buffer) => reader.push(d));
    socket.on('error', () => {});
    socket.on('close', () => reader.fail(new Error('closed')));
    void (async () => {
      socket.write('RFB 003.008\n');
      await reader.read(12);
      socket.write(Buffer.from([1, 2]));
      if ((await reader.read(1))[0] !== 2) return socket.destroy();
      const challenge = randomBytes(16);
      socket.write(challenge);
      const response = await reader.read(16);
      if (!response.equals(vncAuthResponse(password, challenge))) {
        logins.failed++;
        const why = Buffer.from('Authentication failed');
        const len = Buffer.alloc(4);
        len.writeUInt32BE(why.length);
        socket.end(Buffer.concat([Buffer.from([0, 0, 0, 1]), len, why]));
        return;
      }
      logins.ok++;
      socket.write(Buffer.from([0, 0, 0, 0]));
      await reader.read(1); // ClientInit
      socket.write(Buffer.from([0x04, 0x00, 0x03, 0x00])); // 1024x768, the rest left out
      const rest = reader.rest();
      if (rest.length > 0) socket.write(rest);
      socket.removeAllListeners('data');
      socket.pipe(socket);
    })().catch(() => socket.destroy());
  });
  const socket = typeof at === 'string' ? at : path.join(await tempHome(), 'vnc.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof at === 'number') server.listen(at, '127.0.0.1', resolve);
    else server.listen(socket, resolve);
  });
  return { socket, server, logins };
}
