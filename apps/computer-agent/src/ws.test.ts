import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PtyServerMessage, ScreenInfo } from './protocol.js';
import type { ScreenManager } from './screens.js';
import { fakeVncServer, tempHome, TEST_TOKEN } from './test-utils.js';
import { Users } from './users.js';
import { attachWebSockets, loadPty, ptySession, type NodePty } from './ws.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function startAgent(screens: Partial<ScreenManager> = {}) {
  const home = await tempHome();
  const server: Server = createServer((_req, res) => res.writeHead(426).end());
  const sockets = attachWebSockets(server, {
    token: TEST_TOKEN,
    home,
    screens: {
      get: () => undefined,
      vncPassword: () => undefined,
      vnc: () => {
        throw new Error('no screen');
      },
      ...screens,
    } as unknown as ScreenManager,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())), sockets.close);
  const port = (server.address() as AddressInfo).port;
  return { home, url: (p: string) => `ws://127.0.0.1:${port}${p}` };
}

function open(url: string, opts: WebSocket.ClientOptions = {}, protocols?: string[]) {
  const ws = new WebSocket(url, protocols, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...opts,
  });
  cleanups.push(() => {
    ws.on('error', () => {});
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  return ws;
}

const upgradeStatus = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => resolve(101));
  });

describe('WS auth', () => {
  it('refuses an upgrade without the token, by header or query', async () => {
    const { url } = await startAgent();
    expect(await upgradeStatus(new WebSocket(url('/pty')))).toBe(401);
    expect(
      await upgradeStatus(open(url('/pty'), { headers: { authorization: 'Bearer nope' } })),
    ).toBe(401);
    // Authorized: a shell, or 503 where node-pty is missing (ws-no-pty.test.ts).
    expect(await upgradeStatus(new WebSocket(url(`/pty?token=${TEST_TOKEN}`)))).toBe(
      (await loadPty()) ? 101 : 503,
    );
    expect(await upgradeStatus(open(url('/elsewhere')))).toBe(404);
  });
});

// node-pty is optional; without a C++ toolchain its binding is not built.
describe.skipIf(!(await loadPty()))('WS /pty', () => {
  it('runs a shell in the home directory, takes input and resizes', async () => {
    const { url, home } = await startAgent();
    const ws = open(url('/pty?cols=100&rows=30'));
    let output = '';
    let exit: PtyServerMessage | undefined;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as PtyServerMessage;
      if (msg.type === 'output') output += msg.data;
      else exit = msg;
    });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(check()).toBe(true);
    };
    await new Promise((r) => ws.once('open', r));
    const input = (data: string) => ws.send(JSON.stringify({ type: 'input', data }));
    // `echo A""B` prints AB, which the echoed command line does not contain.
    input('stty size; pwd; echo ONE""DONE\r');
    await until(() => output.includes('ONEDONE'));
    expect(output).toContain('30 100');
    expect(output).toContain(home);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    input('stty size; exit 7\r');
    await until(() => exit !== undefined);
    expect(exit).toEqual({ type: 'exit', exitCode: 7 });
    expect(output).toContain('40 120');
  });

  it('opens in a worktree under the home and types the preset without running it (I15)', async () => {
    const { url, home } = await startAgent();
    await mkdir(path.join(home, 'repos/acme/app'), { recursive: true });
    const preset = encodeURIComponent('echo PRE""SET\n');
    const ws = open(url(`/pty?cwd=repos/acme/app&preset=${preset}`));
    let output = '';
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as PtyServerMessage;
      if (msg.type === 'output') output += msg.data;
    });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(check()).toBe(true);
    };
    await new Promise((r) => ws.once('open', r));
    // Typed: on the line, not run, since the newline was taken out.
    await until(() => output.includes('echo PRE""SET'));
    await new Promise((r) => setTimeout(r, 200));
    expect(output).not.toContain('PRESET');
    ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    await until(() => output.includes('PRESET'));
    ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    await until(() => output.includes(path.join(home, 'repos/acme/app')));
  });

  it('refuses a cwd outside the home before the upgrade', async () => {
    const { url } = await startAgent();
    expect(await upgradeStatus(open(url('/pty?cwd=/etc')))).toBe(403);
    expect(await upgradeStatus(open(url('/pty?cwd=../..')))).toBe(403);
    expect(await upgradeStatus(open(url('/pty?user=root')))).toBe(400);
  });

  it('kills the shell when the client goes away', async () => {
    const { url } = await startAgent();
    const ws = open(url('/pty'));
    const pid = await new Promise<number>((resolve) => {
      ws.on('message', (raw) => {
        const m = /PID=(\d+)/.exec((JSON.parse(raw.toString()) as { data?: string }).data ?? '');
        if (m) resolve(Number(m[1]));
      });
      ws.once('open', () => ws.send(JSON.stringify({ type: 'input', data: 'echo PID=$$\r' })));
    });
    ws.close();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });
});

