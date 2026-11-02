import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { cookieStoreDir } from './cookies.js';
import { dropToBot, ensureDir, layOut, takeToken } from './privileges.js';
import { screenPaths } from './screens.js';
import { tempHome } from './test-utils.js';

const root = process.getuid?.() === 0;
const cc = ['/usr/bin/cc', '/usr/bin/gcc'].find((p) => existsSync(p));
const mode = async (p: string) => (await lstat(p)).mode & 0o7777;
const owner = async (p: string) => {
  const s = await lstat(p);
  return [s.uid, s.gid];
};

describe('takeToken (S-7)', () => {
  const uid = process.getuid?.() ?? 0;

  it('reads the token from a private file and deletes it', async () => {
    const file = path.join(await tempHome(), 'token');
    await writeFile(file, `${'t'.repeat(43)}\n`, { mode: 0o400 });
    expect(await takeToken(file, uid)).toBe('t'.repeat(43));
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a file others may read, a symlink, another owner or no file', async () => {
    const dir = await tempHome();
    const open = path.join(dir, 'open');
    await writeFile(open, 't'.repeat(43), { mode: 0o644 });
    await chmod(open, 0o644);
    await expect(takeToken(open, uid)).rejects.toThrow(/mode 0400/);
    const link = path.join(dir, 'link');
    await symlink(open, link);
    await expect(takeToken(link, uid)).rejects.toThrow(/not a regular file/);
    const theirs = path.join(dir, 'theirs');
    await writeFile(theirs, 't'.repeat(43), { mode: 0o400 });
    await expect(takeToken(theirs, uid + 1)).rejects.toThrow(/must be uid/);
    await expect(takeToken(path.join(dir, 'none'), uid)).rejects.toThrow(/No agent token/);
    expect(existsSync(open)).toBe(true);
  });

  it('refuses a short token', async () => {
    const file = path.join(await tempHome(), 'token');
    await writeFile(file, 'short', { mode: 0o600 });
    await expect(takeToken(file, uid)).rejects.toThrow(/at least 16/);
  });
});

describe('dropToBot', () => {
  it('drops the groups and the gid before the uid, which would take the right to', () => {
    const calls: string[] = [];
    dropToBot({
      setgroups: (g) => void calls.push(`groups ${g.join(',')}`),
      setegid: (g) => void calls.push(`egid ${g}`),
      seteuid: (u) => void calls.push(`euid ${u}`),
    });
    expect(calls).toEqual(['groups ', 'egid 1000', 'euid 1000']);
  });
});

describe.skipIf(!root)('layOut (as root)', () => {
  async function laid() {
    const base = await tempHome();
    const dirs = {
      runtimeDir: path.join(base, 'run'),
      stateDir: path.join(base, 'state'),
      x11Dir: path.join(base, 'X11-unix'),
    };
    return { base, dirs };
  }

  it("gives each screen directories that only its user, and for the cookie its Bot's group, may enter", async () => {
    const { dirs } = await laid();
    await layOut(dirs);
    expect([await mode(dirs.x11Dir), await owner(dirs.x11Dir)]).toEqual([0o1777, [0, 0]]);
    for (const dir of [dirs.stateDir, path.join(dirs.stateDir, 'screens')]) {
      expect([await mode(dir), await owner(dir)]).toEqual([0o711, [0, 0]]);
    }
    expect(await mode(path.join(dirs.runtimeDir, 'screens'))).toBe(0o711);
    // The shared cookie store: its own user's, closed to the bot user and the screens (K1).
    const store = cookieStoreDir(dirs.stateDir);
    expect([await mode(store), await owner(store)]).toEqual([0o700, [1900, 1900]]);
    for (const n of [0, 7, 89]) {
      const paths = screenPaths(dirs.runtimeDir, dirs.stateDir, n);
      expect([await mode(paths.run), await owner(paths.run)]).toEqual([
        0o710,
        [2000 + n, 2000 + n],
      ]);
      expect([await mode(paths.state), await owner(paths.state)]).toEqual([
        0o700,
        [2000 + n, 2000 + n],
      ]);
    }
  });

  it('takes back a directory left with the wrong owner or mode', async () => {
    const { dirs } = await laid();
    const paths = screenPaths(dirs.runtimeDir, dirs.stateDir, 3);
    await mkdir(paths.state, { recursive: true });
    await chown(paths.state, 1000, 1000);
    await chmod(paths.state, 0o777);
    await writeFile(path.join(paths.state, 'kept'), 'profile data');
    await layOut(dirs);
    expect([await mode(paths.state), await owner(paths.state)]).toEqual([0o700, [2003, 2003]]);
    expect(await readFile(path.join(paths.state, 'kept'), 'utf8')).toBe('profile data');
  });

  it('refuses a symlink in place of a directory', async () => {
    const { base } = await laid();
    const link = path.join(base, 'link');
    await symlink('/etc', link);
    await expect(ensureDir(link, { uid: 2000, gid: 2000 }, 0o700)).rejects.toThrow(
      /not a directory/,
    );
    expect((await lstat('/etc')).uid).toBe(0);
  });
});

