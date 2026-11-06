import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CoderSessions, sessionUser } from './coder.js';
import { coderPaths } from './coder-paths.js';
import { credentialGet } from './git-credential-helper.js';
import type { CoderClientMessageInput, CoderServerMessage } from './protocol.js';
import { loadPty } from './pty.js';
import type { ScreenManager } from './screens.js';
import { createTestAgent, json, tempHome, TEST_TOKEN } from './test-utils.js';
import { attachWebSockets } from './ws.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** An agent with `/coder`, its runtime directory short enough for unix sockets. */
async function startAgent(log?: (msg: string, extra?: Record<string, unknown>) => void) {
  const home = await tempHome();
  // The OS temp dir can be too deep for a socket path (macOS); /tmp is not.
  const base = await realpath(await mkdtemp('/tmp/ob-coder-'));
  const runtimeDir = path.join(base, 'run');
  const stateDir = path.join(base, 'state');
  const coders = new CoderSessions();
  const server: Server = createServer((_req, res) => res.writeHead(426).end());
  const sockets = attachWebSockets(server, {
    token: TEST_TOKEN,
    home,
    runtimeDir,
    stateDir,
    coders,
    credentialTimeoutMs: 300,
    ...(log ? { log } : {}),
    screens: { get: () => undefined } as unknown as ScreenManager,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () => rm(base, { recursive: true, force: true }),
    () => new Promise<void>((r) => server.close(() => r())),
    sockets.close,
  );
  const port = (server.address() as AddressInfo).port;
  return { home, runtimeDir, stateDir, coders, url: `ws://127.0.0.1:${port}/coder` };
}

interface Session {
  ws: WebSocket;
  frames: CoderServerMessage[];
  closed: Promise<number>;
  send(frame: CoderClientMessageInput): void;
  next<T extends CoderServerMessage['type']>(
    type: T,
    after?: number,
  ): Promise<Extract<CoderServerMessage, { type: T }>>;
  output(): string;
}

function open(url: string, ...first: CoderClientMessageInput[]): Session {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  const frames: CoderServerMessage[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as CoderServerMessage));
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  cleanups.push(() => {
    ws.on('error', () => {});
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  const session: Session = {
    ws,
    frames,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: async (type, after = 0) => {
      await vi.waitFor(() => expect(frames.slice(after).some((f) => f.type === type)).toBe(true), {
        timeout: 5000,
      });
      return frames.slice(after).find((f) => f.type === type) as never;
    },
    output: () =>
      frames
        .filter((f): f is Extract<CoderServerMessage, { type: 'stdout' }> => f.type === 'stdout')
        .map((f) => f.data)
        .join(''),
  };
  ws.once('open', () => first.forEach(session.send));
  return session;
}

const node = process.execPath;
const hasPty = Boolean(await loadPty());
const ID = 'session-0001-abcdef';

/** Prints what the session's process sees, as one JSON line. */
const REPORT = `
const e = process.env;
console.log(JSON.stringify({
  argv: process.argv.slice(1), cwd: process.cwd(), home: e.HOME,
  session: e.OPENBOTS_CODER_SESSION ?? null, dir: e.OPENBOTS_CODER_SESSION_DIR, socket: e.OPENBOTS_CODER_SOCKET,
  credentials: e.OPENBOTS_CODER_CREDENTIAL_SOCKET ?? null,
  claude: e.CLAUDE_CONFIG_DIR, codex: e.CODEX_HOME, pi: e.PI_CODING_AGENT_DIR,
  port: e.OPENBOTS_AGENT_PORT ?? null, mine: e.MINE, token: e.OPENBOTS_AGENT_TOKEN ?? null,
  git: Object.fromEntries(Object.keys(e).filter((k) => k.startsWith('GIT_CONFIG')).map((k) => [k, e[k]])),
  umask: process.umask().toString(8),
}));
`;

describe('WS /coder start', () => {
  it('refuses a session without a start, with a bad id, or with a cwd outside the home', async () => {
    const { url } = await startAgent();
    const early = open(url, { type: 'stdin', data: 'hi' });
    expect(await early.closed).toBe(1008);
    expect(early.frames).toEqual([{ type: 'error', message: 'The first frame must be start' }]);

    const bad = open(url, { type: 'start', session_id: '../../etc/x', command: node });
    expect(await bad.closed).toBe(1008);
    expect(bad.frames).toEqual([{ type: 'error', message: 'Not a valid session id' }]);

    const outside = open(url, { type: 'start', session_id: ID, command: node, cwd: '/etc' });
    await outside.closed;
    expect(outside.frames[0]).toMatchObject({ type: 'error', message: /leaves the home/ });

    const up = open(url, { type: 'start', session_id: ID, command: node, cwd: '../..' });
    await up.closed;
    expect(up.frames[0]).toMatchObject({ type: 'error', message: /leaves the home/ });
  });

  it('runs the command in the worktree with the session environment and placeholders filled', async () => {
    const { url, home, runtimeDir, stateDir } = await startAgent();
    await mkdir(path.join(home, 'repos/acme/app/.worktrees/fix'), { recursive: true });
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = TEST_TOKEN;
    cleanups.push(() => {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    });
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: [
        '-e',
        REPORT,
        '{{session_dir}}/mcp.json',
        'id={{session_id}}',
        '{{home}}',
        '--',
        'prompt about {{session_id}} in {{home}} and {{session_dir}}',
        '--',
        '{{home}}',
      ],
      cwd: path.join(home, 'repos/acme/app/.worktrees/fix'),
      env: { MINE: 'in {{session_dir}}', HOME: '/elsewhere', OPENBOTS_CODER_SESSION: 'forged' },
    });
    const started = await s.next('started');
    const dir = path.join(runtimeDir, 'coders', ID);
    expect(started).toEqual({ type: 'started', pid: expect.any(Number), session_dir: dir });
    const exit = await s.next('exit');
    expect(exit).toEqual({ type: 'exit', code: 0, signal: null });
    expect(await s.closed).toBe(1000);
    const seen = JSON.parse(s.output()) as Record<string, unknown>;
    expect(seen).toEqual({
      // Nothing after the first `--` is filled: that is the owner's prompt.
      argv: [
        `${dir}/mcp.json`,
        `id=${ID}`,
        home,
        '--',
        'prompt about {{session_id}} in {{home}} and {{session_dir}}',
        '--',
        '{{home}}',
      ],
      cwd: path.join(home, 'repos/acme/app/.worktrees/fix'),
      // The coder user's home, whatever the start says.
      home: path.join(stateDir, 'coders/home'),
      // A secret of the agent's, not the server's id nor the start's forgery.
      session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      dir,
      socket: path.join(dir, 'permission.sock'),
      credentials: path.join(dir, 'credential.sock'),
      claude: path.join(stateDir, 'coders/claude'),
      codex: path.join(stateDir, 'coders/codex'),
      pi: path.join(stateDir, 'coders/pi'),
      port: null,
      mine: `in ${dir}`,
      token: null,
      git: {
        GIT_CONFIG_COUNT: '5',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '/usr/local/bin/openbots-git-credential',
        GIT_CONFIG_KEY_2: 'credential.useHttpPath',
        GIT_CONFIG_VALUE_2: 'true',
        // The worktree and its repository, whoever owns them; nothing else.
        GIT_CONFIG_KEY_3: 'safe.directory',
        GIT_CONFIG_VALUE_3: path.join(home, 'repos/acme/app/.worktrees/fix'),
        GIT_CONFIG_KEY_4: 'safe.directory',
        GIT_CONFIG_VALUE_4: path.join(home, 'repos/acme/app'),
      },
      umask: '2',
    });
    // The session's directory goes with it.
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  });

  it("trusts exactly the start's safe directories when it names them", async () => {
    const { url, home } = await startAgent();
    const worktree = path.join(home, 'checkouts/fix');
    await mkdir(worktree, { recursive: true });
    const repo = path.join(home, 'repos/acme/app');
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', REPORT],
      cwd: worktree,
      safe_directories: [repo, worktree],
    });
    await s.next('exit');
    const seen = JSON.parse(s.output()) as { git: Record<string, string> };
    expect(seen.git).toMatchObject({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_3: 'safe.directory',
      GIT_CONFIG_VALUE_3: repo,
      GIT_CONFIG_KEY_4: 'safe.directory',
      GIT_CONFIG_VALUE_4: worktree,
    });

    // An empty list trusts nothing, not even the inferred directories.
    await mkdir(path.join(home, 'repos/acme/app/.worktrees/fix'), { recursive: true });
    const none = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', REPORT],
      cwd: path.join(home, 'repos/acme/app/.worktrees/fix'),
      safe_directories: [],
    });
    expect(await none.closed).toBe(1000);
    const bare = JSON.parse(none.output()) as { git: Record<string, string> };
    expect(Object.values(bare.git)).not.toContain('safe.directory');
  });

  it('refuses a safe directory that is relative, not normalised, or outside the home', async () => {
    const { url, home } = await startAgent();
    for (const dir of ['repos/acme/app', `${home}/repos/../../etc`, '/etc', home, `${home}/..`]) {
      const s = open(url, {
        type: 'start',
        session_id: ID,
        command: node,
        args: ['-e', REPORT],
        safe_directories: [path.join(home, 'repos/acme/app'), dir],
      });
      expect(await s.closed).toBe(1008);
      expect(s.frames[0]).toEqual({
        type: 'error',
        message: 'A safe directory must be an absolute path under the home',
      });
    }
  });

  it("runs the owner's command in the bot user's home, git config after the caller's, no helper for a login", async () => {
    const { url, home } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      user: 'bot',
      command: node,
      args: ['-e', REPORT],
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Bot' },
      git_credentials: false,
    });
    await s.next('exit');
    const seen = JSON.parse(s.output()) as Record<string, unknown>;
    expect(seen.home).toBe(home);
    expect(seen.cwd).toBe(home);
    // No helper, so no secret and no credential socket.
    expect(seen.session).toBeNull();
    expect(seen.credentials).toBeNull();
    expect(seen.git).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Bot',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    });
  });

  it("runs the server's git operation as the runner, in its own home, without the agents' config directories", async () => {
    const { url, home, stateDir } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      user: 'runner',
      command: node,
      args: ['-e', REPORT],
      // Whatever the start says, the runner never sees them.
      env: { CLAUDE_CONFIG_DIR: '/x', CODEX_HOME: '/x', PI_CODING_AGENT_DIR: '/x' },
    });
    await s.next('exit');
    const seen = JSON.parse(s.output()) as Record<string, unknown>;
    expect(seen.home).toBe(path.join(stateDir, 'coders/runner-home'));
    expect(seen.cwd).toBe(home);
    expect(seen.session).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(seen.credentials).toEqual(expect.stringContaining('credential.sock'));
    expect(seen).not.toHaveProperty('claude');
    expect(seen).not.toHaveProperty('codex');
    expect(seen).not.toHaveProperty('pi');
    // Its clones must stay writable for the coder sessions.
    expect(seen.umask).toBe('2');
  });

  it('streams stdout and stderr, takes stdin until it ends, and reports the exit once', async () => {
    const { url } = await startAgent();
    const script = `
      process.stderr.write('ready\\n');
      process.stdin.setEncoding('utf8');
      let all = '';
      process.stdin.on('data', (d) => { all += d; process.stdout.write('got:' + d); });
      process.stdin.on('end', () => { process.stdout.write('end:' + all.length + '\\n'); process.exit(4); });`;
    // Sent before it runs: kept until it does.
    const s = open(
      url,
      { type: 'start', session_id: ID, command: node, args: ['-e', script] },
      { type: 'stdin', data: 'one\n' },
    );
    await s.next('started');
    await vi.waitFor(() => expect(s.output()).toContain('got:one'));
    s.send({ type: 'stdin', data: 'two\n', end: true });
    expect(await s.next('exit')).toEqual({ type: 'exit', code: 4, signal: null });
    expect(s.output()).toContain('end:8');
    expect(s.frames).toContainEqual({ type: 'stderr', data: 'ready\n' });
    await s.closed;
    expect(s.frames.filter((f) => f.type === 'exit')).toHaveLength(1);
  });

  it('refuses a second socket for a running session', async () => {
    const { url } = await startAgent();
    const first = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    await first.next('started');
    const second = open(url, { type: 'start', session_id: ID, command: node });
    expect(await second.closed).toBe(1008);
    expect(second.frames).toEqual([{ type: 'error', message: 'That session is already running' }]);
  });
});

