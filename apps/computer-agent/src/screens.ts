import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { Duplex, type Readable, type Writable } from 'node:stream';
import { childEnv } from './config.js';
import { DevToolsBridge, type DevToolsEndpoint } from './devtools.js';
import { AgentError } from './errors.js';
import {
  spawnDaemon as defaultSpawn,
  run as defaultRun,
  type Run,
  type RunOptions,
  type SpawnDaemon,
} from './proc.js';
import type { ScreenInfo, StartScreen } from './protocol.js';
import { vncPassword } from './rfb.js';
import { screenIdentity, UNPRIVILEGED, type Users } from './users.js';
import { xauthority, xCookie } from './xauth.js';

// One screen per Bot (plan 9.1, K2): Xvfb on display `:10+n`, a window
// manager, x11vnc for the preview, and Chromium with its own profile in the
// agent's persistent state directory, so Bots browse in parallel. Their
// logins are shared all the same: cookies.ts syncs every profile's cookies
// through one store (K1), loaded each time a screen's Chromium starts.
//
// Each screen runs as its own user (users.ts, S-7), so another Bot's command
// can neither read its files nor touch its processes. Its X server takes only
// clients with its cookie, in an Xauthority file that the screen's user owns
// and its own Bot's commands may read. x11vnc takes a random per-screen
// password, which /vnc/:n answers for the client (rfb.ts), and Chromium has
// no DevTools port, only a pipe to the agent (devtools.ts). The Chromium
// profile is in a directory only the screen's user can enter, not on the
// shared home. The agent cannot enter these directories either, so it writes
// them through a short script run as the screen's user, with the secrets on
// its stdin.
//
// A command cannot take what a screen needs before it starts (S-7), but for
// the display's abstract socket, which only makes the start fail. x11vnc
// listens on a unix socket in the screen's directory, not on a TCP port, and
// the agent reaches it through a relay run as the screen's user. Xvfb runs
// without a lock file, the helper clears whatever stands at its socket path
// before it starts, and the screen counts as up only once Xvfb itself says
// it listens. Downloads go to a shared directory on the home (K1), so the
// Bot's commands and the file browser see them.

export const DISPLAY_BASE = 10;
const VNC_PORT_BASE = 5900;
const CDP_PORT_BASE = 9222;
const STOP_GRACE_MS = 3000;

// `vncPort` and `cdpPort` stay in ScreenInfo for the server's `bot_screens`;
// neither x11vnc nor Chromium listens on them any more.
export function screenInfo(n: number, width: number, height: number): ScreenInfo {
  const display = DISPLAY_BASE + n;
  return {
    n,
    display: `:${display}`,
    width,
    height,
    vncPort: VNC_PORT_BASE + display,
    cdpPort: CDP_PORT_BASE + n,
  };
}

/** Where screen `n` keeps its files; privileges.ts creates the directories as root. */
export function screenPaths(runtimeDir: string, stateDir: string, n: number) {
  const run = path.join(runtimeDir, 'screens', `screen-${n}`);
  const state = path.join(stateDir, 'screens', `screen-${n}`);
  return {
    /** Mode 0710, the screen's user and group: the cookie, password and wallpaper. */
    run,
    xauthority: path.join(run, 'Xauthority'),
    vncPassword: path.join(run, 'vnc.passwd'),
    /** x11vnc's socket; only the screen's user may connect. */
    vncSocket: path.join(run, 'vnc.sock'),
    wallpaper: path.join(run, 'wallpaper.png'),
    /** Mode 0700, the screen's user only, persistent: Chromium's HOME. */
    state,
    profile: path.join(state, 'profile'),
    /** Chromium's settings for the profile, where the download directory is. */
    preferences: path.join(state, 'profile', 'Default', 'Preferences'),
  };
}

/** Chromium's profile for screen `n`; one per screen, kept on the state volume. */
export const profileDir = (stateDir: string, n: number) => screenPaths('', stateDir, n).profile;

/** Where every screen's Chromium saves downloads: on the shared home. */
export const downloadsDir = (home: string) => path.join(home, 'Downloads');

/** Where the profiles were before 8.4j, on the shared home. */
export const legacyProfilesDir = (home: string) =>
  path.join(home, '.config', 'openbots', 'chromium');

