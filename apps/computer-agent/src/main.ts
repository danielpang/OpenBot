// The control agent process inside the computer image (plan 9.3).
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { createApp } from './app.js';
import { BrowserPool } from './browser.js';
import { loadConfig, SECRET_ENV_VARS } from './config.js';
import { CookieSync, readCookieStore, writeCookieStore } from './cookies.js';
import { dropToBot, layOut, shareRepos, takeToken } from './privileges.js';
import { createRun } from './proc.js';
import {
  claimLegacyRemoval,
  removeLegacyProfiles,
  ScreenManager,
  shareDownloads,
} from './screens.js';
import { coderSessions } from './coder.js';
import { REPOS_REL } from './coder-paths.js';
import { CODERS_GID, RUNAS_PATH, UNPRIVILEGED, Users } from './users.js';
import { Wallpaper } from './wallpaper.js';
import { attachWebSockets } from './ws.js';

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

const config = loadConfig();
// Children get `childEnv`, which drops these too; this also keeps them from
// anything that reads process.env directly (S-7).
for (const name of SECRET_ENV_VARS) delete process.env[name];

// In the image the agent starts as root: it takes the token file, lays out
// the screens' directories and drops to the bot user (privileges.ts), and
// from then on starts every program through openbots-runas. Started as anyone
// else (a dev machine, a remote agent) everything runs as that user.
const privileged = process.getuid?.() === 0;
// Root without the helper would leave every child root's to take back.
if (privileged && !existsSync(RUNAS_PATH)) {
  throw new Error(`Running as root needs ${RUNAS_PATH} (apps/computer-agent/native/runas.c)`);
}
const token = config.token ?? (await takeToken(config.tokenFile, process.getuid?.() ?? 0));
if (privileged) await layOut(config);
// As root in the image, since the state directory is root's.
const removeLegacy = await claimLegacyRemoval(config.stateDir).catch((err: unknown) => {
  log('could not mark the old profiles as removed', { error: String(err) });
  return false;
});
if (privileged) dropToBot();
const users = privileged ? new Users(RUNAS_PATH) : UNPRIVILEGED;
if (!privileged) log('not root: every screen and command runs as the agent user', {});
// As the bot user, which owns the home: the screens save downloads there.
await shareDownloads(config.home).catch((err: unknown) =>
  log('downloads directory not shared', { error: String(err) }),
);
// As the bot user too, with the coders group it kept: the coding agents'
// repositories (I2).
await shareRepos(path.join(config.home, REPOS_REL), privileged ? CODERS_GID : undefined).catch(
  (err: unknown) => log('repositories directory not shared', { error: String(err) }),
);
if (removeLegacy && (await removeLegacyProfiles(config.home))) {
  log('removed the Chromium profiles from before 8.4j');
}
const run = createRun(users);

const cookies: CookieSync = new CookieSync({
  jar: (n) => browsers.context(screens.require(n)),
  screens: () => screens.list().map((s) => s.n),
  load: () => readCookieStore(run, config.stateDir),
  save: (text) => writeCookieStore(run, config.stateDir, text),
  onError: (err, screen) => log('cookie sync failed', { screen, error: String(err) }),
});
await cookies.init();

const wallpaper: Wallpaper = new Wallpaper({
  run,
  targets: () => screens.list(),
  place: (t) => ({ file: screens.paths(t.n).wallpaper, x: screens.x(t.n) }),
  onError: (err) => log('wallpaper failed', { error: String(err) }),
});
const screens = new ScreenManager({
  home: config.home,
  width: config.width,
  height: config.height,
  runtimeDir: config.runtimeDir,
  stateDir: config.stateDir,
  users,
  run,
  chromiumPath: () => config.chromiumPath ?? chromium.executablePath(),
  onDisplayReady: (info) => wallpaper.apply(undefined, [info]).then(() => undefined),
  onBrowserReady: (info) => cookies.open(info.n),
  onExit: (n, name, code) => log('screen process exited', { screen: n, process: name, code }),
});
const browsers = new BrowserPool((info) => screens.devtools(info.n));
const app = createApp({
  token,
  home: config.home,
  run,
  screens,
  browsers,
  wallpaper,
  cookies,
  users,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
  log('listening', { port: info.port, home: config.home }),
) as Server;
const sockets = attachWebSockets(server, {
  token,
  home: config.home,
  screens,
  users,
  runtimeDir: config.runtimeDir,
  stateDir: config.stateDir,
  coders: coderSessions,
  log,
});
wallpaper.start();
cookies.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log('shutting down', { signal });
    wallpaper.stop();
    cookies.stop();
    await sockets.close();
    // The screens' last cookie changes, before their Chromium goes.
    await cookies.sync();
    await browsers.disconnectAll();
    await screens.stopAll();
    server.close(() => process.exit(0));
  });
}