describe('WS /coder process group', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('stops the whole group when the socket closes, SIGTERM then SIGKILL, and removes the directory', async () => {
    const { url, runtimeDir } = await startAgent();
    // The shell ignores SIGTERM, so only SIGKILL ends it; its child is in the group.
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: '/bin/sh',
      args: ['-c', 'trap "" TERM; sleep 60 & echo child=$!; wait; wait'],
    });
    const { pid } = await s.next('started');
    await vi.waitFor(() => expect(s.output()).toMatch(/child=\d+/));
    const child = Number(/child=(\d+)/.exec(s.output())![1]);
    expect(alive(pid) && alive(child)).toBe(true);
    s.ws.close();
    await vi.waitFor(() => expect(alive(pid) || alive(child)).toBe(false), { timeout: 8000 });
    await vi.waitFor(() => expect(existsSync(path.join(runtimeDir, 'coders', ID))).toBe(false), {
      timeout: 8000,
    });
  });

  /** A leader that starts a sleeping grandchild in its group and exits at once. */
  const BACKGROUND = 'sleep 60 & echo child=$!; exit 0';

  it('stops what the process left in the background once it exits', async () => {
    const { url } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: '/bin/sh',
      args: ['-c', BACKGROUND],
    });
    await s.next('started');
    await vi.waitFor(() => expect(s.output()).toMatch(/child=\d+/));
    const child = Number(/child=(\d+)/.exec(s.output())![1]);
    expect(await s.next('exit')).toEqual({ type: 'exit', code: 0, signal: null });
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 8000 });
  });

  it.skipIf(!hasPty)('stops what the process left in the background under a pty too', async () => {
    const { url } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: '/bin/sh',
      // Ignores SIGHUP, so only the agent's signals end it when the terminal goes.
      args: ['-c', `trap "" HUP; ${BACKGROUND}`],
      pty: true,
      git_credentials: false,
    });
    await s.next('started');
    await vi.waitFor(() => expect(s.output()).toMatch(/child=\d+/));
    const child = Number(/child=(\d+)/.exec(s.output())![1]);
    await s.next('exit');
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 8000 });
  });

  it('passes a signal frame to the group', async () => {
    const { url } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    await s.next('started');
    s.send({ type: 'signal', signal: 'SIGINT' });
    expect(await s.next('exit')).toEqual({ type: 'exit', code: null, signal: 'SIGINT' });
  });
});

