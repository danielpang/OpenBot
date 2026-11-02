import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KILL_REFUSED,
  KILL_SCRIPT,
  SETPRIV,
  canSwitchUser,
  killCommand,
  launchAs,
  parseStartTime,
  processStartTime,
} from './privileges.js';

const PRIVILEGES = fileURLToPath(new URL('./privileges.ts', import.meta.url));

describe('canSwitchUser', () => {
  it('needs both CAP_SETUID and CAP_SETGID in the effective set', () => {
    expect(canSwitchUser('Name:\tnode\nCapEff:\t000001ffffffffff\n')).toBe(true);
    expect(canSwitchUser('CapEff:\t00000000000000c0\n')).toBe(true);
    expect(canSwitchUser('CapEff:\t0000000000000080\n')).toBe(false);
    expect(canSwitchUser('CapEff:\t0000000000000040\n')).toBe(false);
    expect(canSwitchUser('CapEff:\t0000000000000000\n')).toBe(false);
    expect(canSwitchUser('Name:\tnode\n')).toBe(false);
  });
});

describe('launchAs (S-1)', () => {
  const nobody = { uid: 65534, gid: 65534 };

  it('wraps the command in setpriv, which drops every capability before exec', () => {
    // Any existing file stands in for setpriv.
    const launch = launchAs(nobody, 'node', ['server.js', '--flag'], {
      setpriv: process.execPath,
      uid: 1000,
    });
    expect(launch).toEqual({
      command: process.execPath,
      args: [
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        'node',
        'server.js',
        '--flag',
      ],
    });
    expect(launch.uid).toBeUndefined();
  });

  it("falls back to spawn's own uid switch only as root, where leaving uid 0 clears every capability", () => {
    const missing = '/nonexistent/setpriv';
    expect(launchAs(nobody, 'node', ['s.js'], { setpriv: missing, uid: 0 })).toEqual({
      command: 'node',
      args: ['s.js'],
      uid: 65534,
      gid: 65534,
    });
    expect(() => launchAs(nobody, 'node', [], { setpriv: missing, uid: 1000 })).toThrow(
      /setpriv \(util-linux\) is needed/,
    );
  });

  it('defaults to the util-linux path', () => {
    expect(SETPRIV).toBe('/usr/bin/setpriv');
  });
});

describe('killCommand (S-1)', () => {
  const nobody = { uid: 65534, gid: 65534 };
  const fake = { setpriv: process.execPath, uid: 1000 };

  it('signals through a helper running as the child, which checks the start time first', () => {
    expect(killCommand(nobody, 4321, 'SIGTERM', '987654', fake)).toEqual({
      command: process.execPath,
      args: [
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        '/bin/sh',
        '-c',
        KILL_SCRIPT,
        'kill',
        'TERM',
        '4321',
        '987654',
        '/proc',
      ],
    });
  });

  it('leaves the signal to this process as root or when the child is its own user', () => {
    expect(killCommand(nobody, 4321, 'SIGKILL', '1', { ...fake, uid: 0 })).toBeNull();
    expect(killCommand(nobody, 4321, 'SIGKILL', '1', { ...fake, uid: 65534 })).toBeNull();
  });

  it('refuses a pid that would signal a group or every process', () => {
    for (const pid of [0, 1, -1, 1.5]) {
      expect(() => killCommand(nobody, pid, 'SIGTERM', '1', fake)).toThrow(/invalid pid/);
    }
  });

  it('refuses to signal another user without a start time to check', () => {
    for (const start of [undefined, '', '12a']) {
      expect(() => killCommand(nobody, 4321, 'SIGTERM', start, fake)).toThrow(/no start time/);
    }
  });
});

describe('parseStartTime', () => {
  const stat = (comm: string, start: string) =>
    `4321 (${comm}) S 1 4321 4321 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 10 18446744073709551615`;

  it('reads field 22, however odd the command name', () => {
    expect(parseStartTime(stat('node', '123456'))).toBe('123456');
    expect(parseStartTime(stat('a) S 1 (b', '77'))).toBe('77');
    expect(parseStartTime(stat('two words', '42'))).toBe('42');
    expect(parseStartTime('garbage')).toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux')('reads this process from procfs', () => {
    expect(processStartTime(process.pid)).toMatch(/^\d+$/);
    expect(processStartTime(2 ** 30)).toBeUndefined();
  });
});

// The helper's script run directly, as this user, against a fake procfs: it
// signals only a pid whose start time still matches the one recorded at spawn.
describe.skipIf(process.platform === 'win32')('KILL_SCRIPT (S-1)', () => {
  let dir: string | undefined;
  let target: ChildProcess | undefined;
  afterEach(() => {
    target?.kill('SIGKILL');
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = target = undefined;
  });

  async function run(recorded: string, onDisk: string | null) {
    dir = mkdtempSync(path.join(tmpdir(), 'openbots-kill-'));
    target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => target!.once('spawn', resolve));
    const pid = target.pid!;
    if (onDisk !== null) {
      mkdirSync(path.join(dir, String(pid)));
      writeFileSync(
        path.join(dir, String(pid), 'stat'),
        `${pid} (node (x) y) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${onDisk} 1000 10\n`,
      );
    }
    const res = spawnSync(
      '/bin/sh',
      ['-c', KILL_SCRIPT, 'kill', 'TERM', String(pid), recorded, dir],
      { encoding: 'utf8' },
    );
    const exit = await Promise.race([
      new Promise<NodeJS.Signals | null>((resolve) =>
        target!.once('exit', (_c, sig) => resolve(sig)),
      ),
      new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 500)),
    ]);
    return { status: res.status, exit };
  }

  it('signals the pid when its start time matches', async () => {
    expect(await run('555', '555')).toEqual({ status: 0, exit: 'SIGTERM' });
  });

  it('refuses a pid reused by another process (its start time differs)', async () => {
    expect(await run('555', '556')).toEqual({ status: KILL_REFUSED, exit: 'alive' });
  });

  it('refuses a pid that is gone', async () => {
    expect(await run('555', null)).toEqual({ status: KILL_REFUSED, exit: 'alive' });
  });
});

