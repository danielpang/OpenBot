import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WebSocketLike } from '@openbots/api-client';
import { base64urlDecode, type BinaryWebSocketLike } from '@openbots/tunnel';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import WebSocket from 'ws';
import {
  DESKTOP_CHANNELS,
  type PairRelayStatus,
  type PairRelayView,
  type PlatformInfo,
  type ServerProfile,
} from '../ipc.js';
import { isAppPage } from '../preload/bridge.js';
import { registerStackIpc } from '../stack/bridge.js';
import { bundledStackPaths, type StackPaths } from '../stack/compose.js';
import {
  DEFAULT_RELEASE_REPOSITORY,
  releaseImageLoader,
  repositoryFromAppUpdateYml,
} from '../images/release-archive.js';
import { createStackManager, devImageOverrides } from '../stack/manager.js';
import { cloudUrl, isPreviewBuild } from './app-config.js';
import { aboutPanelOptions } from './about.js';
import {
  pairedByThis,
  parseRelayUrl,
  RETIRED_SHARED_RELAY_URLS,
  sharedRelayUrl,
} from './pairing.js';
import { devAppIconPath } from './app-icon.js';
import { QUICK_ASK_ACCELERATOR, trayMenu, type PendingApproval } from './approvals.js';
import { createConnection, type Connection } from './connection.js';
import { createDeviceKeyStore } from './device-keys.js';
import {
  deepLinkFromArgv,
  deepLinkPath,
  parseDeepLink,
  PROTOCOL,
  type DeepLink,
} from './deep-links.js';
import { registerDesktopIpc } from './ipc.js';
import { connectionHeader, createLauncher } from './launcher.js';
import {
  createComputerWake,
  createLocalSignIn,
  isSignInPath,
  needsLocalSignIn,
  ownerName,
} from './local-session.js';
import { fileMenu } from './menu.js';
import { navigationVerdict, serverPath } from './navigation.js';
import { createOAuthBrowser } from './oauth.js';
import { isWatching, type Notice } from './notices.js';
import { createOpener } from './opener.js';
import { parsePairingLink } from './pair-link.js';
import {
  createTunnelLink,
  NotPairedError,
  pairWithServer,
  relayTunnel,
  tunnelErrorMessage,
  type TunnelLink,
} from './paired.js';
import {
  createProfileStore,
  localServerUrl,
  pairedPort,
  pairedProxyUrl,
  type ProfileFiles,
} from './profiles.js';
import { createServerGate, verifyServer, type Refusal } from './server-gate.js';
import { createTokenStore, sessionCookieChange, type SessionToken } from './tokens.js';
import { trayIconPath, trayTitle } from './tray-icon.js';
import { PROXY_SECRET_HEADER, startTunnelProxy, type TunnelProxy } from './tunnel-proxy.js';
import { createUpdates } from './update-service.js';
import type { DesktopUpdates } from './updater.js';

// The Electron main process (plan 14.4, 18.8). The main window shows the
// active server profile's web app, once that server answers as OpenBots
// (./opener.ts, ./server-gate.ts); the app's own start page (the three ways to
// connect on first launch, profiles and the local stack), quick-ask window and
// pairing window come from the bundle. Everything with logic in it lives in
// the plain modules next to this file, which are tested without Electron;
// this file only wires them to Electron.

/** Embedded by electron-vite; no Git or filesystem version lookup at runtime. */
declare const __OPENBOTS_BUILD_VERSION__: string;

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
/** The renderer dev server in `electron-vite dev`; the bundle's files otherwise. */
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
/** The app icon in development; a packaged app carries its own (./app-icon.ts). */
const DEV_ICON = devAppIconPath({ packaged: app.isPackaged, mainDir: here });

// A development build takes its name from package.json. Name it OpenBots in
// menus and dialogs, as the packaged app is, but keep its data in the folder
// named after the package (Application Support/@openbots/desktop), apart from
// the packaged app's (Application Support/OpenBots).
if (!app.isPackaged) {
  const userData = app.getPath('userData');
  app.setName('OpenBots');
  app.setPath('userData', userData);
}

const files: ProfileFiles = {
  readFile: (path) => readFile(path, 'utf8'),
  // Profiles and sealed tokens are the owner's alone.
  writeFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
  },
};

// The development build runs the repository's compose files; a packaged app
// runs the copies in Contents/Resources/stack.
function stackPaths(): StackPaths {
  const paths = bundledStackPaths(process.resourcesPath, app.getPath('userData'));
  if (app.isPackaged) return paths;
  const repo = resolve(here, '../../../..');
  return {
    ...paths,
    composeFiles: [
      join(repo, 'docker/docker-compose.yml'),
      join(repo, 'docker/docker-compose.tunnels.yml'),
    ],
    envTemplate: join(repo, '.env.example'),
  };
}

/** The GitHub repository the app was released from, as electron-builder recorded it. */
function releaseRepository(): string {
  try {
    const text = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8');
    return repositoryFromAppUpdateYml(text) ?? DEFAULT_RELEASE_REPOSITORY;
  } catch {
    return DEFAULT_RELEASE_REPOSITORY;
  }
}