// The helper itself, compiled from native/runas.c, called the way the agent
// calls it: from a process whose effective uid is the bot user's and whose
// real uid is still root.
describe.skipIf(!root || !cc)('openbots-runas (as root)', () => {
  let helper: string;
  const source = fileURLToPath(new URL('../native/runas.c', import.meta.url));

  beforeAll(async () => {
    helper = path.join(await tempHome(), 'runas');
    execFileSync(cc!, ['-O2', '-Wall', '-Werror', '-static', '-o', helper, source]);
    await chmod(path.dirname(helper), 0o755);
  });

  /** Runs `args` through the helper from an agent that has dropped to the bot user. */
  function asAgent(args: string[]) {
    const script = `
      const { spawnSync } = require('node:child_process');
      process.setgroups([]); process.setegid(1000); process.seteuid(1000);
      const r = spawnSync(${JSON.stringify(helper)}, ${JSON.stringify(args)}, { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr,
        uid: process.getuid(), euid: process.geteuid(), pid: process.pid }));`;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: '/' });
    return JSON.parse(out.stdout) as {
      status: number;
      stdout: string;
      stderr: string;
      uid: number;
      euid: number;
    };
  }

  it('switches to a screen user with no other groups, no capabilities and no way back', () => {
    const r = asAgent([
      '2003',
      '2003',
      '--',
      '/bin/sh',
      '-c',
      'id -u; id -g; id -G; grep -E "^Cap(Prm|Eff)" /proc/self/status',
    ]);
    expect(r).toMatchObject({ status: 0, uid: 0, euid: 1000 });
    expect(r.stdout).toBe(
      '2003\n2003\n2003\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\n',
    );
  });

  it("runs a Bot's command as the bot user with the screen's group", () => {
    const r = asAgent(['1000', '2007', '--', '/bin/sh', '-c', 'id -u; id -G']);
    expect(r).toMatchObject({ status: 0, stdout: '1000\n2007\n' });
  });

  it("reads and writes the cookie store as the store's own user, with its group only (K1)", () => {
    const r = asAgent(['1900', '1900', '--', '/bin/sh', '-c', 'id -u; id -G']);
    expect(r).toMatchObject({ status: 0, stdout: '1900\n1900\n' });
  });

  it.each([
    ['0', '0'],
    ['1900', '1000'],
    ['1000', '1900'],
    ['1000', '0'],
    ['2003', '2004'],
    ['2090', '2090'],
    ['1999', '1999'],
    ['2003', '1000'],
    ['+2003', '2003'],
    ['2003x', '2003'],
  ])('refuses %s:%s, which is not a computer identity', (uid, gid) => {
    const r = asAgent([uid, gid, '--', '/usr/bin/id']);
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/not a computer identity/);
  });

  it('refuses to switch for anything but the agent, such as a command it started', () => {
    const r = asAgent(['1000', '1000', '--', helper, '2003', '2003', '--', '/usr/bin/id']);
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/only the control agent may switch users/);
  });

  describe('--clear-display', () => {
    const x11 = '/tmp/.X11-unix';
    // Screens 88 and 89: displays :98 and :99, clear of any real one.
    beforeAll(() => ensureDir(x11, { uid: 0, gid: 0 }, 0o1777));

    it("removes a file a Bot's command put at a screen's X socket, which its user could not", async () => {
      const squat = path.join(x11, 'X99');
      await writeFile(squat, 'not a server');
      await chown(squat, 1000, 1000);
      const asScreen = asAgent(['2089', '2089', '--', '/bin/rm', '-f', squat]);
      expect(asScreen.status).not.toBe(0);
      expect(existsSync(squat)).toBe(true);
      expect(asAgent(['--clear-display', '89'])).toMatchObject({ status: 0 });
      expect(existsSync(squat)).toBe(false);
      // Nothing there is fine too.
      expect(asAgent(['--clear-display', '89'])).toMatchObject({ status: 0 });
    });

    it('moves a directory that will not go out of the way, and touches nothing else', async () => {
      const squat = path.join(x11, 'X98');
      await mkdir(path.join(squat, 'inside'), { recursive: true });
      await chown(squat, 1000, 1000);
      await chown(path.join(squat, 'inside'), 1000, 1000);
      const neighbour = path.join(x11, 'X97');
      await writeFile(neighbour, 'screen 87');
      expect(asAgent(['--clear-display', '88'])).toMatchObject({ status: 0 });
      expect(existsSync(squat)).toBe(false);
      const aside = (await readdir(x11)).filter((name) => name.startsWith('.stale-X98-'));
      expect(aside).toHaveLength(1);
      expect(existsSync(neighbour)).toBe(true);
      await rm(path.join(x11, aside[0]!), { recursive: true });
      await rm(neighbour);
    });

    it.each(['90', '-1', 'x', '../1'])('refuses screen %s', (n) => {
      const r = asAgent(['--clear-display', n]);
      expect(r.status).toBe(126);
      expect(r.stderr).toMatch(/no such screen/);
    });

    it('refuses to clear a display for anything but the agent', async () => {
      const squat = path.join(x11, 'X99');
      await writeFile(squat, 'not a server');
      const r = asAgent(['1000', '1000', '--', helper, '--clear-display', '89']);
      expect(r.status).toBe(126);
      expect(r.stderr).toMatch(/only the control agent may clear a display/);
      expect(existsSync(squat)).toBe(true);
      await rm(squat);
    });
  });

  it("keeps the agent's /proc closed to the bot user's commands", () => {
    const script = `cat /proc/$PPID/environ >/dev/null 2>&1 && echo readable || echo closed`;
    const r = asAgent(['1000', '1000', '--', '/bin/sh', '-c', script]);
    // The shell's parent is the agent: the helper execs in place.
    expect(r.stdout).toBe('closed\n');
  });
});
