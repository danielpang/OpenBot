import { posix } from 'node:path';
import { COMPUTER_HOME, STATE_DIR } from './types.js';

// Per-Bot screens (plan 9.1, K2): screen `n` on the agent is Xvfb display
// `:10+n` with its own Chromium profile, so a Bot's logins persist while
// files under /home/bot are shared by every Bot of the account. The profile
// is in the agent's state directory, which only the screen's user can enter
// (S-7), so the server resets it with `startScreen({ fresh: true })`, not
// through the file API. `bot_screens.display_number` holds the X display. One
// computer-use task per Bot at a time: `ScreenLocks` serializes a Bot's
// screen actions.

/** The agent's `DISPLAY_BASE`: screen `n` is display `:10+n`. */
export const FIRST_DISPLAY = 10;
/** The agent's `MAX_SCREEN`. */
export const MAX_SCREEN = 89;
const FIRST_CDP_PORT = 9222;

/** The lowest display number not in use on the computer. */
export function nextDisplay(taken: Iterable<number>): number {
  const used = new Set(taken);
  let display = FIRST_DISPLAY;
  while (used.has(display)) display++;
  if (display > FIRST_DISPLAY + MAX_SCREEN)
    throw new Error('Every screen on the computer is taken');
  return display;
}

/** The agent's screen number for an X display. */
export function screenNumber(display: number) {
  return display - FIRST_DISPLAY;
}

/**
 * The agent's old DevTools port for a display, still stored in
 * `bot_screens.cdp_port`; Chromium now talks CDP over a pipe (S-7).
 */
export function cdpPortFor(display: number) {
  return FIRST_CDP_PORT + screenNumber(display);
}

/** Chromium's user data dir for a display, as the agent lays it out (`profileDir`). */
export function browserProfileDir(display: number) {
  return `${STATE_DIR}/screens/screen-${screenNumber(display)}/profile`;
}

/**
 * A keyed async mutex: `run(key, fn)` runs `fn` once every earlier holder of
 * `key` is done. Runs of one Bot are already one at a time across workers
 * (the runs queue groups by Bot); this covers several screen calls in one
 * model step, and takeover hand-off, inside the process running the run.
 */
export class ScreenLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    try {
      await abortable(previous, signal);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  held(key: string) {
    return this.tails.has(key);
  }
}

function abortable(promise: Promise<void>, signal?: AbortSignal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A path on the computer, absolute and normalized: relative paths are under
 * /home/bot, `..` cannot climb above `/`. Throws on an empty path or a NUL.
 */
export function computerPath(path: string, { withinHome = false } = {}): string {
  const raw = path.trim();
  if (!raw || raw.includes('\0')) throw new Error('A path is required');
  const expanded = raw === '~' ? COMPUTER_HOME : raw.replace(/^~\//, `${COMPUTER_HOME}/`);
  const absolute = posix.resolve(COMPUTER_HOME, expanded);
  if (withinHome && absolute !== COMPUTER_HOME && !absolute.startsWith(`${COMPUTER_HOME}/`)) {
    throw new Error(
      `Only files under ${COMPUTER_HOME} are reachable here; use bash for ${absolute}`,
    );
  }
  return absolute;
}
