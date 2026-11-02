import { existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { mcpStdioSession, type McpStdioDeps } from './mcp-stdio.js';
import type { McpStdioServerMessage } from './protocol.js';
import type { ScreenManager } from './screens.js';
import { tempHome, TEST_TOKEN } from './test-utils.js';
import { attachWebSockets } from './ws.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  vi.restoreAllMocks();
});

/** A server that answers each line on stdin, and prints its secret when asked. */
const ECHO = `
process.stdin.setEncoding('utf8');
let buffered = '';
process.stdin.on('data', (d) => {
  buffered += d;
  let at;
  while ((at = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    if (line === 'secret') process.stdout.write('secret:' + process.env.MY_SECRET + '\\n');
    else if (line === 'cwd') process.stdout.write('cwd:' + process.cwd() + '\\n');
    else if (line === 'token') process.stdout.write('token:' + (process.env.OPENBOTS_AGENT_TOKEN ?? 'none') + '\\n');
    else if (line === 'quit') process.exit(3);
    else process.stdout.write('echo:' + line + '\\n');
  }
});
process.stderr.write('ready\\n');
`;

/** A server that ignores both the end of stdin and SIGTERM. */
const STUBBORN = `
process.on('SIGTERM', () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

async function startSession(deps: Partial<McpStdioDeps> = {}) {
  const home = deps.home ?? (await tempHome());
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => mcpStdioSession(ws, { home, graceMs: 50, ...deps }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () => new Promise<void>((r) => server.close(() => r())),
    () => {
      for (const c of wss.clients) c.terminate();
    },
  );
  return { home, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const messages: McpStdioServerMessage[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as McpStdioServerMessage));
  cleanups.push(() => {
    ws.on('error', () => {});
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check(), what).toBe(true);
  };
  const stdout = () =>
    messages
      .filter((m) => m.type === 'stdout')
      .map((m) => (m as { data: string }).data)
      .join('');
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, until, stdout, opened };
}

const start = (ws: WebSocket, more: Record<string, unknown> = {}) =>
  ws.send(
    JSON.stringify({
      type: 'start',
      command: process.execPath,
      args: ['-e', ECHO],
      env: {},
      ...more,
    }),
  );
const stdin = (ws: WebSocket, data: string) => ws.send(JSON.stringify({ type: 'stdin', data }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('WS /mcp/stdio', () => {
  it('starts the process, relays stdin and stdout both ways, and reports its exit', async () => {
    const { url } = await startSession();
    const c = connect(url);
    await c.opened;
    start(c.ws);
    await c.until(() => c.messages.some((m) => m.type === 'started'), 'started');
    stdin(c.ws, 'hello\nwor');
    stdin(c.ws, 'ld\n');
    await c.until(() => c.stdout().includes('echo:world\n'), 'echoed');
    expect(c.stdout()).toBe('echo:hello\necho:world\n');
    await c.until(
      () => c.messages.some((m) => m.type === 'stderr' && m.data.includes('ready')),
      'stderr',
    );
    stdin(c.ws, 'quit\n');
    await c.until(() => c.messages.some((m) => m.type === 'exit'), 'exit');
    expect(c.messages.at(-1)).toEqual({ type: 'exit', exitCode: 3, signal: null });
    await c.until(() => c.ws.readyState === WebSocket.CLOSED, 'closed');
  });

  it("passes the connector's variables to the process only, and never logs them", async () => {
    const lines: string[] = [];
    const log = vi.fn((msg: string, extra?: Record<string, unknown>) =>
      lines.push(JSON.stringify({ msg, ...extra })),
    );
    const consoleLines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '));
      });
    }
    process.env.OPENBOTS_AGENT_TOKEN = 'agent-token-never-shared';
    cleanups.push(() => {
      delete process.env.OPENBOTS_AGENT_TOKEN;
    });
    const { url } = await startSession({ log });
    const c = connect(url);
    await c.opened;
    start(c.ws, { env: { MY_SECRET: 'sekrit-in-env-only' } });
    await c.until(() => c.messages.some((m) => m.type === 'started'), 'started');
    stdin(c.ws, 'secret\ntoken\nquit\n');
    await c.until(() => c.messages.some((m) => m.type === 'exit'), 'exit');
    expect(c.stdout()).toContain('secret:sekrit-in-env-only\n');
    // The agent's own token never reaches it.
    expect(c.stdout()).toContain('token:none\n');
    expect(log).toHaveBeenCalledWith(
      'mcp stdio server started',
      expect.objectContaining({ command: path.basename(process.execPath) }),
    );
    expect(lines.join('\n')).not.toContain('sekrit');
    expect(lines.join('\n')).not.toContain('-e');
    expect(consoleLines.join('\n')).not.toContain('sekrit');
  });

  it('creates the folders it is given under the home and runs in its cwd', async () => {
    const { url, home } = await startSession();
    const c = connect(url);
    await c.opened;
    start(c.ws, { dirs: ['notes/2026'], cwd: 'notes' });
    await c.until(() => c.messages.some((m) => m.type === 'started'), 'started');
    expect(statSync(path.join(home, 'notes', '2026')).isDirectory()).toBe(true);
    stdin(c.ws, 'cwd\n');
    await c.until(() => c.stdout().includes('cwd:'), 'cwd');
    expect(c.stdout()).toBe(`cwd:${path.join(home, 'notes')}\n`);
  });

  it('refuses folders outside the home', async () => {
    const { url, home } = await startSession();
    const c = connect(url);
    await c.opened;
    start(c.ws, { dirs: ['../escape'] });
    await c.until(() => c.messages.some((m) => m.type === 'error'), 'error');
    expect(c.messages).toEqual([{ type: 'error', message: 'The path leaves the home directory' }]);
    expect(existsSync(path.join(path.dirname(home), 'escape'))).toBe(false);
  });

  it('reports a command that does not exist', async () => {
    const { url } = await startSession();
    const c = connect(url);
    await c.opened;
    start(c.ws, { command: '/nonexistent/mcp-server', args: [] });
    await c.until(() => c.messages.some((m) => m.type === 'error'), 'error');
    expect(c.messages[0]).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/^Could not start mcp-server: .*ENOENT/),
    });
    await c.until(() => c.ws.readyState === WebSocket.CLOSED, 'closed');
  });

  it('refuses frames that are not the protocol, and a second start', async () => {
    const { url } = await startSession();
    const bad = connect(url);
    await bad.opened;
    bad.ws.send(
      JSON.stringify({ type: 'start', command: 'x', args: [], env: { 'NOT-A-NAME': 'v' } }),
    );
    await bad.until(() => bad.messages.some((m) => m.type === 'error'), 'error');
    expect(bad.messages[0]).toEqual({ type: 'error', message: 'Not a valid MCP stdio message' });

    const twice = connect(url);
    await twice.opened;
    start(twice.ws);
    start(twice.ws);
    await twice.until(() => twice.messages.some((m) => m.type === 'error'), 'error');
    expect(twice.messages.find((m) => m.type === 'error')).toEqual({
      type: 'error',
      message: 'Already started',
    });
  });

  it('kills the process when the socket closes, with SIGKILL when SIGTERM is ignored', async () => {
    const { url } = await startSession();
    for (const script of [ECHO, STUBBORN]) {
      const c = connect(url);
      await c.opened;
      start(c.ws, { args: ['-e', script] });
      await c.until(() => c.messages.some((m) => m.type === 'started'), 'started');
      // Let it install its handlers.
      await new Promise((r) => setTimeout(r, 100));
      const { pid } = c.messages.find((m) => m.type === 'started') as { pid: number };
      expect(alive(pid)).toBe(true);
      c.ws.close();
      await c.until(() => !alive(pid), `pid ${pid} gone`);
    }
  });
});

describe('the /mcp/stdio endpoint', () => {
  it('needs the agent token, and runs the server as the agent there', async () => {
    const home = await tempHome();
    const server: Server = createServer((_req, res) => res.writeHead(426).end());
    const sockets = attachWebSockets(server, {
      token: TEST_TOKEN,
      home,
      screens: {} as unknown as ScreenManager,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())), sockets.close);
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/stdio`;

    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(refused).toBe(401);

    const c = connect(url, { authorization: `Bearer ${TEST_TOKEN}` });
    await c.opened;
    start(c.ws);
    await c.until(() => c.messages.some((m) => m.type === 'started'), 'started');
    stdin(c.ws, 'ping\n');
    await c.until(() => c.stdout() === 'echo:ping\n', 'echoed');
    const { pid } = c.messages.find((m) => m.type === 'started') as { pid: number };
    // Shutting the agent's sockets down stops the process too.
    await sockets.close();
    await c.until(() => !alive(pid), 'stopped with the agent');
  });
});
