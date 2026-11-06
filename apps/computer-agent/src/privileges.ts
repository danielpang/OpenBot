import { chmod, chown, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MIN_TOKEN_LENGTH } from './config.js';
import { MAX_SCREEN } from './protocol.js';
import { cookieStoreDir } from './cookies.js';
import { screenPaths } from './screens.js';
import { coderPaths, CODER_AGENT_DIRS } from './coder-paths.js';
import {
  BOT_ID,
  CODER,
  CODERS_GID,
  RUNNER,
  screenIdentity,
  STORE,
  type Identity,
} from './users.js';

// What the agent does as root, before it listens (S-7). The container starts
// it as uid 0 with only CHOWN, SETUID and SETGID, under no-new-privileges.
// It takes the token from the file the provider wrote and deletes it, lays
// out the directories each screen's user owns, then drops its effective uid
// to the bot user for good. Root stays its real and saved uid, which is what
// lets openbots-runas (native/runas.c) switch users for it, and keeps the
// Bots' commands, which run as the bot user, from signalling, tracing or
// reading it. Changing the effective uid also makes it non-dumpable, so its
// /proc files are root's.

const ROOT: Identity = { uid: 0, gid: 0 };

/**
 * Reads the agent token from `file` and deletes it. `owner` is the uid the
 * file must belong to; it must be readable by its owner only.
 */
export async function takeToken(file: string, owner: number): Promise<string> {
  const s = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new Error(`No agent token: ${file} does not exist`);
    throw err;
  });
  if (!s.isFile()) throw new Error(`The agent token file ${file} is not a regular file`);
  if (s.uid !== owner || (s.mode & 0o077) !== 0) {
    throw new Error(`The agent token file ${file} must be uid ${owner}'s, mode 0400 or 0600`);
  }
  const token = (await readFile(file, 'utf8')).trim();
  await unlink(file);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The agent token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return token;
}

/**
 * Creates `dir` if it is missing and gives it `owner` and `mode`, refusing a
 * symlink or anything but a directory in its place. Root without CAP_FOWNER
 * may chmod only its own files, so the directory is root's while its mode
 * is set.
 */
export async function ensureDir(dir: string, owner: Identity, mode: number): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  const s = await lstat(dir);
  if (!s.isDirectory()) throw new Error(`${dir} is not a directory`);
  await chown(dir, ROOT.uid, ROOT.gid);
  await chmod(dir, mode);
  if (owner.uid !== ROOT.uid || owner.gid !== ROOT.gid) await chown(dir, owner.uid, owner.gid);
}

export interface Layout {
  runtimeDir: string;
  stateDir: string;
  /** Where Xvfb puts its sockets; root's and sticky, so no user can take another's. */
  x11Dir?: string;
}

/**
 * As root: every screen's directories, each its own user's (`screenPaths`),
 * the shared cookie store's, its own user's (`cookieStoreDir`), and the
 * coding agents' (I2): their config directories, the coder user's alone like
 * the cookie store, the coder and runner users' homes, each its own user's,
 * and the runtime directory their sessions' own directories go in
 * (coder.ts). That one is root's and the coders group's, mode 1730: the
 * agent (which keeps the group, `dropToBot`) and the coders group's users
 * may make a directory there and enter it, nobody may list it, so a
 * session id is never seen there, and the bot user's commands may not enter
 * it at all.
 */
export async function layOut({
  runtimeDir,
  stateDir,
  x11Dir = '/tmp/.X11-unix',
}: Layout): Promise<void> {
  await ensureDir(x11Dir, ROOT, 0o1777);
  await ensureDir(runtimeDir, ROOT, 0o755);
  await ensureDir(path.join(runtimeDir, 'screens'), ROOT, 0o711);
  await ensureDir(stateDir, ROOT, 0o711);
  await ensureDir(path.join(stateDir, 'screens'), ROOT, 0o711);
  await ensureDir(cookieStoreDir(stateDir), STORE, 0o700);
  const coders = coderPaths(runtimeDir, stateDir);
  await ensureDir(coders.stateDir, ROOT, 0o711);
  for (const agent of CODER_AGENT_DIRS) await ensureDir(coders.configDir(agent), CODER, 0o700);
  await ensureDir(coders.homeDir, CODER, 0o700);
  // The runner's (the server's git operations), closed to the coder user.
  await ensureDir(coders.runnerHomeDir, RUNNER, 0o700);
  await ensureDir(coders.sessionsDir, { uid: ROOT.uid, gid: CODERS_GID }, 0o1730);
  for (let n = 0; n <= MAX_SCREEN; n++) {
    const paths = screenPaths(runtimeDir, stateDir, n);
    const id = screenIdentity(n);
    // The screen's Bot's commands have its group: they may reach the cookie.
    await ensureDir(paths.run, id, 0o710);
    await ensureDir(paths.state, id, 0o700);
  }
}

/** The part of `process` that changes users, so a test can watch the order. */
export type Credentials = Required<Pick<NodeJS.Process, 'setgroups' | 'setegid' | 'seteuid'>>;

/**
 * Leaves root's effective uid for the bot user's; root stays the real and
 * saved uid. The agent keeps the coders group (and no other) so that it can
 * make the repositories directory and each coding session's own directory
 * the coders group's (`shareRepos`, coder.ts). Its children never inherit
 * it: openbots-runas clears the groups of every program it starts.
 */
export function dropToBot(proc = process as Credentials): void {
  proc.setgroups([CODERS_GID]);
  proc.setegid(BOT_ID);
  proc.seteuid(BOT_ID);
}

/**
 * As the bot user, which owns the home (root without CAP_DAC_OVERRIDE may not
 * write there): makes the repositories directory (I2). The bot user owns it,
 * `group` (the coders group, in the image) shares it, and setgid keeps every
 * clone and worktree under it in that group, so the coder user's agents and
 * the bot user's own commands both read and write them. Without `group` (a
 * dev machine) it is just the agent user's.
 */
export async function shareRepos(dir: string, group?: number): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  const s = await lstat(dir);
  if (!s.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (group === undefined) return chmod(dir, 0o775);
  // The owner may give a file to a group it is in; chmod then keeps setgid.
  await chown(dir, s.uid, group);
  await chmod(dir, 0o2775);
}