/** The project's relay, This Mac's unless the owner sets their own (./pairing.ts). */
const SHARED_RELAY_URL = sharedRelayUrl({
  packaged: app.isPackaged,
  packageJson: packageJson(),
  env: process.env,
});

const PREVIEW_BUILD = isPreviewBuild(packageJson());
const paths = stackPaths();
const stack = createStackManager({
  paths,
  projectName: PREVIEW_BUILD ? 'openbots-preview' : undefined,
  defaultRelayUrl: SHARED_RELAY_URL,
  retiredRelayUrls: RETIRED_SHARED_RELAY_URLS,
  serverVersion: app.isPackaged ? app.getVersion() : undefined,
  // `OPENBOTS_IMAGE_PREFIX=openbots-local OPENBOTS_VERSION=dev pnpm dev` runs images built from source.
  images: devImageOverrides(process.env, app.isPackaged),
  // When the registry refuses the release's images (GHCR packages start
  // private), a packaged app loads them from its GitHub Release instead.
  releaseImages: app.isPackaged
    ? releaseImageLoader({ repository: releaseRepository() })
    : undefined,
});
/** The packaged package.json, where the build writes `openbots.cloudUrl`. */
function packageJson(): unknown {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

const CLOUD_URL = cloudUrl({
  packaged: app.isPackaged,
  packageJson: packageJson(),
  env: process.env,
});
const profiles = createProfileStore({
  files,
  path: join(app.getPath('userData'), 'profiles.json'),
  cloudUrl: CLOUD_URL,
  // An install from before the first-run choice that set up the local stack chose This Mac.
  hasLocalStack: () =>
    access(paths.envFile).then(
      () => true,
      () => false,
    ),
  // OPENBOTS_DESKTOP_LOCAL_URL points the local profile at a dev server instead.
  localUrl: async () =>
    process.env.OPENBOTS_DESKTOP_LOCAL_URL ??
    localServerUrl(await readFile(paths.envFile, 'utf8').catch(() => undefined)),
});
const tokens = createTokenStore({
  safeStorage,
  files,
  path: join(app.getPath('userData'), 'tokens.json'),
});
const deviceKeys = createDeviceKeyStore({
  safeStorage,
  files,
  path: join(app.getPath('userData'), 'device-keys.json'),
});

// Servers this Mac paired with (./paired.ts): one tunnel and one loopback
// proxy each, started when the server is first opened and kept until the app
// quits or the profile goes. Each proxy has a secret of its own, which only
// its profile's window session and this process send (./tunnel-proxy.ts).

interface PairedRuntime {
  link: TunnelLink;
  proxy: TunnelProxy;
  secret: string;
}

const pairedRuntimes = new Map<string, Promise<PairedRuntime>>();
/** The started proxies' origins and secrets, for the requests that need them now. */
const proxySecrets = new Map<string, { profileId: string; secret: string }>();
const openRelayTunnel = relayTunnel((url) => new WebSocket(url) as unknown as BinaryWebSocketLike);

/** The http origin of a URL, ws:// read as http://; null for anything else. */
function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ws:' || parsed.protocol === 'http:') return `http://${parsed.host}`;
    return null;
  } catch {
    return null;
  }
}

/** The proxy secret a request to `url` carries: only to that proxy, and only from its own profile. */
function proxyHeaders(url: string, profileId?: string): Record<string, string> {
  const origin = httpOrigin(url);
  const entry = origin ? proxySecrets.get(origin) : undefined;
  if (!entry || (profileId !== undefined && entry.profileId !== profileId)) return {};
  return { [PROXY_SECRET_HEADER]: entry.secret };
}

async function startPaired(profile: ServerProfile): Promise<PairedRuntime> {
  const secrets = await deviceKeys.get(profile.id);
  if (!secrets || !profile.paired) {
    throw new Error(
      `This Mac no longer has its keys for ${profile.name}. Remove it from your saved connections, then pair again with a new link.`,
    );
  }
  const link = createTunnelLink({
    server: profile.paired,
    name: profile.name,
    staticKey: base64urlDecode(secrets.staticKey),
    open: openRelayTunnel,
  });
  const secret = randomBytes(32).toString('base64url');
  try {
    const proxy = await startTunnelProxy({
      tunnel: () => link.get(),
      apiKey: secrets.apiKey,
      secret,
      port: pairedPort(profile.url) ?? 0,
      describeError: (error) => tunnelErrorMessage(error, profile.name),
    });
    proxySecrets.set(proxy.origin, { profileId: profile.id, secret });
    return { link, proxy, secret };
  } catch (error) {
    link.close();
    throw error;
  }
}

/** A paired server's proxy, started once; the profile comes back at the address it listens on. */
async function preparePaired(profile: ServerProfile): Promise<ServerProfile> {
  if (profile.kind !== 'paired') return profile;
  let runtime = pairedRuntimes.get(profile.id);
  if (!runtime) {
    const started = startPaired(profile);
    runtime = started;
    pairedRuntimes.set(profile.id, started);
    started.catch(() => {
      if (pairedRuntimes.get(profile.id) === started) pairedRuntimes.delete(profile.id);
    });
  }
  const { proxy } = await runtime;
  if (proxy.origin === profile.url) return profile;
  // Another app took the last port: the profile moves with its proxy.
  const moved = await profiles.setUrl(profile.id, proxy.origin);
  if (activeProfile?.id === moved.id) activeProfile = moved;
  return moved;
}

