import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocketLike } from '@openbots/api-client';
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
import electronUpdater from 'electron-updater';
import WebSocket from 'ws';
import { DESKTOP_CHANNELS, type PlatformInfo, type ServerProfile } from '../ipc.js';
import { isAppPage } from '../preload/bridge.js';
import { registerStackIpc } from '../stack/bridge.js';
import { bundledStackPaths, type StackPaths } from '../stack/compose.js';
import {
  DEFAULT_RELEASE_REPOSITORY,
  releaseImageLoader,
  repositoryFromAppUpdateYml,
} from '../images/release-archive.js';
import { createStackManager, devImageOverrides } from '../stack/manager.js';
import { cloudUrl } from './app-config.js';
import { devAppIconPath } from './app-icon.js';
import { QUICK_ASK_ACCELERATOR, trayMenu, type PendingApproval } from './approvals.js';
import { createConnection, type Connection } from './connection.js';
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
  needsLocalSignIn,
  ownerName,
} from './local-session.js';
import { fileMenu } from './menu.js';
import { navigationVerdict, serverPath } from './navigation.js';
import { createOAuthBrowser } from './oauth.js';
import { isWatching, type Notice } from './notices.js';
import { createOpener } from './opener.js';
import { createProfileStore, localServerUrl, type ProfileFiles } from './profiles.js';
import { createServerGate, verifyServer, type Refusal } from './server-gate.js';
import { createTokenStore, sessionCookieChange, type SessionToken } from './tokens.js';
import { trayIconPath, trayTitle } from './tray-icon.js';
import { createUpdater } from './updater.js';

// The Electron main process (plan 14.4, 18.8). The main window shows the
// active server profile's web app, once that server answers as OpenBots
// (./opener.ts, ./server-gate.ts); the app's own start page (the three ways to
// connect on first launch, profiles and the local stack) and quick-ask window
// come from the bundle. Everything with
// logic in it lives in the plain modules next to this file, which are tested
// without Electron; this file only wires them to Electron.

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

const paths = stackPaths();
const stack = createStackManager({
  paths,
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
const gate = createServerGate({
  verify: (profile) =>
    verifyServer(profile, {
      fetch: (url, init) => fetch(url, init),
      // A development server named by OPENBOTS_DESKTOP_LOCAL_URL is not the stack's.
      stack: process.env.OPENBOTS_DESKTOP_LOCAL_URL ? null : stack,
    }),
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

const updater = createUpdater({
  autoUpdater: electronUpdater.autoUpdater,
  enabled: app.isPackaged,
  notify: ({ title, body, onClick }) => showNotification(title, body, onClick),
  log: (message, error) => console.error(`[updater] ${message}`, error),
});

function platformInfo(): PlatformInfo {
  return {
    kind: 'desktop',
    os: process.platform,
    version: app.getVersion(),
    nativeNotifications: Notification.isSupported(),
  };
}

function webPreferences(partition?: Session): Electron.WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    ...(partition ? { session: partition } : {}),
    additionalArguments: [
      `--openbots-platform=${JSON.stringify(platformInfo())}`,
      `--openbots-app-base=${RENDERER_URL ?? ''}`,
    ],
  };
}

/** Only the app's own pages may use the app bridge and the local stack. */
function isTrusted(event: { sender: unknown }): boolean {
  const frame = (event as IpcMainInvokeEvent).senderFrame;
  return frame != null && isAppPage(frame.url, RENDERER_URL);
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
  page: 'index' | 'quick-ask',
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
  if (connection && connectionToken === token.value) return;
  disconnect();
  connectionToken = token.value;
  const current = createConnection({
    baseUrl: profile.url,
    token,
    createSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
    onNotice: showNotice,
    onApprovals: (list) => {
      approvals = list;
      updateTray();
    },
    onStatus: (status) => {
      if (status === 'open') void current.refresh().catch(() => undefined);
      updateTray();
    },
    onUnauthorized: () => {
      void tokens.clear(profile.id);
      disconnect();
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
    webPreferences: webPreferences(ses),
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
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationVerdict(url, profile.url) !== 'deny') void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAppPage(url, RENDERER_URL) && isAppPage(contents.getURL(), RENDERER_URL)) return;
    const verdict = navigationVerdict(url, profile.url);
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
    forProfile: windowFor,
    showsServer: (window, profile) => {
      const contents = window.webContents;
      return !contents.isLoading() && serverPath(contents.getURL(), profile.url) != null;
    },
    signIn: (profile) =>
      profile.kind === 'local'
        ? signInLocally(profile)
        : restoreToken(profile, profileSession(profile)),
    signOut: (profile) => {
      if (activeProfile?.id === profile.id) disconnect();
    },
    load: (window, url) => window.loadURL(url),
    navigate: (window, path) => window.webContents.send(DESKTOP_CHANNELS.navigate, path),
    showStart: (window, profile, refusal) => showStartPage(window, profile, refusal),
  },
});

/** The three ways to connect, in the main window; the window keeps its profile's session. */
async function showWelcome(): Promise<void> {
  const window = mainWindow ?? (await createMainWindow(await profiles.active()));
  await loadAppPage(window, 'index', { welcome: '1' }).catch(() => undefined);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const launcher = createLauncher({
  profiles,
  stack,
  fetch: (url, init) => fetch(url, init),
  cloudUrl: CLOUD_URL,
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
    showWelcome,
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

// The tray (N2).

function updateTray() {
  if (!tray) return;
  const menu = trayMenu({
    approvals,
    profileName: activeProfile?.name ?? 'OpenBots',
    connection: activeProfile ? connectionHeader(activeProfile) : null,
    connected: connection != null,
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
      pairPhone: () => void openLink({ kind: 'devices' }),
      changeConnection: () => void launcher.changeConnection(),
      checkForUpdates: () => updater.checkNow(),
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
        { label: 'Check for Updates…', click: () => updater.checkNow() },
        { type: 'separator' },
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
      pairPhone: () => void openLink({ kind: 'devices' }),
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

  if (process.defaultApp && process.argv[1]) {
    // `electron .` in development: register the app with its script path.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  void app.whenReady().then(async () => {
    registerStackIpc(ipcMain, stack, isTrusted);
    registerDesktopIpc(
      ipcMain,
      {
        listProfiles: () => profiles.list(),
        addProfile: (input) => profiles.add(input),
        removeProfile: async (id) => {
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
      },
      isTrusted,
      isActiveServerPage,
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
    updater.stop();
    connection?.close();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