describe('WS /coder permission relay (I11)', () => {
  /** Asks over the session's socket the way coder-permission-mcp.ts does, and prints the reply. */
  const ASK = `
    const net = require('node:net');
    const conn = net.connect(process.env.OPENBOTS_CODER_SOCKET, () =>
      conn.write(JSON.stringify({ request_id: 'tu_1', tool_name: 'Bash', input: { command: 'git push' } }) + '\\n'));
    let reply = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => (reply += d));
    conn.on('end', () => { process.stdout.write('reply:' + reply); });`;

  it('relays a prompt to the server and its answer back over the unix socket', async () => {
    const { url } = await startAgent();
    const s = open(url, { type: 'start', session_id: ID, command: node, args: ['-e', ASK] });
    const prompt = await s.next('permission_request');
    expect(prompt).toEqual({
      type: 'permission_request',
      request_id: expect.any(String),
      tool_name: 'Bash',
      input: { command: 'git push' },
    });
    s.send({ type: 'answer', request_id: prompt.request_id, decision: 'deny', message: 'Not yet' });
    await s.next('exit');
    expect(s.output()).toBe('reply:{"decision":"deny","message":"Not yet"}\n');
  });

  it('denies a waiting prompt when the session ends, and refuses a line that is not a request', async () => {
    const { url } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const { session_dir } = await s.next('started');
    const ask = (line: string) =>
      new Promise<string>((resolve) => {
        const conn = connect(path.join(session_dir, 'permission.sock'), () => conn.write(line));
        let reply = '';
        conn.setEncoding('utf8');
        conn.on('data', (d: string) => (reply += d));
        conn.on('close', () => resolve(reply));
      });
    expect(await ask('not json\n')).toBe(
      '{"decision":"deny","message":"Not a permission request"}\n',
    );
    const waiting = ask(`${JSON.stringify({ tool_name: 'Edit', input: {} })}\n`);
    await s.next('permission_request');
    s.ws.close();
    expect(await waiting).toBe('{"decision":"deny","message":"The session ended"}\n');
  });
});