async function stopPaired(profileId: string): Promise<void> {
  const runtime = await pairedRuntimes.get(profileId)?.catch(() => null);
  pairedRuntimes.delete(profileId);
  if (!runtime) return;
  proxySecrets.delete(runtime.proxy.origin);
  runtime.link.close();
  await runtime.proxy.close().catch(() => undefined);
}

/** Signs this Mac out of a paired server it is removing, as far as the server answers in time. */
async function unpair(profile: ServerProfile): Promise<void> {
  const runtime = await pairedRuntimes.get(profile.id)?.catch(() => null);
  const secrets = await deviceKeys.get(profile.id).catch(() => undefined);
  if (secrets && profile.paired) {
    const { deviceId } = profile.paired;
    // A server not opened this run gets a tunnel of its own, just for this.
    const link =
      runtime?.link ??
      createTunnelLink({
        server: profile.paired,
        name: profile.name,
        staticKey: base64urlDecode(secrets.staticKey),
        open: openRelayTunnel,
      });
    const revoke = link
      .get()
      .then((tunnel) =>
        tunnel.fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${secrets.apiKey}` },
        }),
      )
      .then((response) => {
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      });
    // An offline server keeps the device until its owner removes it there.
    const late = new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error('the server did not answer in time')), 5000).unref(),
    );
    await Promise.race([revoke, late]).catch((error: unknown) =>
      console.error('could not sign out of the paired server', error),
    );
    if (!runtime) link.close();
  }
  await stopPaired(profile.id);
  await deviceKeys.clear(profile.id).catch(() => undefined);
}

/** A free loopback port for a new paired server's proxy; it may move again at its first start. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** This Mac's name, as the paired server's Devices list shows it. */
function computerName(): Promise<string> {
  const fallback = hostname().replace(/\.local$/, '') || 'Mac';
  if (process.platform !== 'darwin') return Promise.resolve(fallback);
  return new Promise((done) =>
    execFile('scutil', ['--get', 'ComputerName'], (error, stdout) =>
      done(error ? fallback : stdout.trim() || fallback),
    ),
  );
}

/** Pairs with the server of a pairing link and saves it; the launcher opens it. */
async function pairServer(input: string): Promise<ServerProfile> {
  const link = parsePairingLink(input);
  const result = await pairWithServer(link, {
    open: openRelayTunnel,
    deviceName: await computerName(),
    ownerName: link.setup
      ? await ownerName(
          () =>
            new Promise((done, fail) =>
              execFile('id', ['-F'], (error, stdout) => (error ? fail(error) : done(stdout))),
            ),
        )
      : null,
  });
  // Pairing the same server again replaces the old keys: its tunnel starts over with the new ones.
  const existing = (await profiles.list()).profiles.find(
    (p) => p.kind === 'paired' && p.paired?.hostId === result.paired.hostId,
  );
  if (existing) await stopPaired(existing.id);
  const profile = await profiles.addPaired({
    name: link.name,
    url: existing?.url ?? pairedProxyUrl(await freePort()),
    paired: result.paired,
  });
  await deviceKeys.set(profile.id, result.secrets);
  return profile;
}

const gate = createServerGate({
  verify: async (profile) => {
    if (profile.kind === 'paired') {
      // The tunnel first, so a server that is off says so, not that it is not OpenBots.
      const runtime = await pairedRuntimes.get(profile.id)?.catch(() => null);
      try {
        if (!runtime) throw new Error(`${profile.name} is not connected.`);
        await runtime.link.get();
      } catch (error) {
        return {
          ok: false,
          reason: 'unreachable',
          message: tunnelErrorMessage(error, profile.name),
        } as const;
      }
    }
    return verifyServer(profile, {
      fetch: (url, init) => fetch(url, { ...init, headers: proxyHeaders(url, profile.id) }),
      // A development server named by OPENBOTS_DESKTOP_LOCAL_URL is not the stack's.
      stack: process.env.OPENBOTS_DESKTOP_LOCAL_URL ? null : stack,
    });
  },
});

// This Mac has no sign-in: the main process signs the owner in with the
// stack's local token (./local-session.ts), which stays in this process.
const localSignIn = createLocalSignIn({
  fetch: (url, init) => fetch(url, init),
  // A development server named by OPENBOTS_DESKTOP_LOCAL_URL takes its token from the environment.
  token: async () =>
    process.env.OPENBOTS_DESKTOP_LOCAL_URL
      ? (process.env.OPENBOTS_LOCAL_TOKEN ?? null)
      : stack.localToken(),
  name: () =>
    ownerName(
      () =>
        new Promise((done, fail) =>
          execFile('id', ['-F'], (error, stdout) => (error ? fail(error) : done(stdout))),
        ),
    ),
  log: (message) => console.error(message),
});
const computerWake = createComputerWake({
  fetch: (url, init) => fetch(url, init),
  log: (message) => console.error(message),
});

let mainWindow: BrowserWindow | null = null;
let quickAskWindow: BrowserWindow | null = null;
let pairWindow: BrowserWindow | null = null;
/** The pairing window's code, until a phone uses it or the window lets it go. */
let openPairing: { id: string; expiresAt: string } | null = null;
let activeProfile: ServerProfile | null = null;
let connection: Connection | null = null;
let connectionToken: string | null = null;
let approvals: PendingApproval[] = [];
let tray: Tray | null = null;
let trayHasIcon = false;
let quitting = false;
let pendingLink: DeepLink | null = null;
// Notifications are kept until clicked or closed, or macOS drops their handlers.
const notifications = new Set<Notification>();

let updater: DesktopUpdates | undefined;

function refreshUpdates() {
  Menu.setApplicationMenu(applicationMenu());
  updateTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.updateNotice, updater?.notice ?? null);
  }
}

function platformInfo(): PlatformInfo {
  return {
    kind: 'desktop',
    os: process.platform,
    version: app.getVersion(),
    nativeNotifications: Notification.isSupported(),
  };
}

function webPreferences(partition?: Session, updates = false): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    ...(partition ? { session: partition } : {}),
    additionalArguments: [
      `--openbots-updates=${updates}`,
      `--openbots-platform=${JSON.stringify(platformInfo())}`,
      `--openbots-app-base=${RENDERER_URL ?? ''}`,
    ],
  };
}

/** Only the app's own pages may use the app bridge and the local stack. */
function isTrusted(event: { sender: unknown }): boolean {
  const frame = (event as IpcMainInvokeEvent).senderFrame;
  return frame != null && frame.parent == null && isAppPage(frame.url, RENDERER_URL);
}

/** The web app's indicator: the active server's own top page in the main window. */
function isActiveServerPage(event: { sender: unknown }): boolean {
  const { sender, senderFrame: frame } = event as IpcMainInvokeEvent;
  return (
    frame != null &&
    frame.parent == null &&
    mainWindow != null &&
    sender === mainWindow.webContents &&
    activeProfile != null &&
    serverPath(frame.url, activeProfile.url) != null
  );
}

function loadAppPage(
  window: BrowserWindow,
  page: 'index' | 'quick-ask' | 'pair',
  query: Record<string, string> = {},
) {
  if (RENDERER_URL) {
    const url = new URL(`${page}.html`, `${RENDERER_URL.replace(/\/?$/, '/')}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return window.loadURL(url.toString());
  }
  return window.loadFile(join(here, `../renderer/${page}.html`), { query });
}

// Sessions: one per profile, so two servers' cookies never mix. The session
// cookie is kept as a session cookie only (never on disk) and its value in the
// token store.

const configured = new WeakSet<Session>();

function profileSession(profile: ServerProfile): Session {
  const ses = session.fromPartition(`persist:profile-${profile.id}`);
  if (configured.has(ses)) return ses;
  configured.add(ses);
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    // Notifications are the shell's (N1); the web app does not ask for them here.
    callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
  if (profile.kind === 'paired') {
    // The window's requests to its own proxy, its WebSockets too, carry the
    // proxy's secret; nothing else this session sends does.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, ...proxyHeaders(details.url, profile.id) },
      });
    });
  }
  // Every top-level load of the server (a reload, a link, a redirect, a sign-in
  // callback) passes the gate first, so another app that took the server's
  // address never shows in the window, not even for a moment.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    // The local profile's URL follows the stack's port.
    const current = activeProfile?.id === profile.id ? activeProfile : profile;
    void gate.admit(current, details.url).then(
      (refusal) => {
        if (!refusal) {
          callback({});
          return;
        }
        callback({ cancel: true });
        if (mainWindow && activeProfile?.id === current.id) {
          disconnect();
          void showStartPage(mainWindow, current, refusal).catch(() => undefined);
        }
      },
      (error: unknown) => {
        console.error('could not check the server', error);
        callback({ cancel: true });
      },
    );
  });
  ses.cookies.on('changed', (_event, cookie, cause, removed) => {
    const change = sessionCookieChange(cookie, cause, removed);
    if (change.action === 'ignore') return;
    if (change.action === 'clear') {
      void tokens.clear(profile.id);
      if (activeProfile?.id === profile.id) disconnect();
      return;
    }
    void tokens.set(profile.id, change.token);
    if (change.rehome) {
      void ses.cookies
        .set({
          url: profile.url,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path ?? '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
        })
        .catch((error: unknown) =>
          console.error('could not keep the session cookie in memory', error),
        );
    }
    if (activeProfile?.id === profile.id) connect(profile, change.token);
  });
  return ses;
}

