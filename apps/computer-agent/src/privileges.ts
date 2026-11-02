import { chmod, chown, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MIN_TOKEN_LENGTH } from './config.js';
import { MAX_SCREEN } from './protocol.js';
import { cookieStoreDir } from './cookies.js';
import { screenPaths } from './screens.js';
import { BOT_ID, screenIdentity, STORE, type Identity } from './users.js';

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
 * and the shared cookie store's, its own user's (`cookieStoreDir`).
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

/** Leaves root's effective uid for the bot user's; root stays the real and saved uid. */
export function dropToBot(proc = process as Credentials): void {
  proc.setgroups([]);
  proc.setegid(BOT_ID);
  proc.seteuid(BOT_ID);
}
