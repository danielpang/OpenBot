import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RawData, WebSocket } from 'ws';
import { childEnv } from './config.js';
import { resolveInHome } from './paths.js';
import {
  McpStdioClientMessageSchema,
  type McpStdioStart,
  type McpStdioServerMessage,
} from './protocol.js';
import { BOT, UNPRIVILEGED, type Users } from './users.js';

// `WS /mcp/stdio` (protocol.ts): a connector's stdio MCP server, run in the
// owner's computer instead of on the shared server (the managed service). It
// runs as the bot user, like the terminal, in its own process group, with
// the bot user's environment plus the connector's own variables. Those hold
// its secrets, so they go to `spawn` and nowhere else: nothing here logs the
// environment or the arguments, and nothing is written to disk. The process
// lives as long as the socket: closing it, from either side, closes stdin,
// then sends SIGTERM and SIGKILL to the group.

export interface McpStdioDeps {
  home: string;
  users?: Users;
  /** Structured log lines; given the command's name and pid only. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Rewrites a start before it runs (the fake agent in `@openbots/computer/testing`). */
  prepare?: (start: McpStdioStart) => McpStdioStart;
  /** How long the socket may stay open without a `start`. */
  startTimeoutMs?: number;
  /** After stdin closes, how long before SIGTERM, and from SIGTERM to SIGKILL. */
  graceMs?: number;
}

/** Every process started here, so the agent can stop them all when it shuts down. */
const running = new Set<() => void>();

/** Stops every MCP stdio process (agent shutdown). */
export function stopAllMcpStdio(): void {
  for (const stop of [...running]) stop();
}

/** One process per socket: the first frame starts it, the socket's close stops it. */
export function mcpStdioSession(ws: WebSocket, deps: McpStdioDeps): void {
  const send = (msg: McpStdioServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message: string, code = 1011) => {
    send({ type: 'error', message });
    ws.close(code, message.slice(0, 120));
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  /** Input that came while the process was being started. */
  let pending: string[] | undefined;
  let exited = false;
  let stopping = false;
  const grace = deps.graceMs ?? 2000;

  const signalGroup = (signal: NodeJS.Signals) => {
    if (exited || child?.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startTimer);
    if (!child || exited) return;
    child.stdin.end();
    const term = setTimeout(() => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), grace).unref();
    }, grace);
    term.unref();
  };

  const startTimer = setTimeout(
    () => fail('No start message', 1008),
    deps.startTimeoutMs ?? 10_000,
  );
  startTimer.unref();

  const start = async (requested: McpStdioStart) => {
    clearTimeout(startTimer);
    const spec = deps.prepare ? deps.prepare(requested) : requested;
    for (const dir of spec.dirs ?? []) {
      // `resolveInHome` takes the URL-encoded form `/fs/*` paths come in.
      const { abs } = await resolveInHome(deps.home, encodeURIComponent(dir));
      await mkdir(abs, { recursive: true, mode: 0o700 });
    }
    if (stopping) return;
    const program = (deps.users ?? UNPRIVILEGED).command(BOT, spec.command, spec.args);
    const proc = spawn(program.command, program.args, {
      cwd: path.resolve(deps.home, spec.cwd ?? '.'),
      // The connector's variables over the bot user's own; the agent's secrets never.
      env: childEnv({ HOME: deps.home }, spec.env),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;
    running.add(stop);
    for (const data of pending ?? []) proc.stdin.write(data);
    pending = undefined;
    const name = path.basename(spec.command);
    proc.once('spawn', () => {
      deps.log?.('mcp stdio server started', { command: name, pid: proc.pid });
      if (proc.pid !== undefined) send({ type: 'started', pid: proc.pid });
    });
    proc.once('error', (err) => {
      exited = true;
      running.delete(stop);
      fail(`Could not start ${name}: ${err.message}`);
    });
    proc.stdout.setEncoding('utf8').on('data', (data: string) => send({ type: 'stdout', data }));
    proc.stderr.setEncoding('utf8').on('data', (data: string) => send({ type: 'stderr', data }));
    proc.stdin.on('error', () => {
      // It exited without reading what was left; `exit` reports it.
    });
    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      exited = true;
      running.delete(stop);
      deps.log?.('mcp stdio server exited', { command: name, pid: proc.pid, exitCode, signal });
      send({ type: 'exit', exitCode, signal });
      if (ws.readyState === ws.OPEN) ws.close(1000);
    };
    // `close` comes once the output is drained. A child of the server that
    // still holds the pipes would hold it back, so after `exit` give the
    // pipes a moment, then report the exit anyway.
    proc.once('close', finish);
    proc.once('exit', (exitCode, signal) => {
      exited = true;
      setTimeout(() => finish(exitCode, signal), 250).unref();
    });
  };

  ws.on('message', (raw: RawData) => {
    let parsed;
    try {
      parsed = McpStdioClientMessageSchema.safeParse(JSON.parse(raw.toString()));
    } catch {
      return fail('Frames must be JSON', 1007);
    }
    if (!parsed.success) return fail('Not a valid MCP stdio message', 1007);
    const msg = parsed.data;
    if (msg.type === 'start') {
      if (pending || child) return fail('Already started', 1008);
      pending = [];
      start(msg).catch((err: unknown) =>
        fail(err instanceof Error ? err.message : 'Could not start the server'),
      );
      return;
    }
    if (pending) pending.push(msg.data);
    else if (child && !exited) child.stdin.write(msg.data);
  });
  ws.on('close', stop);
  ws.on('error', stop);
}
