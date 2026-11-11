// The IPC contract between the main process and the preload (plan 14.4).
// Channel names and the shapes that cross them; the stack manager's own
// channels are in ./stack/bridge.ts.

export const DESKTOP_CHANNELS = {
  /** main → renderer: open a path of the web app (a deep link or a tray click). */
  navigate: 'openbots:navigate',
  /** main → renderer: the File menu's New (Cmd+N) opens the web app's New dialog. */
  newItem: 'openbots:new',
  updateStatus: 'openbots:update:status',
  updateCheck: 'openbots:update:check',
  updateDismiss: 'openbots:update:dismiss',
  /** main → renderer: the same update notice in every main-window document. */
  updateNotice: 'openbots:update:notice',
  profilesList: 'openbots:profiles:list',
  profilesAdd: 'openbots:profiles:add',
  profilesRemove: 'openbots:profiles:remove',
  profilesOpen: 'openbots:profiles:open',
  /** The first-run choices: the three ways to connect (app pages only). */
  connectOptions: 'openbots:connect:options',
  connectCloud: 'openbots:connect:cloud',
  connectCheck: 'openbots:connect:check',
  connectServer: 'openbots:connect:server',
  connectLocal: 'openbots:connect:local',
  /** Pairs this Mac with another OpenBots server, or another Mac's, from its pairing link. */
  connectPair: 'openbots:connect:pair',
  /** How the app is connected, for the web app's indicator (the active server's page too). */
  connectionInfo: 'openbots:connection:info',
  connectionChange: 'openbots:connection:change',
  connectionStart: 'openbots:connection:start',
  connectionStop: 'openbots:connection:stop',
  connectionLogs: 'openbots:connection:logs',
  /** A connector's OAuth sign-in: open its page in the default browser, then come back (web app). */
  oauthOpen: 'openbots:oauth:open',
  oauthFinished: 'openbots:oauth:finished',
  quickAskBots: 'openbots:quick-ask:bots',
  quickAskSend: 'openbots:quick-ask:send',
  quickAskClose: 'openbots:quick-ask:close',
  /** The pairing window and its Relay setting (app pages only): the relay, a code, close. */
  pairRelay: 'openbots:pair:relay',
  pairSetRelay: 'openbots:pair:set-relay',
  pairCode: 'openbots:pair:code',
  pairRelayStatus: 'openbots:pair:relay-status',
  pairClose: 'openbots:pair:close',
  /** main → renderer: a phone used the window's code. */
  pairPaired: 'openbots:pair:paired',
} as const;

/**
 * What the web app reads as `window.openbots.platform` to turn on native
 * features. A browser has no `window.openbots`.
 */
export interface DesktopUpdateNotice {
  version: string;
  action: 'download' | 'restart';
  busy: boolean;
}

export interface PlatformInfo {
  kind: 'desktop';
  /** `process.platform` of the Mac app's host: 'darwin', later 'win32' and 'linux'. */
  os: string;
  /** The app version. */
  version: string;
  /** The shell shows approvals, questions, mentions and Routine exceptions natively (N1). */
  nativeNotifications: boolean;
  /**
   * The window draws the system material behind a clear page for the web app's
   * Liquid Glass (macOS 26 and later, main window only). Missing before it.
   */
  liquidGlass?: boolean;
}

/**
 * How the app reaches its server: `local` runs the bundled stack on this Mac
 * in Docker; `cloud` is the hosted OpenBots server and `remote` a self-hosted
 * one; `paired` is another OpenBots server, often another Mac's This Mac,
 * that this Mac paired with as a device and reaches through its relay
 * (docs/RELAY_PROTOCOL.md). All but `local` are thin clients that never touch
 * Docker.
 */
export type ProfileKind = 'local' | 'remote' | 'cloud' | 'paired';

/** What a paired profile pins from the pairing link; the device's keys are kept apart, sealed. */
export interface PairedServer {
  /** The server's host id at the relay. */
  hostId: string;
  /** The relay's wss:// URL. */
  relayUrl: string;
  /** The server's tunnel key (X25519 public key, base64url), pinned for the Noise handshake. */
  serverKey: string;
  /** This Mac's device id on that server. */
  deviceId: string;
}

/** A server the app can open: the local stack, the hosted server, or any tunnel or remote URL. */
export interface ServerProfile {
  id: string;
  name: string;
  /**
   * The server's origin, e.g. `http://localhost:3000` or
   * `https://openbots.example.com`. A paired server's is the loopback address
   * of the app's own proxy into its tunnel, e.g. `http://127.0.0.1:41234`.
   */
  url: string;
  kind: ProfileKind;
  /** A paired server's relay and keys; set for `paired` only. */
  paired?: PairedServer;
}

export interface ProfilesView {
  activeId: string;
  profiles: ServerProfile[];
  /** The owner has picked a connection; until then the app shows the three choices. */
  chosen: boolean;
}

export interface QuickAskBot {
  id: string;
  name: string;
}

export interface QuickAskResult {
  botId: string;
  seq: number;
}

/** What the welcome screen needs to offer the three choices. */
export interface ConnectOptions {
  /** The hosted OpenBots server from the build; null disables "Sign in to an OpenBots account". */
  cloudUrl: string | null;
  /** A connection was chosen before: the welcome screen came from "Change connection…". */
  chosen: boolean;
}

/** A self-hosted server that answered as an OpenBots server. */
export interface ServerCheckResult {
  url: string;
  setupRequired: boolean;
  /** Shown for plain http on a private network. */
  warning: string | null;
}

/** The local stack as the indicator shows it: This Mac only. */
export interface LocalStackHealth {
  state: 'running' | 'unhealthy' | 'stopped';
  /** One line, as the start page says it. */
  text: string;
}

/**
 * How the app is connected, for the web app's indicator and the tray. A
 * paired server reports `remote`, which a web app of any version knows, with
 * its own label and the server's name as the host.
 */
export interface ConnectionInfo {
  kind: Exclude<ProfileKind, 'paired'>;
  /** "This Mac", "Self-hosted", "Paired" or "OpenBots account". */
  label: string;
  /** The server's host, e.g. `openbots.example.com` or `localhost:3000`. */
  host: string;
  url: string;
  /** This Mac only; a thin client (cloud, remote) never asks Docker. */
  stack?: LocalStackHealth;
}

/**
 * The relay a phone reaches the server through, as the pairing window shows
 * it. On This Mac it is the project's shared relay unless the owner set their
 * own in the app's Relay setting, which writes OPENBOTS_RELAY_URL into the
 * stack's `.env`; on any other connection the server's owner sets it.
 */
export interface PairRelayView {
  /** This Mac: the window may change the relay. */
  local: boolean;
  /** The project's shared relay. */
  sharedUrl: string;
  /** The relay the server runs with, from `GET /api/v1/relay`; null for none. */
  current: string | null;
}

/** The server's link to its relay, from `GET /api/v1/relay`. */
export interface PairRelayStatus {
  status: 'off' | 'connecting' | 'linked';
  /** Why the server's last attempt to link failed, while connecting; null otherwise. */
  error: string | null;
}

/** A pairing code for the window's QR code. */
export interface PairCode {
  /** The `openbots://pair#...` link the QR code shows. */
  link: string;
  expiresAt: string;
  /** The server's clock less this Mac's, from the response's `Date` header; 0 without one. */
  skewMs: number;
}