/** Only for a server that passed the gate: the token goes to it. */
async function restoreToken(profile: ServerProfile, ses: Session): Promise<void> {
  const token = await tokens.get(profile.id);
  if (!token) return;
  await ses.cookies
    .set({
      url: profile.url,
      name: token.name,
      value: token.value,
      path: '/',
      httpOnly: true,
      secure: profile.url.startsWith('https://'),
      sameSite: 'lax',
    })
    .catch((error: unknown) => console.error('could not restore the session', error));
  connect(profile, token);
}

/**
 * This Mac's sign-in: the saved session while the server takes it, else a
 * fresh one for the owner, put into the window's session before it loads.
 */
async function signInLocally(profile: ServerProfile): Promise<void> {
  let token: SessionToken | null = null;
  try {
    token = await localSignIn.ensure(profile.url, await tokens.get(profile.id));
    if (token) await tokens.set(profile.id, token);
  } catch (error) {
    console.error('could not sign in on This Mac', error);
  }
  await restoreToken(profile, profileSession(profile));
  // The computer starts in the background; the window loads meanwhile.
  computerWake.afterSignIn(profile, token);
}

/** The window reached /sign-in on This Mac, or the session ended: sign in again and reload. */
async function renewLocally(profile: ServerProfile, reload: boolean): Promise<void> {
  const token = await localSignIn.renew(profile.url).catch(() => null);
  if (!token) return;
  await tokens.set(profile.id, token).catch(() => undefined);
  await restoreToken(profile, profileSession(profile));
  if (reload && mainWindow && activeProfile?.id === profile.id) {
    await mainWindow.loadURL(new URL('/', profile.url).toString()).catch(() => undefined);
  }
}