describe('WS /vnc/:n', () => {
  async function vncServer(password: string) {
    const vnc = await fakeVncServer(password);
    cleanups.push(() => new Promise<void>((r) => vnc.server.close(() => r())));
    return vnc;
  }

  /** Reads exactly `n` bytes from the binary frames, however they were split. */
  function frames(ws: WebSocket) {
    const received: Buffer[] = [];
    let wake: (() => void) | undefined;
    ws.on('message', (data) => {
      received.push(data as Buffer);
      wake?.();
    });
    return async (n: number) => {
      for (;;) {
        const all = Buffer.concat(received);
        if (all.length >= n) {
          received.length = 0;
          if (all.length > n) received.push(all.subarray(n));
          return all.subarray(0, n);
        }
        await new Promise<void>((r) => (wake = r));
      }
    };
  }

  const screens = (info: ScreenInfo, password: string, socket: string) => ({
    get: (n: number) => (n === info.n ? info : undefined),
    vncPassword: (n: number) => (n === info.n ? password : undefined),
    vnc: (n: number) => {
      expect(n).toBe(info.n);
      return connect(socket);
    },
  });

  it('logs in to x11vnc with the screen password and lets the client in without one (S-7)', async () => {
    const vnc = await vncServer('Zx9-k_Q2');
    const info = { n: 2 } as ScreenInfo;
    const { url } = await startAgent(screens(info, 'Zx9-k_Q2', vnc.socket));
    const ws = open(url('/vnc/2'), {}, ['binary']);
    const take = frames(ws);
    await new Promise((r) => ws.once('open', r));
    expect(ws.protocol).toBe('binary');
    expect((await take(12)).toString()).toBe('RFB 003.008\n');
    ws.send(Buffer.from('RFB 003.008\n'));
    // One security type: none.
    expect([...(await take(2))]).toEqual([1, 1]);
    ws.send(Buffer.from([1]));
    expect([...(await take(4))]).toEqual([0, 0, 0, 0]);
    ws.send(Buffer.from([1])); // ClientInit
    expect([...(await take(4))]).toEqual([4, 0, 3, 0]);
    expect(vnc.logins).toEqual({ ok: 1, failed: 0 });
    ws.send(Buffer.from([1, 2, 3]));
    expect([...(await take(3))]).toEqual([1, 2, 3]);
  });

  it('closes the preview when x11vnc refuses the password', async () => {
    const vnc = await vncServer('right-pw');
    const info = { n: 2 } as ScreenInfo;
    const { url } = await startAgent(screens(info, 'wrong-pw', vnc.socket));
    const ws = open(url('/vnc/2'), {}, ['binary']);
    const received: Buffer[] = [];
    ws.on('message', (d) => received.push(d as Buffer));
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(1011);
    expect(received).toEqual([]);
    expect(vnc.logins).toEqual({ ok: 0, failed: 1 });
  });

  it('answers 404 for a screen that is not running', async () => {
    const { url } = await startAgent();
    expect(await upgradeStatus(open(url('/vnc/3')))).toBe(404);
    expect(await upgradeStatus(open(url('/vnc/x')))).toBe(404);
  });
});

