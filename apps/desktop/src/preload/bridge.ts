import {
  DESKTOP_CHANNELS,
  type ConnectionInfo,
  type ConnectOptions,
  type PairCode,
  type PairRelayStatus,
  type PairRelayView,
  type PlatformInfo,
  type ProfilesView,
  type QuickAskBot,
  type QuickAskResult,
  type ServerCheckResult,
  type ServerProfile,
} from '../ipc.js';
import { createStackBridge, type IpcRendererLike, type StackBridge } from '../stack/bridge.js';

// What the preload exposes as `window.openbots` with contextBridge (plan 14.4).
// Every page gets `platform`, `onNavigate`, `onNew`, `connection` (the web
// app's connection indicator) and `oauth` (a connector's sign-in in the
// default browser); the server's pages (the web app, possibly a
// remote server's) get nothing more. The app's own pages (the start page and
// the quick-ask and pairing windows, loaded from the app bundle) also get the
// profiles, the ways to connect, the local stack, quick ask and pairing; the main process
// checks the sender again, so a page that reaches these channels some other
// way is refused. `connection` answers only the active server's page in the
// main window, and its Start, Stop and Show logs only for This Mac; `oauth`
// answers that page too.

export interface WebBridge {
  platform: PlatformInfo;
  /** Paths to open from deep links and the tray; returns the unsubscribe. */
  onNavigate(listener: (path: string) => void): () => void;
  /** The File menu's New (Cmd+N), for the web app's New dialog; returns the unsubscribe. */
  onNew(listener: () => void): () => void;
  connection: {
    info(): Promise<ConnectionInfo>;
    /** Shows the three ways to connect; saved servers stay. */
    change(): Promise<void>;
    /** This Mac only. */
    start(): Promise<ConnectionInfo>;
    /** This Mac only; the window shows the start page after. */
    stop(): Promise<void>;
    /** This Mac only: the start page with the logs, so no log line reaches the server's page. */
    showLogs(): Promise<void>;
  };
  oauth: {
    /** Opens a connector's sign-in page (the URL its server answered) in the default browser. */
    open(url: string): Promise<void>;
    /** The sign-in finished: brings the app to the front, once per `open`. */
    finished(): Promise<void>;
  };
}

export interface AppBridge extends WebBridge {
  connect: {
    options(): Promise<ConnectOptions>;
    /** Opens the hosted server's sign-in. */
    cloud(): Promise<void>;
    /** Checks an address is an OpenBots server, without saving it. */
    check(url: string): Promise<ServerCheckResult>;
    /** Checks, saves and opens a self-hosted server: its setup, or sign-in. */
    server(url: string): Promise<void>;
    /** Waits for the started local stack, then opens its setup, or sign-in. */
    local(): Promise<void>;
    /** Pairs this Mac with another OpenBots server, or another Mac's, from its pairing link. */
    pair(link: string): Promise<void>;
  };
  profiles: {
    list(): Promise<ProfilesView>;
    add(input: { name?: string; url: string }): Promise<ServerProfile>;
    remove(id: string): Promise<ProfilesView>;
    /** Makes the profile active and loads its server in the main window. */
    open(id: string): Promise<void>;
  };
  stack: StackBridge;
  quickAsk: {
    bots(): Promise<QuickAskBot[]>;
    send(botId: string, text: string): Promise<QuickAskResult>;
    close(): void;
  };
  pair: {
    relay(): Promise<PairRelayView>;
    /** This Mac only: writes the relay, restarts the stack on it and signs out paired phones. */
    setRelay(url: string): Promise<PairRelayView>;
    /** A new code; the main process cancels the window's last unused one. */
    code(): Promise<PairCode>;
    /** The server's link to its relay: the window shows the code once it is `linked`. */
    relayStatus(): Promise<PairRelayStatus>;
    /** Hears the phone that used the window's code; returns the unsubscribe. */
    onPaired(listener: (name: string) => void): () => void;
    close(): void;
  };
}