// The main process's own connection: notifications and the tray.

function connect(profile: ServerProfile, token: SessionToken) {
  openConnection(profile, token.value, { token });
}

/** A paired server's connection goes through its proxy, with the proxy's secret. */
function connectPaired(profile: ServerProfile) {
  const headers = proxyHeaders(profile.url, profile.id);
  if (!headers[PROXY_SECRET_HEADER]) return;
  openConnection(profile, `paired ${profile.url}`, { headers });
}

function openConnection(
  profile: ServerProfile,
  key: string,
  auth: { token: SessionToken } | { headers: Record<string, string> },
) {
  if (connection && connectionToken === key) return;
  disconnect();
  connectionToken = key;
  const current = createConnection({
    baseUrl: profile.url,
    ...auth,
    createSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
    onNotice: showNotice,
    onDevicePaired: (device) => {
      if (!openPairing || !pairedByThis(device.createdAt, openPairing)) return;
      openPairing = null;
      pairWindow?.webContents.send(DESKTOP_CHANNELS.pairPaired, device.name);
    },
    onApprovals: (list) => {
      approvals = list;
      updateTray();
    },
    onStatus: (status) => {
      if (status === 'open') void current.refresh().catch(() => undefined);
      updateTray();
    },
    onUnauthorized: () => {
      disconnect();
      if (profile.kind === 'paired') {
        // The device key was refused: the server signed this Mac out.
        if (mainWindow && activeProfile?.id === profile.id) {
          void showStartPage(mainWindow, profile, new NotPairedError(profile.name).message);
        }
        return;
      }
      void tokens.clear(profile.id);
      if (profile.kind === 'local') void renewLocally(profile, false);
    },
  });
  connection = current;
  updateTray();
}

function disconnect() {
  connection?.close();
  connection = null;
  connectionToken = null;
  approvals = [];
  updateTray();
}

function showNotification(
  title: string,
  body: string,
  onClick?: () => void,
  icon?: Electron.NativeImage,
) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, ...(icon ? { icon } : {}) });
  notifications.add(notification);
  notification.on('click', () => {
    notifications.delete(notification);
    onClick?.();
  });
  notification.on('close', () => notifications.delete(notification));
  notification.show();
}

function showNotice(notice: Notice) {
  const contents = mainWindow?.webContents;
  const watching =
    mainWindow != null &&
    activeProfile != null &&
    isWatching(notice, {
      focused: mainWindow.isVisible() && mainWindow.isFocused(),
      path: contents ? serverPath(contents.getURL(), activeProfile.url) : null,
    });
  if (watching) return;
  void noticeIcon(notice.target.botId).then((icon) =>
    showNotification(notice.title, notice.body, () => openLink(notice.link), icon),
  );
}

/** The Bot's avatar for its notification (plan 13); none if the server has no image for it. */
async function noticeIcon(botId: string): Promise<Electron.NativeImage | undefined> {
  const png = await connection?.avatar(botId).catch(() => null);
  if (!png) return undefined;
  const image = nativeImage.createFromBuffer(Buffer.from(png));
  return image.isEmpty() ? undefined : image;
}

// Windows.

/**
 * A main window for the profile's session, replacing the one there was; it
 * loads nothing yet, and nothing of the server until the opener says so.
 */