/**
 * As the bot user, before any screen starts: makes the downloads directory
 * one every screen's user may write and the bot user owns. Setgid, so each
 * download is in the bot user's group, which Chromium's umask (`CHROMIUM_UMASK`)
 * lets write it; sticky, so one screen's user cannot remove another's. The
 * home itself becomes enterable, not listable, by the screens' users.
 */
export async function shareDownloads(home: string): Promise<void> {
  const dir = downloadsDir(home);
  await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} is not a directory`);
  await chmod(dir, 0o3777);
  const mode = (await lstat(home)).mode & 0o7777;
  if ((mode & 0o001) === 0) await chmod(home, mode | 0o001);
}

/** Marks the removal of the old profiles as done, on the state volume. */
export const legacyProfilesMarker = (stateDir: string) =>
  path.join(stateDir, 'legacy-profiles-removed');

/**
 * Claims the one removal of the old profiles: creates its marker, and is
 * true only when the marker was not there yet. In the image it runs as root,
 * before the drop, since the state directory is root's; the removal itself
 * then runs as the bot user, which owns the home. The marker goes first, so a
 * directory of that name made later on the home is never touched.
 */
export async function claimLegacyRemoval(stateDir: string): Promise<boolean> {
  try {
    await writeFile(legacyProfilesMarker(stateDir), `${new Date().toISOString()}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Deletes the Chromium profiles from before 8.4j, which kept each Bot's
 * session cookies on the shared home. Their screens now start logged out.
 * main.ts calls it once per computer (`claimLegacyRemoval`).
 */
export async function removeLegacyProfiles(home: string): Promise<boolean> {
  const dir = legacyProfilesDir(home);
  const found = await lstat(dir).then(
    () => true,
    () => false,
  );
  if (found) await rm(dir, { recursive: true, force: true });
  return found;
}

// Run as the screen's user. Arguments: the run and state directories, and 1
// for an empty profile. Stdin: the x11vnc password on a line, then the
// Xauthority file. `read` and `printf` are built in, so the password is in
// no argv.
const PREPARE_SCRIPT = `set -eu
umask 077
run=$1 state=$2 fresh=$3
mkdir -p "$run" "$state"
chmod 710 "$run"
chmod 700 "$state"
if [ "$fresh" = 1 ]; then rm -rf "$state/profile"; fi
mkdir -p "$state/profile"
chmod 700 "$state/profile"
# A new container has a new hostname, and Chromium refuses a profile whose
# lock names another host.
rm -f "$state/profile/SingletonLock" "$state/profile/SingletonSocket" "$state/profile/SingletonCookie"
# x11vnc will not listen where an old socket is.
rm -f "$run/vnc.sock"
IFS= read -r password
printf '%s\\n' "$password" > "$run/vnc.passwd"
cat > "$run/Xauthority"
chmod 640 "$run/Xauthority"`;

// Run as the screen's user with node. Arguments: Chromium's Preferences file
// and the downloads directory. Chromium keeps the other settings there, so
// this changes only where downloads go, and that Chromium does not ask.
const PREFERENCES_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const [file, dir] = process.argv.slice(1);
let prefs = {};
try {
  prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}