describe('WS /coder credential relay (I5)', () => {
  const fields = { protocol: 'https', host: 'github.com', path: 'acme/app.git' };

  /** A running session, and the environment its process got. */
  async function running(log?: (msg: string, extra?: Record<string, unknown>) => void) {
    const agent = await startAgent(log);
    const s = open(agent.url, {
      type: 'start',
      session_id: ID,
      command: node,
      args: ['-e', `${REPORT}; setInterval(() => {}, 1000)`],
    });
    const { session_dir } = await s.next('started');
    await vi.waitFor(() => expect(s.output()).toContain('\n'));
    const seen = JSON.parse(s.output()) as { session: string; credentials: string };
    const env = {
      OPENBOTS_CODER_SESSION: seen.session,
      OPENBOTS_CODER_CREDENTIAL_SOCKET: seen.credentials,
    };
    return { ...agent, s, env, session_dir };
  }

  /** One raw line to the session's credential socket, and its reply. */
  const raw = (file: string, line: string) =>
    new Promise<string>((resolve) => {
      const conn = connect(file, () => conn.write(line));
      let reply = '';
      conn.setEncoding('utf8');
      conn.on('data', (d: string) => (reply += d));
      conn.on('close', () => resolve(reply));
    });

  it("asks the server for git's helper and gives it the credential", async () => {
    const { s, env } = await running();
    const out = credentialGet({ ...fields, username: 'push' }, { env });
    const request = await s.next('credential_request');
    expect(request).toEqual({
      type: 'credential_request',
      request_id: expect.any(String),
      protocol: 'https',
      host: 'github.com',
      path: 'acme/app.git',
      username: 'push',
    });
    s.send({
      type: 'credential',
      request_id: request.request_id,
      username: 'x-access-token',
      password: 'ghs_secret',
    });
    expect(await out).toBe('username=x-access-token\npassword=ghs_secret\n');
  });

  it("refuses the server's session id, or any other secret, without asking the server", async () => {
    const { s, env, session_dir } = await running();
    const file = path.join(session_dir, 'credential.sock');
    expect(env.OPENBOTS_CODER_CREDENTIAL_SOCKET).toBe(file);
    // What the Bot's shell can learn: the session id, and the socket's path.
    const forged = { ...env, OPENBOTS_CODER_SESSION: ID };
    expect(await credentialGet(fields, { env: forged })).toBe('');
    expect(await raw(file, `${JSON.stringify({ ...fields, secret: ID })}\n`)).toBe(
      '{"denied":"Not this session"}\n',
    );
    expect(
      await raw(
        file,
        `${JSON.stringify({ ...fields, session_id: ID, secret: env.OPENBOTS_CODER_SESSION.slice(1) + 'x' })}\n`,
      ),
    ).toBe('{"denied":"Not a credential request"}\n');
    expect(await raw(file, 'not json\n')).toBe('{"denied":"Not a credential request"}\n');
    expect(s.frames.some((f) => f.type === 'credential_request')).toBe(false);
  });

  it('passes on a refusal, and refuses when the server is slow or the session ends', async () => {
    const { s, env, session_dir } = await running();
    const file = path.join(session_dir, 'credential.sock');
    const line = `${JSON.stringify({ ...fields, secret: env.OPENBOTS_CODER_SESSION })}\n`;

    const denied = raw(file, line);
    const request = await s.next('credential_request');
    s.send({ type: 'credential', request_id: request.request_id, denied: 'Push is not approved' });
    expect(await denied).toBe('{"denied":"Push is not approved"}\n');

    // credentialTimeoutMs is 300 here.
    expect(await raw(file, line)).toBe('{"denied":"The server did not answer in time"}\n');

    const count = s.frames.length;
    const waiting = raw(file, line);
    await s.next('credential_request', count);
    s.ws.close();
    expect(await waiting).toBe('{"denied":"The session ended"}\n');
  });

  it('logs a credential request the server never answers', async () => {
    const logged: { msg: string; extra?: Record<string, unknown> }[] = [];
    const { s, env, session_dir } = await running((msg, extra) =>
      logged.push({ msg, ...(extra ? { extra } : {}) }),
    );
    const file = path.join(session_dir, 'credential.sock');
    const line = `${JSON.stringify({ ...fields, secret: env.OPENBOTS_CODER_SESSION })}\n`;
    expect(await raw(file, line)).toBe('{"denied":"The server did not answer in time"}\n');
    const request = s.frames.find((f) => f.type === 'credential_request')!;
    const timedOut = logged.filter((l) => l.msg === 'coder credential request timed out');
    expect(timedOut).toEqual([
      {
        msg: 'coder credential request timed out',
        extra: {
          session_id: ID,
          request_id: (request as { request_id: string }).request_id,
          host: 'github.com',
          timeout_ms: 300,
        },
      },
    ]);
    // Nothing about the secret reaches the log.
    expect(JSON.stringify(logged)).not.toContain(env.OPENBOTS_CODER_SESSION);
  });

  it('has no POST /git/credential any more: without the token it is a 401', async () => {
    const { app } = await createTestAgent();
    const res = await app.request(
      '/git/credential',
      json({ session_id: ID, protocol: 'https', host: 'github.com' }),
    );
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!(await loadPty()))('WS /coder with a pty (I4)', () => {
  it('runs under a terminal of the given size, takes input and resizes', async () => {
    const { url } = await startAgent();
    const s = open(url, {
      type: 'start',
      session_id: ID,
      command: '/bin/sh',
      args: ['-c', 'stty size; read line; stty size; echo "got $line"; exit 3'],
      pty: true,
      cols: 100,
      rows: 30,
      git_credentials: false,
    });
    await s.next('started');
    await vi.waitFor(() => expect(s.output()).toContain('30 100'));
    s.send({ type: 'resize', cols: 120, rows: 40 });
    s.send({ type: 'stdin', data: 'code-123\r' });
    expect(await s.next('exit')).toEqual({ type: 'exit', code: 3, signal: null });
    expect(s.output()).toContain('40 120');
    expect(s.output()).toContain('got code-123');
  });
});

describe('sessionUser', () => {
  const paths = coderPaths('/run/openbots', '/var/lib/openbots');
  const config = {
    CLAUDE_CONFIG_DIR: '/var/lib/openbots/coders/claude',
    CODEX_HOME: '/var/lib/openbots/coders/codex',
    PI_CODING_AGENT_DIR: '/var/lib/openbots/coders/pi',
  };

  it('runs a coding agent as the coder user, in its home, with the config directories', () => {
    expect(sessionUser('coder', paths, '/home/bot')).toEqual({
      identity: { uid: 1800, gid: 1800 },
      home: '/var/lib/openbots/coders/home',
      configEnv: config,
    });
  });

  it("runs the owner's command as the bot user with the coders group, in the bot's home", () => {
    expect(sessionUser('bot', paths, '/home/bot')).toEqual({
      identity: { uid: 1000, gid: 1800 },
      home: '/home/bot',
      configEnv: config,
    });
  });

  it("runs the server's git operations as the runner, never the coder, with the config directories cleared", () => {
    const runner = sessionUser('runner', paths, '/home/bot');
    expect(runner.identity).toEqual({ uid: 1801, gid: 1800 });
    expect(runner.home).toBe('/var/lib/openbots/coders/runner-home');
    expect(runner.configEnv).toEqual({
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: undefined,
      PI_CODING_AGENT_DIR: undefined,
    });
  });
});