// Runs this file in a child as uid 1000, with or without CAP_SETUID and
// CAP_SETGID, and reports who owns its /proc entries before and after: the
// kernel hands a non-dumpable process's /proc files to root.
const asRoot = process.getuid?.() === 0 && existsSync('/usr/bin/setpriv');

function probe(caps: boolean) {
  const script = `
    const { statSync } = await import('node:fs');
    const { makeNonDumpable, unprivilegedUser } = await import(${JSON.stringify(PRIVILEGES)});
    const before = statSync('/proc/self/environ').uid;
    const changed = makeNonDumpable();
    const after = statSync('/proc/self/environ').uid;
    console.log(JSON.stringify({ before, changed, after, user: unprivilegedUser() }));
  `;
  const res = spawnSync(
    '/usr/bin/setpriv',
    [
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      ...(caps ? ['--inh-caps=+setuid,+setgid', '--ambient-caps=+setuid,+setgid'] : []),
      process.execPath,
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8' },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    before: number;
    changed: boolean;
    after: number;
    user: { uid: number } | null;
  };
}

describe.skipIf(!asRoot)('makeNonDumpable, as root (S-1)', () => {
  it('makes a uid 1000 server holding CAP_SETUID and CAP_SETGID non-dumpable and drops children to nobody', () => {
    const result = probe(true);
    expect(result).toMatchObject({ before: 1000, changed: true, after: 0 });
    expect(result.user?.uid).not.toBe(1000);
  });

  it('changes nothing without the capabilities, as in the default image', () => {
    expect(probe(false)).toEqual({ before: 1000, changed: false, after: 1000, user: null });
  });
});

// Like the compose service (docker/entrypoint.sh): a uid 1000 server holding
// CAP_SETUID and CAP_SETGID as ambient capabilities starts a child the way
// StdioTransport does, and the child reports who it is.
function probeChild() {
  const child = `
    const { readFileSync } = require('node:fs');
    const status = readFileSync('/proc/self/status', 'utf8');
    const cap = (name) => new RegExp('^' + name + ':\\s*(\\S+)$', 'm').exec(status)[1];
    let environ;
    try { environ = readFileSync('/proc/' + process.ppid + '/environ', 'utf8').includes('PROBE_SECRET='); }
    catch (err) { environ = err.code; }
    console.log(JSON.stringify({ uid: process.getuid(), eff: cap('CapEff'), prm: cap('CapPrm'), amb: cap('CapAmb'), environ }));
  `;
  const script = `
    const { spawnSync } = await import('node:child_process');
    const { launchAs, makeNonDumpable, unprivilegedUser } = await import(${JSON.stringify(PRIVILEGES)});
    makeNonDumpable();
    const launch = launchAs(unprivilegedUser(), process.execPath, ['-e', ${JSON.stringify(child)}]);
    const res = spawnSync(launch.command, launch.args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
  `;
  const res = spawnSync(
    '/usr/bin/setpriv',
    [
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      '--inh-caps=+setuid,+setgid',
      '--ambient-caps=+setuid,+setgid',
      process.execPath,
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', env: { ...process.env, PROBE_SECRET: 'master-key' } },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    uid: number;
    eff: string;
    prm: string;
    amb: string;
    environ: boolean | string;
  };
}

describe.skipIf(!asRoot)('launchAs, as root (S-1)', () => {
  it("starts a uid 1000 server's child as nobody with no capabilities, unable to read the server's environ", () => {
    const zero = '0000000000000000';
    expect(probeChild()).toEqual({
      uid: 65534,
      eff: zero,
      prm: zero,
      amb: zero,
      environ: 'EACCES',
    });
  });
});

// A uid 1000 server holding only CAP_SETUID and CAP_SETGID, as under compose,
// cannot signal its nobody child itself; the helper can.
describe.skipIf(!asRoot)('killCommand, as root (S-1)', () => {
  it("stops a child running as nobody, which the server's own kill cannot, and refuses a wrong start time", () => {
    const script = `
      const { spawn, spawnSync } = await import('node:child_process');
      const { killCommand, launchAs, processStartTime, unprivilegedUser } = await import(${JSON.stringify(PRIVILEGES)});
      const user = unprivilegedUser();
      const launch = launchAs(user, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      const child = spawn(launch.command, launch.args, { stdio: 'ignore' });
      await new Promise((resolve) => child.once('spawn', resolve));
      let direct;
      try { process.kill(child.pid, 'SIGTERM'); direct = 'sent'; } catch (err) { direct = err.code; }
      const start = processStartTime(child.pid);
      const wrong = killCommand(user, child.pid, 'SIGTERM', String(Number(start) + 1));
      const refused = spawnSync(wrong.command, wrong.args).status;
      const helper = killCommand(user, child.pid, 'SIGTERM', start);
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
      const res = spawnSync(helper.command, helper.args, { encoding: 'utf8' });
      console.log(JSON.stringify({ direct, refused, helper: res.status, signal: await exited }));
    `;
    const res = spawnSync(
      '/usr/bin/setpriv',
      [
        '--reuid=1000',
        '--regid=1000',
        '--clear-groups',
        '--inh-caps=+setuid,+setgid',
        '--ambient-caps=+setuid,+setgid',
        process.execPath,
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        script,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      direct: 'EPERM',
      refused: KILL_REFUSED,
      helper: 0,
      signal: 'SIGTERM',
    });
  });
});