describe('ptySession', () => {
  it("starts the owner's shell as the bot user through the helper (S-7)", () => {
    let started: { file: string; args: string[] } | undefined;
    const nodePty: NodePty = {
      spawn: (file, args) => {
        started = { file, args };
        return {
          onData: () => {},
          onExit: () => {},
          write: () => {},
          resize: () => {},
          kill: () => {},
        };
      },
    };
    const ws = { on: () => {}, readyState: 1, OPEN: 1 } as unknown as WebSocket;
    const users = new Users('/usr/local/libexec/openbots/runas');
    ptySession(ws, new URL('http://agent/pty'), { home: '/home/bot', users }, nodePty);
    expect(started).toEqual({
      file: '/usr/local/libexec/openbots/runas',
      args: ['1000', '1000', '--', '/bin/bash', '-l'],
    });
  });

  it('starts the shell without the agent token (S-7)', async () => {
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = TEST_TOKEN;
    try {
      let env: Record<string, string> | undefined;
      const nodePty: NodePty = {
        spawn: (_file, _args, options) => {
          env = options.env;
          return {
            onData: () => {},
            onExit: () => {},
            write: () => {},
            resize: () => {},
            kill: () => {},
          };
        },
      };
      const ws = { on: () => {}, readyState: 1, OPEN: 1 } as unknown as WebSocket;
      ptySession(ws, new URL('http://agent/pty'), { home: '/home/bot' }, nodePty);
      expect(env).toMatchObject({ HOME: '/home/bot', TERM: 'xterm-256color' });
      expect(env!.OPENBOTS_AGENT_TOKEN).toBeUndefined();
      expect(Object.values(env!)).not.toContain(TEST_TOKEN);
    } finally {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    }
  });

  const recorder = () => {
    const seen: { file?: string; args?: string[]; options?: Parameters<NodePty['spawn']>[2] } = {};
    const writes: string[] = [];
    let onData: ((data: string) => void) | undefined;
    const nodePty: NodePty = {
      spawn: (file, args, options) => {
        Object.assign(seen, { file, args, options });
        return {
          onData: (l) => (onData = l),
          onExit: () => {},
          write: (d) => writes.push(d),
          resize: () => {},
          kill: () => {},
        };
      },
    };
    return { seen, writes, nodePty, data: (d: string) => onData?.(d) };
  };
  const fakeWs = () =>
    ({ on: () => {}, readyState: 1, OPEN: 1, send: () => {} }) as unknown as WebSocket;
  const runas = new Users('/usr/local/libexec/openbots/runas');

  it("opens the coder user's shell, under umask 002, with the agents' config directories (I15)", () => {
    const r = recorder();
    ptySession(
      fakeWs(),
      new URL('http://agent/pty?user=coder'),
      { home: '/home/bot', users: runas, stateDir: '/var/lib/openbots' },
      r.nodePty,
      '/home/bot/repos/acme/app/.worktrees/fix',
    );
    expect(r.seen.file).toBe('/usr/local/libexec/openbots/runas');
    expect(r.seen.args).toEqual([
      '1800',
      '1800',
      '--',
      '/bin/sh',
      '-c',
      'umask 002 && exec "$0" "$@"',
      '/bin/bash',
      '-l',
    ]);
    expect(r.seen.options?.cwd).toBe('/home/bot/repos/acme/app/.worktrees/fix');
    expect(r.seen.options?.env).toMatchObject({
      HOME: '/var/lib/openbots/coders/home',
      CLAUDE_CONFIG_DIR: '/var/lib/openbots/coders/claude',
      CODEX_HOME: '/var/lib/openbots/coders/codex',
      PI_CODING_AGENT_DIR: '/var/lib/openbots/coders/pi',
    });
  });

  it("gives the bot user's shell in a worktree the coders group, and none without one", () => {
    const inTree = recorder();
    ptySession(
      fakeWs(),
      new URL('http://agent/pty'),
      { home: '/home/bot', users: runas },
      inTree.nodePty,
      '/home/bot/repos/a',
    );
    expect(inTree.seen.args?.slice(0, 2)).toEqual(['1000', '1800']);
    const plain = recorder();
    ptySession(
      fakeWs(),
      new URL('http://agent/pty'),
      { home: '/home/bot', users: runas },
      plain.nodePty,
    );
    expect(plain.seen.args).toEqual(['1000', '1000', '--', '/bin/bash', '-l']);
    expect(plain.seen.options?.cwd).toBe('/home/bot');
  });

  it('types the preset once the shell has printed, with no newline or control characters', async () => {
    const r = recorder();
    const preset = encodeURIComponent('claude --resume abc\r\nrm -rf ~\u001b[A');
    ptySession(
      fakeWs(),
      new URL(`http://agent/pty?preset=${preset}`),
      { home: '/home/bot' },
      r.nodePty,
    );
    expect(r.writes).toEqual([]);
    r.data('$ ');
    r.data('more');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.writes).toEqual(['claude --resume abcrm -rf ~[A']);
  });
});
