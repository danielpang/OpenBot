import type { ServerProfile } from '../ipc.js';
import type { Refusal, ServerGate } from './server-gate.js';

// The one way the main window comes to show a server (plan 14.4): launch,
// activate, the start page's Open and the saved connections, the connection
// choices, the tray, the menu, deep links and notification clicks all open
// through here. The window is made on the app's own pages, and goes to the
// server only once it passed the gate (./server-gate.ts); otherwise it shows
// the start page with why. Plain, so it is tested without Electron;
// ./index.ts gives it the main window.

export interface OpenerWindows<W> {
  /**
   * The main window for the profile: the current one when it has the
   * profile's session (taking the profile's current URL), else a new one that
   * replaces it. A new one loads nothing until told to.
   */
  forProfile(profile: ServerProfile): Promise<W>;
  /** The main window shows the profile's web app, loaded: it can go to a path in place. */
  showsServer(window: W, profile: ServerProfile): boolean;
  /** Restores the profile's saved sign-in, and the main process's connection with it. */
  signIn(profile: ServerProfile): Promise<void>;
  /** Drops the main process's connection to a server that did not pass. */
  signOut(profile: ServerProfile): void;
  load(window: W, url: string): Promise<void>;
  /** The web app goes to `path` itself. */
  navigate(window: W, path: string): void;
  showStart(window: W, profile: ServerProfile, refusal: Refusal): Promise<void>;
}

export interface OpenResult<W> {
  window: W;
  /** The server passed and its page is loading; otherwise the start page says why. */
  opened: boolean;
}

export interface Opener<W> {
  /** Checks the profile's server, then loads `path` of it, or shows the start page. */
  open(profile: ServerProfile, path?: string): Promise<OpenResult<W>>;
  /** A path of the web app: in place when the window shows it, else through `open`. */
  openPath(profile: ServerProfile, path: string): Promise<OpenResult<W>>;
}

export function createOpener<W>(options: {
  gate: ServerGate;
  windows: OpenerWindows<W>;
}): Opener<W> {
  const { gate, windows } = options;

  async function open(profile: ServerProfile, path = '/'): Promise<OpenResult<W>> {
    const window = await windows.forProfile(profile);
    const verdict = await gate.verify(profile);
    if (!verdict.ok) {
      windows.signOut(profile);
      await windows.showStart(window, profile, verdict).catch(() => undefined);
      return { window, opened: false };
    }
    await windows.signIn(profile);
    await windows.load(window, new URL(path, profile.url).toString()).catch(() => undefined);
    return { window, opened: true };
  }

  return {
    open,

    async openPath(profile, path) {
      const window = await windows.forProfile(profile);
      // A page the window shows came through the gate.
      if (windows.showsServer(window, profile)) {
        windows.navigate(window, path);
        return { window, opened: true };
      }
      return open(profile, path);
    },
  };
}