async function createMainWindow(profile: ServerProfile): Promise<BrowserWindow> {
  const previous = mainWindow;
  activeProfile = profile;
  disconnect();
  const ses = profileSession(profile);

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'OpenBots',
    // Windows and Linux show it on the window and taskbar; macOS uses the Dock icon.
    icon: DEV_ICON,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: webPreferences(ses, true),
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    // macOS keeps the app, the tray and the notifications when the window closes.
    if (!quitting && process.platform === 'darwin') {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on('focus', () => void connection?.refresh().catch(() => undefined));

  const contents = window.webContents;
  // The profile's address now: the local stack's port, or a paired server's proxy, can move.
  const serverUrl = () => (activeProfile?.id === profile.id ? activeProfile : profile).url;
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationVerdict(url, serverUrl()) !== 'deny') void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAppPage(url, RENDERER_URL) && isAppPage(contents.getURL(), RENDERER_URL)) return;
    const verdict = navigationVerdict(url, serverUrl());
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') void shell.openExternal(url);
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  // Server-side redirects too: an allowed page must not bounce the window elsewhere.
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) guard(event, event.url);
  });
  // This Mac never shows sign-in: on /sign-in or /sign-up (an expired session) sign in again.
  const relogin = (url: string) => {
    const current = activeProfile?.id === profile.id ? activeProfile : profile;
    if (needsLocalSignIn(current, url)) void renewLocally(current, true);
    // A paired server has no sign-in for this Mac: its sign-in page means the device key was refused.
    const path = current.kind === 'paired' ? serverPath(url, current.url) : null;
    if (path != null && isSignInPath(path)) {
      void showStartPage(window, current, new NotPairedError(current.name).message);
    }
  };
  contents.on('did-navigate', (_event, url) => relogin(url));
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) relogin(url);
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is an aborted load (a new navigation replaced it), not a failure; -20
    // is one the gate refused, which shows the start page itself.
    if (!isMainFrame || code === -3 || code === -20 || isAppPage(url, RENDERER_URL)) return;
    void showStartPage(window, profile, description || 'The server did not answer.');
  });

  previous?.destroy();
  updateTray();
  return window;
}

function showStartPage(
  window: BrowserWindow,
  profile: ServerProfile,
  error?: string | Refusal,
  options: { upgrade?: boolean; logs?: boolean } = {},
) {
  // The stack's controls (and its autostart, update and logs) are This Mac's alone.
  const local = profile.kind === 'local';
  const reason = typeof error === 'string' ? error : error?.message;
  return loadAppPage(window, 'index', {
    profile: profile.id,
    ...(reason ? { error: reason } : {}),
    // A local server that is not running is started right away (a taken port leaves Start off).
    ...(reason && local ? { autostart: '1' } : {}),
    // The app was updated past the local stack's release: move the stack to it.
    ...(options.upgrade && local ? { upgrade: '1' } : {}),
    ...(options.logs && local ? { logs: '1' } : {}),
  });
}

/** The main window for the profile, keeping it when it already has the profile's session. */
async function windowFor(profile: ServerProfile): Promise<BrowserWindow> {
  if (mainWindow && activeProfile?.id === profile.id) {
    // The same profile stays in place; the local URL may have changed with the stack .env.
    activeProfile = profile;
    updateTray();
    return mainWindow;
  }
  return createMainWindow(profile);
}

// A connector's sign-in opens in the default browser and brings the window back once done.
const oauthBrowser = createOAuthBrowser({
  openExternal: (url) => shell.openExternal(url),
  focus: () => {
    const window = mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    // Another app (the browser) is in front; take the focus back from it.
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
  },
});

const opener = createOpener<BrowserWindow>({
  gate,
  windows: {
    prepare: preparePaired,
    forProfile: windowFor,
    showsServer: (window, profile) => {
      const contents = window.webContents;
      return !contents.isLoading() && serverPath(contents.getURL(), profile.url) != null;
    },
    signIn: async (profile) => {
      if (profile.kind === 'local') return signInLocally(profile);
      if (profile.kind === 'paired') return connectPaired(profile);
      return restoreToken(profile, profileSession(profile));
    },
    signOut: (profile) => {
      if (activeProfile?.id === profile.id) disconnect();
    },
    load: (window, url) => window.loadURL(url),
    navigate: (window, path) => window.webContents.send(DESKTOP_CHANNELS.navigate, path),
    showStart: (window, profile, refusal) => showStartPage(window, profile, refusal),
  },
});

/**
 * The ways to connect, in the main window; the window keeps its profile's
 * session. `pairLink` is a pairing link opened on this Mac, for the choice
 * that pairs with it.
 */
