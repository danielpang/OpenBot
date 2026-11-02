import { MAX_SCREEN } from './protocol.js';

// Who each program the agent starts runs as (S-7). In the computer image the
// agent starts as root and drops its effective uid to the bot user
// (privileges.ts); from then on every child goes through the setuid-free
// helper `openbots-runas` (native/runas.c), which is the only way to another
// uid. Keep the identities here in step with the helper's checks.
//
//   bot 1000:1000            the terminal, and commands that name no screen
//   1000:(2000+n)            commands for the Bot of screen n: still the bot
//                            user, so the shared home works as before, with
//                            the group that may read screen n's Xauthority
//   screen-n (2000+n):(2000+n)  screen n's Xvfb, window manager, x11vnc,
//                            Chromium and the agent's xdotool, import and feh
//   cookies 1900:1900        the agent's reads and writes of the shared
//                            cookie store (cookies.ts), which no command and
//                            no screen may read
//
// Run anywhere else (a dev machine, the tests) the agent is unprivileged:
// `Users` without a helper starts programs as the agent itself.

export interface Identity {
  uid: number;
  gid: number;
}

export const BOT_ID = 1000;
export const SCREEN_ID_BASE = 2000;
export const STORE_ID = 1900;
/** Where the image installs the helper. */
export const RUNAS_PATH = '/usr/local/libexec/openbots/runas';

export const BOT: Identity = { uid: BOT_ID, gid: BOT_ID };
/** The cookie store's own user: its directory is closed to the bot user and the screens. */
export const STORE: Identity = { uid: STORE_ID, gid: STORE_ID };

/** Screen n's own user: its X server and every client the agent puts on it. */
export function screenIdentity(n: number): Identity {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SCREEN) throw new Error(`No screen ${n}`);
  return { uid: SCREEN_ID_BASE + n, gid: SCREEN_ID_BASE + n };
}

/** A command, as the bot user; for a screen's Bot, with that screen's group. */
export function commandIdentity(screen?: number): Identity {
  return screen === undefined ? BOT : { uid: BOT_ID, gid: screenIdentity(screen).gid };
}

export class Users {
  /** `helper` is the path of openbots-runas; without it every child runs as the agent. */
  constructor(readonly helper?: string) {}

  get privileged(): boolean {
    return this.helper !== undefined;
  }

  /** The program and arguments that run `command` as `id`. */
  command(id: Identity, command: string, args: string[]): { command: string; args: string[] } {
    if (!this.helper) return { command, args };
    return { command: this.helper, args: [String(id.uid), String(id.gid), '--', command, ...args] };
  }
}

/** Every child as the agent itself: a dev machine and the tests. */
export const UNPRIVILEGED = new Users();
