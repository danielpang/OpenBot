import { CODER_ID, CODERS_GID, RUNNER_ID } from '@openbots/shared';
import { MAX_SCREEN } from './protocol.js';

// Who each program the agent starts runs as (S-7). In the computer image the
// agent starts as root and drops its effective uid to the bot user
// (privileges.ts); from then on every child goes through the setuid-free
// helper `openbots-runas` (native/runas.c), which is the only way to another
// uid. Keep the identities here in step with the helper's checks; the coder,
// coders and runner ids are @openbots/shared's (coder-runtime.ts).
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
//   coder 1800:1800          every coding agent and every login (coder.ts,
//                            I2): its config directories on the state
//                            volume are closed to the bot user
//   runner 1801:1800         the server's own git operations (clone, fetch,
//                            scan, reconcile, rescue pushes; `user: 'runner'`
//                            on WS /coder): not coder, so no coding session
//                            can read their environment (/proc/<pid>/environ)
//                            and the credential relay's secret in it; the
//                            coders group, so it writes the repositories
//   1000:1800                the owner's own commands in a coding session
//                            (`user: 'bot'` on WS /coder, a session's
//                            terminal): still the bot user, with the coders
//                            group, which owns the repositories' files
//
// openbots-runas gives a program exactly one group, so "bot with the coders
// group" is the primary gid, not a supplementary one. The repositories stay
// shared between the two users because /home/bot/repos is setgid coders
// (privileges.ts `shareRepos`), every session runs under umask 002, and the
// server clones with core.sharedRepository=group.
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
/** The coder user, the coders group and the runner, from @openbots/shared (coder-runtime.ts). */
export { CODER_ID, CODERS_GID, RUNNER_ID };
/** Where the image installs the helper. */
export const RUNAS_PATH = '/usr/local/libexec/openbots/runas';

export const BOT: Identity = { uid: BOT_ID, gid: BOT_ID };
/** The cookie store's own user: its directory is closed to the bot user and the screens. */
export const STORE: Identity = { uid: STORE_ID, gid: STORE_ID };
/** The coding agents' own user (I2). */
export const CODER: Identity = { uid: CODER_ID, gid: CODERS_GID };
/** The server's git operations' own user, with the coders group: never a coding session's uid. */
export const RUNNER: Identity = { uid: RUNNER_ID, gid: CODERS_GID };
/** The bot user with the coders group: the owner's commands in a coding session's worktree. */
export const BOT_CODERS: Identity = { uid: BOT_ID, gid: CODERS_GID };

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