async function showWelcome(pairLink?: string): Promise<void> {
  const window = mainWindow ?? (await createMainWindow(await profiles.active()));
  await loadAppPage(window, 'index', {
    welcome: '1',
    ...(pairLink ? { pair: pairLink } : {}),
  }).catch(() => undefined);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const launcher = createLauncher({
  profiles,
  stack,
  fetch: (url, init) => fetch(url, init),
  cloudUrl: CLOUD_URL,
  pair: pairServer,
  window: {
    openServer: async (profile, path) => {
      const { window, opened } = await opener.open(profile, path);
      window.show();
      return opened;
    },
    showStart: async (profile, options) => {
      const window = mainWindow ?? (await createMainWindow(profile));
      await showStartPage(window, profile, undefined, options);
      window.show();
    },
    showWelcome: () => showWelcome(),
  },
});

async function showMainWindow(): Promise<BrowserWindow> {
  if (!mainWindow) await launcher.launch();
  const window = mainWindow!;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

async function openLink(link?: DeepLink) {
  if (!app.isReady()) {
    pendingLink = link ?? null;
    return;
  }
  // Another server's pairing link: the welcome screen offers to pair with it.
  if (link?.kind === 'pair') {
    await showWelcome(link.link);
    return;
  }
  await showMainWindow();
  // Before a connection is chosen the window shows the three choices; a link waits for one.
  if (!link || !activeProfile || !(await profiles.list()).chosen) return;
  // A loaded web app navigates in place; otherwise the path loads once the server passes.
  await opener.openPath(activeProfile, deepLinkPath(link));
}

function toggleQuickAsk() {
  if (quickAskWindow?.isVisible()) {
    quickAskWindow.hide();
    return;
  }
  if (!quickAskWindow) {
    const window = new BrowserWindow({
      width: 560,
      height: 220,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      // A native panel on macOS: the menu material behind the page, which
      // leaves its background clear there (renderer/quick-ask.tsx).
      ...(process.platform === 'darwin'
        ? {
            vibrancy: 'popover' as const,
            visualEffectState: 'active' as const,
            backgroundColor: '#00000000',
          }
        : {}),
      title: 'Quick Ask',
      webPreferences: webPreferences(),
    });
    window.on('blur', () => window.hide());
    window.on('closed', () => {
      if (quickAskWindow === window) quickAskWindow = null;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    quickAskWindow = window;
    void loadAppPage(window, 'quick-ask').then(() => window.show());
    return;
  }
  quickAskWindow.reload();
  quickAskWindow.show();
}

// The pairing window (docs/RELAY_PROTOCOL.md 6) shows the code; its Relay
// view (the app menu's "Relay…") changes This Mac's relay, restarting the
// stack on it and signing out the paired phones, which reached it through
// the old one. Without a connection yet, Pair your phone opens Settings >
// Devices instead.

/** This Mac's stack, not a development server named by OPENBOTS_DESKTOP_LOCAL_URL. */
function setsOwnRelay(profile: ServerProfile | null): boolean {
  return profile?.kind === 'local' && !process.env.OPENBOTS_DESKTOP_LOCAL_URL;
}

/** Cancels the window's code nobody used; the server lets it expire anyway. */
function releasePairing() {
  const pairing = openPairing;
  openPairing = null;
  if (pairing) void connection?.cancelPairing(pairing.id).catch(() => undefined);
}

async function pairRelayView(): Promise<PairRelayView> {
  if (!connection) throw new Error('Sign in to OpenBots first.');
  return {
    local: setsOwnRelay(activeProfile),
    sharedUrl: SHARED_RELAY_URL,
    current: await connection.relayUrl(),
  };
}

type PairView = 'pair' | 'relay';

function openPairWindow(view: PairView = 'pair') {
  if (view === 'pair' && activeProfile?.kind === 'paired') {
    // A paired Mac is a device of that server; phones pair with the server itself.
    showNotification(
      `Pair your phone with ${activeProfile.name}`,
      'Phones pair with the server itself: use Pair your phone… in OpenBots there.',
    );
    return;
  }
  if (!connection) {
    if (view === 'pair') void openLink({ kind: 'devices' });
    else
      showNotification('Sign in to OpenBots first', 'The relay is set once the app is connected.');
    return;
  }
  if (pairWindow) {
    releasePairing();
    pairWindow.setTitle(view === 'relay' ? 'Relay' : 'Pair your phone');
    void loadAppPage(pairWindow, 'pair', { view });
    pairWindow.show();
    pairWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 440,
    height: 580,
    show: false,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    title: view === 'relay' ? 'Relay' : 'Pair your phone',
    webPreferences: webPreferences(),
  });
  window.on('closed', () => {
    if (pairWindow === window) pairWindow = null;
    releasePairing();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  pairWindow = window;
  void loadAppPage(window, 'pair', { view }).then(() => window.show());
}

// The tray (N2).

function updateTray() {
  if (!tray) return;
  const menu = trayMenu({
    approvals,
    profileName: activeProfile?.name ?? 'OpenBots',
    connection: activeProfile ? connectionHeader(activeProfile) : null,
    connected: connection != null,
    update: updater?.menu,
    actions: {
      open: (link) => void openLink(link),
      decide: (id, decision) => {
        void connection?.decide(id, decision).catch((error: unknown) => {
          showNotification(
            'Could not decide the approval',
            error instanceof Error ? error.message : String(error),
          );
        });
      },
      quickAsk: toggleQuickAsk,
      pairPhone: () => openPairWindow(),
      changeConnection: () => void launcher.changeConnection(),
      checkForUpdates: () => void updater?.check(true),
      quit: () => app.quit(),
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.setTitle(trayTitle(approvals.length, trayHasIcon));
  tray.setToolTip(approvals.length > 0 ? `OpenBots: ${approvals.length} pending` : 'OpenBots');
}

async function openNewDialog() {
  const window = await showMainWindow();
  window.webContents.send(DESKTOP_CHANNELS.newItem);
}

function applicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          ...updater?.menu,
          label: updater?.menu.label ?? 'Check for Updates…',
          click: () => void updater?.check(true),
        },
        { type: 'separator' },
        { label: 'Relay…', click: () => openPairWindow('relay') },
        {
          label: 'Change connection…',
          accelerator: 'CommandOrControl+,',
          click: () => void launcher.changeConnection(),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    fileMenu({
      newItem: () => void openNewDialog(),
      pairPhone: () => openPairWindow(),
    }),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

// Deep links: macOS sends `open-url` (even before `ready`); Windows and Linux
// start a second instance with the link in argv.

function handleLink(raw: string) {
  const link = parseDeepLink(raw);
  if (link) void openLink(link);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const raw = deepLinkFromArgv(argv);
    if (raw) handleLink(raw);
    else void showMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleLink(url);
  });

  // A side-by-side preview must not take over the installed app's deep links.
  if (!PREVIEW_BUILD && process.defaultApp && process.argv[1]) {
    // `electron .` in development: register the app with its script path.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
  } else if (!PREVIEW_BUILD) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  void app.whenReady().then(async () => {
    updater = await createUpdates({
      repository: releaseRepository(),
      changed: refreshUpdates,
      // Unlike Bento's child server, our Docker stack is independent of the app.
      // Keep it and its agents running; the next launch offers a stack upgrade.
      shutdown: async () => {
        quitting = true;
        disconnect();
      },
      shutdownFailed: () => {
        quitting = false;
      },
    });
    registerStackIpc(ipcMain, stack, isTrusted);
    registerDesktopIpc(
      ipcMain,
      {
        updateStatus: () => updater?.notice ?? null,
        checkUpdates: async () => {
          await updater?.check(true);
        },
        dismissUpdate: () => updater?.dismissNotice(),
        listProfiles: () => profiles.list(),
        addProfile: (input) => profiles.add(input),
        removeProfile: async (id) => {
          const removed = (await profiles.list()).profiles.find((p) => p.id === id);
          if (removed?.kind === 'paired') await unpair(removed);
          const view = await profiles.remove(id);
          await tokens.clear(id);
          if (activeProfile?.id === id) await opener.open(await profiles.active());
          return view;
        },
        // The start page's Open and Try again, and the saved connections.
        openProfile: async (id) => {
          await opener.open(await profiles.setActive(id));
        },
        connectOptions: () => launcher.options(),
        connectCloud: () => launcher.connectCloud(),
        checkServer: (url) => launcher.checkServer(url),
        connectServer: (url) => launcher.connectServer(url),
        connectLocal: () => launcher.connectLocal(),
        connectPaired: (link) => launcher.connectPaired(link),
        connectionInfo: () => launcher.info(),
        changeConnection: () => launcher.changeConnection(),
        startLocal: () => launcher.startLocal(),
        stopLocal: () => launcher.stopLocal(),
        showLocalLogs: () => launcher.showLocalLogs(),
        openOAuth: (url) => oauthBrowser.open(url),
        oauthFinished: () => void oauthBrowser.finished(),
        quickAskBots: async () => {
          if (!connection) throw new Error('Sign in to OpenBots first.');
          return connection.bots();
        },
        quickAsk: async (botId, text) => {
          if (!connection) throw new Error('Sign in to OpenBots first.');
          const result = await connection.ask(botId, text);
          quickAskWindow?.hide();
          return result;
        },
        closeQuickAsk: () => quickAskWindow?.hide(),
        pairRelay: pairRelayView,
        pairSetRelay: async (value) => {
          if (!setsOwnRelay(activeProfile)) {
            throw new Error('Only OpenBots on this Mac can change its relay here.');
          }
          const url = parseRelayUrl(value);
          if (url === null) {
            throw new Error('Enter a wss:// address, like wss://relay.example.com.');
          }
          if (url === (await stack.relayUrl())) return pairRelayView();
          await stack.setRelay(url);
          // The phones reached This Mac through the old relay: they pair again.
          if (!connection) throw new Error('Sign in to OpenBots first.');
          await connection.revokeDevices();
          return pairRelayView();
        },
        pairCode: async () => {
          if (!connection) throw new Error('Sign in to OpenBots first.');
          releasePairing();
          const { id, ...code } = await connection.createPairing();
          openPairing = { id, expiresAt: code.expiresAt };
          return code;
        },
        pairRelayStatus: async (): Promise<PairRelayStatus> => {
          if (!connection) throw new Error('Sign in to OpenBots first.');
          const { status, error } = await connection.relayStatus();
          return { status, error };
        },
        closePair: () => pairWindow?.close(),
      },
      isTrusted,
      isActiveServerPage,
    );

    app.setAboutPanelOptions(
      aboutPanelOptions({
        packaged: app.isPackaged,
        appVersion: app.getVersion(),
        buildVersion: __OPENBOTS_BUILD_VERSION__,
      }),
    );
    Menu.setApplicationMenu(applicationMenu());
    if (DEV_ICON) app.dock?.setIcon(DEV_ICON);
    const trayIcon = nativeImage.createFromPath(
      trayIconPath({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        mainDir: here,
      }),
    );
    trayIcon.setTemplateImage(true);
    trayHasIcon = !trayIcon.isEmpty();
    tray = new Tray(trayIcon);
    updateTray();
    if (!globalShortcut.register(QUICK_ASK_ACCELERATOR, toggleQuickAsk)) {
      console.error(`could not register the quick-ask shortcut ${QUICK_ASK_ACCELERATOR}`);
    }

    const opened = await launcher.launch();
    const startLink = pendingLink ?? parseDeepLink(deepLinkFromArgv(process.argv) ?? '');
    pendingLink = null;
    // A link would replace the welcome screen, or the start page while it updates the stack.
    if (startLink && opened === 'server') await openLink(startLink);
    updater.start();
  });

  app.on('activate', () => void showMainWindow());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    updater?.dispose();
    connection?.close();
    for (const id of [...pairedRuntimes.keys()]) void stopPaired(id);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
