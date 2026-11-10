import { chmodSync, chownSync, existsSync, readFileSync } from 'node:fs';

// Who stdio servers run as, and keeping them out of the server's own process
// (S-1). When OpenBots may switch users (root, or a non-root process holding
// CAP_SETUID and CAP_SETGID) each child runs as `nobody` with no capabilities
// at all (`launchAs`), and the server makes itself non-dumpable so that user
// cannot read its /proc/<pid>/environ or memory. The compose service starts the
// image as root with only those two capabilities, and docker/entrypoint.sh
// hands them to uid 1000 as ambient capabilities, so the default install runs
// this way. No relative imports, so a test can load
// this file alone.

const CAP_SETGID = 6n;
const CAP_SETUID = 7n;

/** util-linux's setpriv, in every Debian image (util-linux is essential). */
export const SETPRIV = '/usr/bin/setpriv';

/** Whether this process may set any uid and gid: CAP_SETUID and CAP_SETGID in its effective set. */
export function canSwitchUser(status?: string): boolean {
  let text = status;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/status', 'utf8');
    } catch {
      // No procfs (not Linux): only root can.
      return typeof process.getuid === 'function' && process.getuid() === 0;
    }
  }
  const hex = /^CapEff:\s*([0-9a-f]+)$/im.exec(text)?.[1];
  if (!hex) return false;
  const caps = BigInt(`0x${hex}`);
  return Boolean(caps & (1n << CAP_SETUID)) && Boolean(caps & (1n << CAP_SETGID));
}

/**
 * Makes this process non-dumpable, so no process of another user (and no
 * process of the same user without CAP_SYS_PTRACE) can read its
 * /proc/<pid>/environ and memory or attach a debugger (S-1). Node has no
 * prctl(PR_SET_DUMPABLE) without a native module, but the kernel resets the
 * dumpable flag to fs.suid_dumpable (0 by default) whenever the effective gid
 * changes (prctl(2)), so switching the effective gid away and back does it.
 * That needs CAP_SETGID; without it this returns false and changes nothing.
 * Call it once at start-up; it lasts until the next exec.
 */
export function makeNonDumpable(): boolean {
  if (typeof process.getegid !== 'function' || typeof process.setegid !== 'function') return false;
  if (!canSwitchUser()) return false;
  const egid = process.getegid();
  process.setegid(egid === 65534 ? 65533 : 65534);
  process.setegid(egid);
  return true;
}

/** The unprivileged user stdio servers run as when OpenBots can switch users. */
export function unprivilegedUser(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== 'function' || !canSwitchUser()) return null;
  try {
    const line = readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('nobody:'));
    const [, , uid, gid] = line?.split(':') ?? [];
    if (uid && gid) return { uid: Number(uid), gid: Number(gid) };
  } catch {
    // fall through to the conventional ids
  }
  return { uid: 65534, gid: 65534 };
}

/**
 * Hands a directory the server made to the user a child runs as. Without
 * CAP_CHOWN (a server given only CAP_SETUID and CAP_SETGID) it is opened up
 * instead; every stdio child runs as that one user anyway.
 */
export function giveTo(dir: string, user: { uid: number; gid: number }): void {
  try {
    chownSync(dir, user.uid, user.gid);
  } catch {
    chmodSync(dir, 0o777);
  }
}

/** What to spawn so a stdio server runs as `user`; `uid` and `gid` go to `spawn` when set. */
export interface Launch {
  command: string;
  args: string[];
  uid?: number;
  gid?: number;
}

/**
 * Starts `command` as `user` holding no capabilities (S-1). `spawn`'s own uid
 * option is not enough for a non-root server: the kernel clears capabilities
 * on a uid change only when it leaves uid 0, so a child of a uid 1000 server
 * holding ambient CAP_SETUID would keep it through exec and could become any
 * user, the server's included. setpriv changes the uid, clears the
 * inheritable and ambient sets (which leaves nothing for exec to carry over)
 * and sets no_new_privs, so no setuid binary or file capability gives any
 * back. It execs the command, so the child's pid, stdio and signals are the
 * command's own. Without setpriv only a root server may switch, as leaving
 * uid 0 clears everything.
 */