export function createWebBridge(ipcRenderer: IpcRendererLike, platform: PlatformInfo): WebBridge {
  const invoke = <T>(channel: string) => ipcRenderer.invoke(channel) as Promise<T>;
  return {
    // A copy, so a page cannot change what other code reads.
    platform: { ...platform },
    onNavigate(listener) {
      const handler = (_event: unknown, ...args: unknown[]) => {
        const [path] = args;
        // Only app paths: a navigate message never leaves the server's origin.
        if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) {
          listener(path);
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.navigate, handler);
      return () => void ipcRenderer.removeListener(DESKTOP_CHANNELS.navigate, handler);
    },
    onNew(listener) {
      // Nothing from the message reaches the page.
      const handler = () => listener();
      ipcRenderer.on(DESKTOP_CHANNELS.newItem, handler);
      return () => void ipcRenderer.removeListener(DESKTOP_CHANNELS.newItem, handler);
    },
    connection: {
      info: () => invoke<ConnectionInfo>(DESKTOP_CHANNELS.connectionInfo),
      change: () => invoke<void>(DESKTOP_CHANNELS.connectionChange),
      start: () => invoke<ConnectionInfo>(DESKTOP_CHANNELS.connectionStart),
      stop: () => invoke<void>(DESKTOP_CHANNELS.connectionStop),
      showLogs: () => invoke<void>(DESKTOP_CHANNELS.connectionLogs),
    },
    oauth: {
      // Only a string crosses; the main process checks it is an http or https URL.
      open: (url) => ipcRenderer.invoke(DESKTOP_CHANNELS.oauthOpen, String(url)) as Promise<void>,
      finished: () => invoke<void>(DESKTOP_CHANNELS.oauthFinished),
    },
  };
}

export function createAppBridge(ipcRenderer: IpcRendererLike, platform: PlatformInfo): AppBridge {
  const invoke = <T>(channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>;
  return {
    ...createWebBridge(ipcRenderer, platform),
    profiles: {
      list: () => invoke<ProfilesView>(DESKTOP_CHANNELS.profilesList),
      add: (input) =>
        invoke<ServerProfile>(DESKTOP_CHANNELS.profilesAdd, { name: input.name, url: input.url }),
      remove: (id) => invoke<ProfilesView>(DESKTOP_CHANNELS.profilesRemove, id),
      open: (id) => invoke<void>(DESKTOP_CHANNELS.profilesOpen, id),
    },
    connect: {
      options: () => invoke<ConnectOptions>(DESKTOP_CHANNELS.connectOptions),
      cloud: () => invoke<void>(DESKTOP_CHANNELS.connectCloud),
      check: (url) => invoke<ServerCheckResult>(DESKTOP_CHANNELS.connectCheck, url),
      server: (url) => invoke<void>(DESKTOP_CHANNELS.connectServer, url),
      local: () => invoke<void>(DESKTOP_CHANNELS.connectLocal),
      pair: (link) => invoke<void>(DESKTOP_CHANNELS.connectPair, String(link)),
    },
    stack: createStackBridge(ipcRenderer),
    quickAsk: {
      bots: () => invoke<QuickAskBot[]>(DESKTOP_CHANNELS.quickAskBots),
      send: (botId, text) => invoke<QuickAskResult>(DESKTOP_CHANNELS.quickAskSend, botId, text),
      close: () => void invoke(DESKTOP_CHANNELS.quickAskClose),
    },
    pair: {
      relay: () => invoke<PairRelayView>(DESKTOP_CHANNELS.pairRelay),
      setRelay: (url) => invoke<PairRelayView>(DESKTOP_CHANNELS.pairSetRelay, String(url)),
      code: () => invoke<PairCode>(DESKTOP_CHANNELS.pairCode),
      relayStatus: () => invoke<PairRelayStatus>(DESKTOP_CHANNELS.pairRelayStatus),
      onPaired(listener) {
        const handler = (_event: unknown, ...args: unknown[]) => {
          const [name] = args;
          if (typeof name === 'string') listener(name);
        };
        ipcRenderer.on(DESKTOP_CHANNELS.pairPaired, handler);
        return () => void ipcRenderer.removeListener(DESKTOP_CHANNELS.pairPaired, handler);
      },
      close: () => void invoke(DESKTOP_CHANNELS.pairClose),
    },
  };
}

/** The app's own pages are the ones loaded from the bundle (or the dev server). */
export function isAppPage(pageUrl: string, appBase: string | undefined): boolean {
  if (pageUrl.startsWith('file://')) return true;
  if (!appBase) return false;
  try {
    return new URL(pageUrl).origin === new URL(appBase).origin;
  } catch {
    return false;
  }
}