if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) prefs = {};
prefs.download = { ...prefs.download, default_directory: dir, prompt_for_download: false, directory_upgrade: true };
prefs.savefile = { ...prefs.savefile, default_directory: dir };
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file + '.openbots', JSON.stringify(prefs), { mode: 0o600 });
fs.renameSync(file + '.openbots', file);`;

// Run as the screen's user with node. Argument: x11vnc's socket. Pipes its
// stdin and stdout to the socket, which the agent may not reach itself.
const VNC_RELAY_SCRIPT = `const socket = require('node:net').connect(process.argv[1]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));`;

/** Downloads are 0664, so the bot user's group, which they are in, may write them. */
export const CHROMIUM_UMASK = '002';

export function chromiumArgs(info: ScreenInfo, profile: string): string[] {
  return [
    `--user-data-dir=${profile}`,
    // CDP on fds 3 and 4, which only the agent holds; no port to reach.
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    // The container is the sandbox: it drops every capability, which
    // Chromium's own namespace sandbox needs.
    '--no-sandbox',
    '--test-type',
    '--password-store=basic',
    '--start-maximized',
    `--window-size=${info.width},${info.height}`,
    'about:blank',
  ];
}

export interface ScreenDeps {
  home: string;
  /** Scratch space; each screen's cookie and password go in its directory under it. */
  runtimeDir: string;
  /** Persistent; each screen's Chromium profile goes in its directory under it. */
  stateDir: string;
  width: number;
  height: number;
  chromiumPath: () => string;
  /** Who the screen processes run as; the agent itself without a helper. */
  users?: Users;
  spawn?: SpawnDaemon;
  /** Short commands as a screen's user: preparing its files, signalling its processes. */
  run?: Run;
  clearStaleDisplay?: (info: ScreenInfo) => Promise<void>;
  /** Resolves once the X server for `display`, `xvfb`, accepts connections. */
  waitForDisplay?: (info: ScreenInfo, xvfb: ChildProcess) => Promise<void>;
  /** Resolves once Chromium answers on its DevTools pipe. */
  waitForBrowser?: (info: ScreenInfo, devtools: DevToolsBridge) => Promise<void>;
  /** Called after the display is up, e.g. to set the wallpaper. */
  onDisplayReady?: (info: ScreenInfo) => Promise<void>;
  /**
   * Called each time the screen's Chromium has started and the screen is
   * running, e.g. to load the shared cookies (cookies.ts). A failure there
   * leaves the screen up.
   */
  onBrowserReady?: (info: ScreenInfo) => Promise<void>;
  onExit?: (n: number, name: string, code: number | null) => void;
}

interface Screen {
  info: ScreenInfo;
  procs: Map<string, ChildProcess>;
  stopping: boolean;
  /** x11vnc's password; the agent's /vnc/:n bridge logs in with it. */
  vncPassword: string;
  devtools?: DevToolsBridge;
}

const xSocket = (info: ScreenInfo) => `/tmp/.X11-unix/X${info.display.slice(1)}`;

/**
 * Xvfb writes its display number to fd 3 (`-displayfd`) once it listens. A
 * socket file is no sign of that: a command may have made it, and Xvfb exits
 * when it cannot listen.
 */
export const defaultWaitForDisplay = (info: ScreenInfo, xvfb: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    const fd = xvfb.stdio[3] as Readable | null | undefined;
    if (!fd) return reject(new Error('Xvfb has no -displayfd pipe'));
    let written = '';
    const fail = () =>
      reject(new AgentError(500, 'START_FAILED', `Xvfb did not start on ${info.display}`));
    const timer = setTimeout(
      () => reject(new AgentError(500, 'START_TIMEOUT', `Timed out waiting for ${info.display}`)),
      15_000,
    );
    fd.setEncoding('utf8');
    fd.on('data', (d: string) => {
      written += d;
      if (!written.includes('\n')) return;
      clearTimeout(timer);
      if (written.trim() === info.display.slice(1)) resolve();
      else fail();
    });
    fd.on('error', () => undefined);
    xvfb.once('exit', () => {
      clearTimeout(timer);
      fail();
    });
  });

export const defaultWaitForBrowser = (_info: ScreenInfo, devtools: DevToolsBridge) =>
  devtools.ready();

export class ScreenManager {
  private readonly screens = new Map<number, Screen>();
  private readonly starting = new Map<number, Promise<ScreenInfo>>();
  private readonly spawn: SpawnDaemon;
  private readonly run: Run;
  private readonly users: Users;

  constructor(private readonly deps: ScreenDeps) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.run = deps.run ?? defaultRun;
    this.users = deps.users ?? UNPRIVILEGED;
  }

  paths(n: number) {
    return screenPaths(this.deps.runtimeDir, this.deps.stateDir, n);
  }

  /** What a program on screen `n` needs to reach its display. */
  xEnv(n: number): { DISPLAY: string; XAUTHORITY: string } {
    return { DISPLAY: `:${DISPLAY_BASE + n}`, XAUTHORITY: this.paths(n).xauthority };
  }

  /** How the agent's own X commands (xdotool, import, feh) run on screen `n`: as its user. */
  x(n: number): RunOptions {
    return { env: this.xEnv(n), user: screenIdentity(n) };
  }

  list(): ScreenInfo[] {
    return [...this.screens.values()].filter((s) => !s.stopping).map((s) => s.info);
  }

  get(n: number): ScreenInfo | undefined {
    const s = this.screens.get(n);
    return s && !s.stopping ? s.info : undefined;
  }

  /** x11vnc's password for running screen `n`. */
  vncPassword(n: number): string | undefined {
    const s = this.screens.get(n);
    return s && !s.stopping ? s.vncPassword : undefined;
  }

  /** Where Playwright reaches the Chromium of running screen `n`. */
  devtools(n: number): DevToolsEndpoint {
    const devtools = this.screens.get(n)?.devtools;
    if (!devtools) throw new AgentError(404, 'SCREEN_NOT_RUNNING', `Screen ${n} is not running`);
    return devtools.endpoint();
  }

  require(n: number): ScreenInfo {
    const info = this.get(n);
    if (!info) throw new AgentError(404, 'SCREEN_NOT_RUNNING', `Screen ${n} is not running`);
    return info;
  }

  /**
   * Starts screen `n`; a running screen is returned as is, unless `fresh`
   * asks for an empty profile, which restarts it.
   */
  async start(req: StartScreen): Promise<{ info: ScreenInfo; created: boolean }> {
    const running = this.get(req.n);
    if (running && !req.fresh) return { info: running, created: false };
    if (running) await this.stop(req.n);
    let pending = this.starting.get(req.n);
    if (!pending) {
      pending = this.launch(req).finally(() => this.starting.delete(req.n));
      this.starting.set(req.n, pending);
    }
    return { info: await pending, created: true };
  }

  private async launch(req: StartScreen): Promise<ScreenInfo> {
    const info = screenInfo(req.n, req.width ?? this.deps.width, req.height ?? this.deps.height);
    const screen: Screen = { info, procs: new Map(), stopping: false, vncPassword: vncPassword() };
    const paths = this.paths(info.n);
    try {
      await this.run(
        '/bin/sh',
        ['-c', PREPARE_SCRIPT, 'sh', paths.run, paths.state, req.fresh ? '1' : '0'],
        {
          user: screenIdentity(info.n),
          input: Buffer.concat([
            Buffer.from(`${screen.vncPassword}\n`),
            xauthority(DISPLAY_BASE + info.n, xCookie()),
          ]),
        },
      );
      await this.run(
        process.execPath,
        ['-e', PREFERENCES_SCRIPT, paths.preferences, downloadsDir(this.deps.home)],
        { user: screenIdentity(info.n) },
      );
      await (this.deps.clearStaleDisplay ?? ((i) => this.clearStaleDisplay(i)))(info);
      const xvfb = this.daemon(
        screen,
        'xvfb',
        'Xvfb',
        [
          info.display,
          '-screen',
          '0',
          `${info.width}x${info.height}x24`,
          '-auth',
          paths.xauthority,
          '-nolisten',
          'tcp',
          // A lock file in /tmp is one more thing a command could take first;
          // the socket already keeps a second server off the display.
          '-nolock',
          '-displayfd',
          '3',
        ],
        ['ignore', 'ignore', 'ignore', 'pipe'],
      );
      await (this.deps.waitForDisplay ?? defaultWaitForDisplay)(info, xvfb);
      this.daemon(screen, 'wm', 'openbox', ['--sm-disable']);
      await this.deps.onDisplayReady?.(info);
      this.daemon(screen, 'vnc', 'x11vnc', [
        '-display',
        info.display,
        '-auth',
        paths.xauthority,
        // No TCP port, on IPv4 or IPv6, that a command could take first.
        '-unixsock',
        paths.vncSocket,
        '-rfbport',
        '0',
        '-rfbportv6',
        '0',
        // x11vnc deletes the file once it has read the password.
        '-passwdfile',
        `rm:${paths.vncPassword}`,
        '-forever',
        '-shared',
        '-quiet',
      ]);
      await this.startBrowser(screen);
      this.screens.set(req.n, screen);
    } catch (err) {
      await this.kill(screen);
      throw err;
    }
    await this.browserReady(info);
    return info;
  }

  private async browserReady(info: ScreenInfo): Promise<void> {
    await this.deps.onBrowserReady?.(info).catch(() => undefined);
  }

  /** Relaunches Chromium on a running screen if its window was closed. */
  async ensureBrowser(n: number): Promise<ScreenInfo> {
    const info = this.require(n);
    const screen = this.screens.get(n)!;
    const chromium = screen.procs.get('chromium');
    if (!chromium || chromium.exitCode !== null || chromium.signalCode !== null) {
      await this.startBrowser(screen);
      await this.browserReady(info);
    }
    return info;
  }

  private async startBrowser(screen: Screen): Promise<void> {
    const { info } = screen;
    await screen.devtools?.close();
    const chromium = this.daemon(
      screen,
      'chromium',
      '/bin/sh',
      [
        '-c',
        `umask ${CHROMIUM_UMASK} && exec "$0" "$@"`,
        this.deps.chromiumPath(),
        ...chromiumArgs(info, this.paths(info.n).profile),
      ],
      ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    );
    screen.devtools = await DevToolsBridge.listen(
      chromium.stdio[3] as Writable,
      chromium.stdio[4] as Readable,
    );
    await (this.deps.waitForBrowser ?? defaultWaitForBrowser)(info, screen.devtools);
  }

  /**
   * A connection to x11vnc on running screen `n`. The socket is in the
   * screen's directory, which the agent may not enter, so with the helper a
   * relay run as the screen's user carries it over its stdin and stdout.
   */
  vnc(n: number): Duplex {
    const socket = this.paths(this.require(n).n).vncSocket;
    if (!this.users.privileged) return connect(socket);
    const program = this.users.command(screenIdentity(n), process.execPath, [
      '-e',
      VNC_RELAY_SCRIPT,
      socket,
    ]);
    const relay = this.spawn(program.command, program.args, {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: '/',
    });
    const conn = Duplex.from({
      readable: relay.stdio[1] as Readable,
      writable: relay.stdio[0] as Writable,
    });
    relay.once('error', (err) => conn.destroy(err));
    relay.once('exit', () => conn.destroy());
    return conn;
  }

  /**
   * Something at the display's socket path makes Xvfb refuse: a socket left
   * by a crashed Xvfb, or a file a command made first. The socket directory
   * is root's and sticky, so the screen's user cannot remove a command's
   * file; the helper removes it as root (native/runas.c).
   */
  private async clearStaleDisplay(info: ScreenInfo): Promise<void> {
    if (!this.users.helper) {
      await this.run('rm', ['-f', xSocket(info)]);
      return;
    }
    const child = this.spawn(this.users.helper, ['--clear-display', String(info.n)], {
      env: childEnv(),
      stdio: 'ignore',
      cwd: '/',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new AgentError(500, 'START_FAILED', `Could not clear ${info.display}`)),
      );
    });
  }

  private daemon(
    screen: Screen,
    name: string,
    command: string,
    args: string[],
    stdio: SpawnOptions['stdio'] = 'ignore',
  ): ChildProcess {
    const { n } = screen.info;
    const program = this.users.command(screenIdentity(n), command, args);
    // The root directory: the agent changes to it before the helper drops to
    // the screen's user, and the screen's state directory is closed to it.
    const child = this.spawn(program.command, program.args, {
      env: childEnv({ HOME: this.paths(n).state, ...this.xEnv(n) }),
      stdio,
      cwd: '/',
    });
    screen.procs.set(name, child);
    child.once('error', () => {
      // Reported through `exit` below or the readiness wait.
    });
    child.once('exit', (code) => {
      if (screen.procs.get(name) === child) screen.procs.delete(name);
      if (!screen.stopping) this.deps.onExit?.(screen.info.n, name, code);
      // Without its X server nothing else on the screen can work.
      if (name === 'xvfb' && !screen.stopping) void this.stop(screen.info.n);
    });
    return child;
  }

  async stop(n: number): Promise<boolean> {
    const screen = this.screens.get(n);
    if (!screen || screen.stopping) return false;
    screen.stopping = true;
    await this.kill(screen);
    this.screens.delete(n);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.screens.keys()].map((n) => this.stop(n)));
  }

  private async kill(screen: Screen): Promise<void> {
    screen.stopping = true;
    // Clients first, the X server last.
    const order = ['chromium', 'vnc', 'wm', 'xvfb'];
    for (const name of order) {
      const child = screen.procs.get(name);
      if (!child || child.pid === undefined) continue;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => this.signal(screen, child, 'SIGKILL'), STOP_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        this.signal(screen, child, 'SIGTERM');
      });
    }
    screen.procs.clear();
    await screen.devtools?.close();
    // Left behind when x11vnc never got to read it.
    await this.run('rm', ['-f', this.paths(screen.info.n).vncPassword], {
      user: screenIdentity(screen.info.n),
    }).catch(() => undefined);
  }

  /** The agent may not signal another user's process; the screen's user may. */
  private signal(screen: Screen, child: ChildProcess, signal: NodeJS.Signals) {
    if (!this.users.privileged) return void child.kill(signal);
    void this.run('kill', ['-s', signal.replace(/^SIG/, ''), String(child.pid)], {
      user: screenIdentity(screen.info.n),
    }).catch(() => undefined);
  }
}
