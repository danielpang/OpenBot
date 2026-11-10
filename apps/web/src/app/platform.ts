import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

// Where the app runs (plan 14.4). In the Mac app the preload exposes
// `window.openbots` with a `platform` context; a browser has none. Native
// features turn on from it: the shell shows notifications (N1), deep links
// and the tray open paths in the app through `onNavigate`, and the sidebar
// shows how the app is connected through `connection`.

export interface DesktopPlatform {
  kind: 'desktop';
  os: string;
  version: string;
  nativeNotifications: boolean;
}

export type Platform = { kind: 'web' } | DesktopPlatform;

/** How the Mac app reaches its server (apps/desktop `ConnectionInfo`). */
export interface DesktopConnectionInfo {
  /**
   * `local` runs the server on this Mac in Docker; `remote` is self-hosted, or
   * another Mac paired through its relay (`label` "Paired"); `cloud` an OpenBots account.
   */
  kind: 'local' | 'remote' | 'cloud';
  label: string;
  host: string;
  url: string;
  /** This Mac only. */
  stack?: { state: 'running' | 'unhealthy' | 'stopped'; text: string };
}

/** The connection part of the bridge; Start, Stop and Show logs work for This Mac only. */
export interface DesktopConnection {
  info(): Promise<DesktopConnectionInfo>;
  change(): Promise<void>;
  start(): Promise<DesktopConnectionInfo>;
  stop(): Promise<void>;
  showLogs(): Promise<void>;
}

/** The part of the Mac app's bridge every page gets (apps/desktop preload). */
interface DesktopBridge {
  platform: DesktopPlatform;
  onNavigate(listener: (path: string) => void): () => void;
  /** The File menu's New (Cmd+N); missing in app versions before it. */
  onNew?(listener: () => void): () => void;
  /** How the app is connected; missing in app versions before it. */
  connection?: DesktopConnection;
  /** A connector's sign-in in the default browser; missing in app versions before it. */
  oauth?: DesktopOAuth;
}

/** Opens a connector's sign-in page in the default browser, then brings the app back. */
export interface DesktopOAuth {
  open(url: string): Promise<void>;
  finished(): Promise<void>;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as { openbots?: Partial<DesktopBridge> }).openbots;
  return bridge?.platform?.kind === 'desktop' && typeof bridge.onNavigate === 'function'
    ? (bridge as DesktopBridge)
    : null;
}

export function platform(): Platform {
  return desktopBridge()?.platform ?? { kind: 'web' };
}

/** The Mac app shows approvals, questions, mentions and Routine exceptions itself. */
export function hasNativeNotifications(): boolean {
  const current = platform();
  return current.kind === 'desktop' && current.nativeNotifications;
}

/**
 * The Mac app's window has no title bar (`titleBarStyle: 'hiddenInset'`): the
 * page starts at the window's top edge and the traffic lights sit over the
 * sidebar's top left. False in a browser and on other systems.
 */
export function hasInsetTitleBar(): boolean {
  const current = platform();
  return current.kind === 'desktop' && current.os === 'darwin';
}

/**
 * Makes an element a handle that drags the Mac app's window. A drag region
 * takes every mouse event, so the links, buttons, fields and anything with a
 * hover title inside it opt out and stay clickable. Browsers ignore it.
 */
export const WINDOW_DRAG =
  '[-webkit-app-region:drag] [&_:is(a,button,input,select,textarea,[role=button],[title])]:[-webkit-app-region:no-drag]';

/** `WINDOW_DRAG` in the Mac app's window, nothing elsewhere. */
export function windowDragClass(): string | undefined {
  return hasInsetTitleBar() ? WINDOW_DRAG : undefined;
}

/** The Mac app's connection, or null in a browser and in app versions without it. */
export function desktopConnection(): DesktopConnection | null {
  const connection = desktopBridge()?.connection;
  return typeof connection?.info === 'function' ? connection : null;
}

/** The Mac app's OAuth bridge, or null in a browser and in app versions without it. */
export function desktopOAuth(): DesktopOAuth | null {
  const oauth = desktopBridge()?.oauth;
  return typeof oauth?.open === 'function' && typeof oauth.finished === 'function' ? oauth : null;
}

/** Opens the paths the Mac app sends (a clicked notification, the tray). */
export function useDesktopNavigation() {
  const router = useRouter();
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    return bridge.onNavigate((path) => void router.navigate({ href: path }));
  }, [router]);
}

/** The Mac app's File > New (Cmd+N) opens the sidebar's New; returns the unsubscribe. */
export function onDesktopNew(listener: () => void): () => void {
  const subscribe = desktopBridge()?.onNew;
  return typeof subscribe === 'function' ? subscribe(listener) : () => {};
}

export function DesktopNavigation() {
  useDesktopNavigation();
  return null;
}