export function launchAs(
  user: { uid: number; gid: number },
  command: string,
  args: string[],
  { setpriv = SETPRIV, uid = process.getuid?.() }: { setpriv?: string; uid?: number } = {},
): Launch {
  if (existsSync(setpriv)) {
    return {
      command: setpriv,
      args: [
        `--reuid=${user.uid}`,
        `--regid=${user.gid}`,
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        command,
        ...args,
      ],
    };
  }
  if (uid === 0) return { command, args, uid: user.uid, gid: user.gid };
  throw new Error(
    `${setpriv} (util-linux) is needed to run stdio servers as another user without passing on this process's capabilities`,
  );
}

/**
 * A process's start time, field 22 of /proc/<pid>/stat (clock ticks since
 * boot), or undefined without procfs or once the process is gone. A pid can be
 * reused once its process is reaped; the pair (pid, start time) cannot, since
 * exec keeps the start time and a new process gets a later one. The comm
 * field may hold spaces and parentheses, so fields are counted from its last
 * closing parenthesis.
 */
export function processStartTime(pid: number, proc = '/proc'): string | undefined {
  try {
    return parseStartTime(readFileSync(`${proc}/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The start time in a /proc/<pid>/stat line (exported for tests). */
export function parseStartTime(stat: string): string | undefined {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state), so field 22 is fields[19].
  const start = fields[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}

/**
 * The helper's script: `$1` signal name, `$2` pid, `$3` the start time the
 * pid had when it was spawned, `$4` procfs. It signals only if the pid still
 * belongs to that process. If the child was reaped meanwhile and its pid
 * reused, even by another stdio server running as the same user, it exits 3
 * and signals nothing. What is left is the time between its own read and
 * `kill`, in which the child would have to be reaped and the kernel hand out
 * the same pid again, which takes a full turn of the pid space.
 */
export const KILL_SCRIPT = [
  'set -f',
  'stat=$(cat "$4/$2/stat" 2>/dev/null) || exit 3',
  'rest=${stat##*) }',
  '# shellcheck disable=SC2086 # split into the fields after comm: field 3 is $4, field 22 is ${23}',
  'set -- "$1" "$2" "$3" $rest',
  '[ "${23}" = "$3" ] || exit 3',
  'kill -s "$1" "$2"',
].join('\n');

/** The helper's exit status when the pid no longer belongs to the child. */
export const KILL_REFUSED = 3;

/**
 * How to send `signal` to a child started by `launchAs`, or null when this
 * process may signal it itself (as root, or when it runs as this process's
 * own user). A uid 1000 server holding only CAP_SETUID and CAP_SETGID has no
 * CAP_KILL, so the kernel refuses its signals to a child running as `nobody`
 * (EPERM). Instead a short-lived helper takes the child's user, through
 * setpriv as in `launchAs`, checks that the pid still has the start time
 * recorded at spawn (`KILL_SCRIPT`), and sends the signal with the shell's
 * built-in `kill` (procps is not in the slim image). The pid, signal and
 * start time go in as arguments, never into the script.
 */
export function killCommand(
  user: { uid: number; gid: number },
  pid: number,
  signal: NodeJS.Signals,
  startTime: string | undefined,
  {
    setpriv = SETPRIV,
    uid = process.getuid?.(),
    proc = '/proc',
  }: { setpriv?: string; uid?: number; proc?: string } = {},
): Launch | null {
  if (uid === undefined || uid === 0 || uid === user.uid) return null;
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid pid ${pid}`);
  if (!/^SIG[A-Z0-9]+$/.test(signal)) throw new Error(`invalid signal ${signal}`);
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error(`no start time recorded for pid ${pid}; refusing to signal it as another user`);
  }
  const { args } = launchAs(
    user,
    '/bin/sh',
    ['-c', KILL_SCRIPT, 'kill', signal.slice(3), String(pid), startTime, proc],
    { setpriv, uid },
  );
  return { command: setpriv, args };
}
