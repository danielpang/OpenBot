import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { upgradeAuthorized } from './auth.js';
import { coderSession, coderSessions, type CoderSessions } from './coder.js';
import { coderConfigEnv, coderPaths } from './coder-paths.js';
import { childEnv } from './config.js';
import { AgentError } from './errors.js';
import { mcpStdioSession, stopAllMcpStdio } from './mcp-stdio.js';
import { resolveCwd } from './paths.js';
import {
  PtyClientMessageSchema,
  PtyOpenSchema,
  ScreenNumberSchema,
  type PtyServerMessage,
} from './protocol.js';
import { loadPty, type NodePty, type Pty } from './pty.js';
import { acceptClient, authenticateToServer, ByteReader } from './rfb.js';
import type { ScreenManager } from './screens.js';
import { BOT, BOT_CODERS, CODER, UNPRIVILEGED, type Users } from './users.js';

export { loadPty, type NodePty } from './pty.js';

// The WebSocket endpoints (plan 9.3). `/pty` is a terminal session on
// node-pty; `/vnc/:n` is websockify: binary frames carrying RFB, bridged to
// the screen's x11vnc on its unix socket (`ScreenManager.vnc`), which is what
// noVNC speaks. The bridge logs in to x11vnc with the screen's password
// (rfb.ts, S-7). `/mcp/stdio` runs a connector's stdio MCP server
// (mcp-stdio.ts), and `/coder` a coding session's process (coder.ts, I3).

export interface WsDeps {
  token: string;
  home: string;
  screens: ScreenManager;
  shell?: string;
  users?: Users;
  /** Scratch space and the state volume, for the coding sessions' directories. */
  runtimeDir?: string;
  stateDir?: string;
  coders?: CoderSessions;
  /** How long a coding session's credential request waits on the server (tests shorten it). */
  credentialTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

function reject(socket: Duplex, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachWebSockets(server: Server, deps: WsDeps): { close: () => Promise<void> } {
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC asks for `binary`; anything else gets no subprotocol.
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://agent');
    if (!upgradeAuthorized(deps.token, req.headers, url))
      return reject(socket, 401, 'Unauthorized');
    if (url.pathname === '/pty') {
      void Promise.all([loadPty(), ptyCwd(deps.home, url)]).then(
        ([pty, cwd]) => {
          if (!pty) return reject(socket, 503, 'Service Unavailable');
          wss.handleUpgrade(req, socket, head, (ws) => ptySession(ws, url, deps, pty, cwd));
        },
        (err: unknown) =>
          err instanceof AgentError && err.status === 403
            ? reject(socket, 403, 'Forbidden')
            : reject(socket, 400, 'Bad Request'),
      );
      return;
    }
    if (url.pathname === '/coder') {
      return wss.handleUpgrade(req, socket, head, (ws) =>
        coderSession(ws, {
          home: deps.home,
          ...(deps.runtimeDir ? { runtimeDir: deps.runtimeDir } : {}),
          ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
          ...(deps.users ? { users: deps.users } : {}),
          ...(deps.coders ? { sessions: deps.coders } : {}),
          ...(deps.credentialTimeoutMs !== undefined
            ? { credentialTimeoutMs: deps.credentialTimeoutMs }
            : {}),
          ...(deps.log ? { log: deps.log } : {}),
        }),
      );
    }
    if (url.pathname === '/mcp/stdio') {
      return wss.handleUpgrade(req, socket, head, (ws) =>
        mcpStdioSession(ws, {
          home: deps.home,
          ...(deps.users ? { users: deps.users } : {}),
          ...(deps.log ? { log: deps.log } : {}),
        }),
      );
    }
    const vnc = /^\/vnc\/(\d+)$/.exec(url.pathname);
    if (vnc) {
      const n = ScreenNumberSchema.safeParse(vnc[1]);
      const info = n.success ? deps.screens.get(n.data) : undefined;
      const password = info && deps.screens.vncPassword(info.n);
      if (!info || !password) return reject(socket, 404, 'Not Found');
      return wss.handleUpgrade(req, socket, head, (ws) =>
        vncBridge(ws, deps.screens.vnc(info.n), password),
      );
    }
    reject(socket, 404, 'Not Found');
  };
  server.on('upgrade', onUpgrade);

  return {
    close: () =>
      new Promise((resolve) => {
        server.off('upgrade', onUpgrade);
        stopAllMcpStdio();
        (deps.coders ?? coderSessions).stopAll();
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

const dim = (value: string | null, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
};

/** `cols` and `rows` keep their old leniency (`dim`): out of range falls back to the default. */
const PtyParamsSchema = PtyOpenSchema.pick({ cwd: true, user: true, preset: true });

/**
 * The working directory a `/pty` URL asks for (I15), resolved under the home;
 * undefined when it names none. Refuses one outside the home (403) and
 * parameters `PtyOpenSchema` does not take (400).
 */
export async function ptyCwd(home: string, url: URL): Promise<string | undefined> {
  const open = PtyParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!open.success) throw new AgentError(400, 'BAD_PTY', 'Not valid terminal parameters');
  return open.data.cwd === undefined ? undefined : resolveCwd(home, open.data.cwd);
}

/** Control characters but tab: a preset is typed, never run, so no newline gets through. */
// eslint-disable-next-line no-control-regex
const PRESET_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

/**
 * One login shell per connection; it ends when either side closes. The URL
 * may ask (I15) for a working directory (`cwd`, resolved by `ptyCwd`
 * before the upgrade and passed here), the coder user's shell (`user=coder`,
 * with every agent's config directory, for a coding session's terminal)
 * and a `preset`: text typed at the prompt without a newline, the session's
 * resume command, for the owner to run with Enter. A bot shell in a
 * worktree has the coders group, as the session's own commands do.
 */
export function ptySession(
  ws: WebSocket,
  url: URL,
  deps: Pick<WsDeps, 'home' | 'shell' | 'users' | 'stateDir' | 'runtimeDir'>,
  nodePty: NodePty,
  cwd?: string,
): void {
  const send = (msg: PtyServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const open = PtyParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  const user = open.success ? open.data.user : 'bot';
  const preset = open.success ? open.data.preset?.replace(PRESET_CONTROL, '') : undefined;
  let pty: Pty;
  // The owner's terminal is the bot user's, on no screen, unless it asks for the coder's.
  const identity = user === 'coder' ? CODER : cwd !== undefined ? BOT_CODERS : BOT;
  const coders = coderPaths(
    deps.runtimeDir ?? '/tmp/openbots',
    deps.stateDir ?? '/var/lib/openbots',
  );
  const env =
    user === 'coder'
      ? { HOME: coders.homeDir, TERM: 'xterm-256color', ...coderConfigEnv(coders) }
      : { HOME: deps.home, TERM: 'xterm-256color' };
  const shell = deps.shell ?? '/bin/bash';
  const program = (deps.users ?? UNPRIVILEGED).command(
    identity,
    ...((identity === BOT
      ? [shell, ['-l']]
      : // As in a coding session: what one user writes, the other may change.
        ['/bin/sh', ['-c', 'umask 002 && exec "$0" "$@"', shell, '-l']]) as [string, string[]]),
  );
  try {
    pty = nodePty.spawn(program.command, program.args, {
      name: 'xterm-256color',
      cols: dim(url.searchParams.get('cols'), 80),
      rows: dim(url.searchParams.get('rows'), 24),
      cwd: cwd ?? deps.home,
      env: childEnv(env) as Record<string, string>,
    });
  } catch (err) {
    ws.close(1011, err instanceof Error ? err.message.slice(0, 120) : 'pty failed');
    return;
  }
  // Typed once the shell has drawn its first output, its prompt, so the
  // line editor has it; a shell that prints nothing gets it after a second.
  let typed = !preset;
  const type = () => {
    if (typed) return;
    typed = true;
    pty.write(preset!);
  };
  const presetTimer = preset ? setTimeout(type, 1000) : undefined;
  presetTimer?.unref();
  pty.onData((data) => {
    send({ type: 'output', data });
    if (!typed) setTimeout(type, 50).unref();
  });
  pty.onExit(({ exitCode, signal }) => {
    clearTimeout(presetTimer);
    typed = true;
    send({ type: 'exit', exitCode, ...(signal ? { signal } : {}) });
    ws.close(1000);
  });
  ws.on('message', (raw: RawData) => {
    let parsed;
    try {
      parsed = PtyClientMessageSchema.safeParse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    if (!parsed.success) return;
    if (parsed.data.type === 'input') pty.write(parsed.data.data);
    else pty.resize(parsed.data.cols, parsed.data.rows);
  });
  ws.on('close', () => {
    clearTimeout(presetTimer);
    typed = true;
    try {
      pty.kill();
    } catch {
      // Already exited.
    }
  });
}

/**
 * Pipes binary WebSocket frames to and from the VNC server over `vnc`, once
 * the RFB handshake has logged in to x11vnc with `password` and let the
 * client in.
 */
export function vncBridge(ws: WebSocket, vnc: Duplex, password: string): void {
  const server = new ByteReader();
  const client = new ByteReader();
  let piping = false;
  const toClient = (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  };
  const toServer = (chunk: Buffer) => vnc.write(chunk);
  vnc.on('data', (chunk: Buffer) => (piping ? toClient(chunk) : server.push(chunk)));
  vnc.on('error', () => ws.close(1011, 'VNC server unavailable'));
  vnc.on('close', () => {
    server.fail(new Error('VNC server closed'));
    if (ws.readyState === ws.OPEN) ws.close(1000);
  });
  ws.on('message', (data: RawData) => {
    const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (piping) toServer(chunk);
    else client.push(chunk);
  });
  ws.on('close', () => {
    client.fail(new Error('client closed'));
    vnc.destroy();
  });
  void (async () => {
    await authenticateToServer(server, toServer, password);
    await acceptClient(client, toClient);
    piping = true;
    const fromServer = server.rest();
    if (fromServer.length > 0) toClient(fromServer);
    const fromClient = client.rest();
    if (fromClient.length > 0) toServer(fromClient);
  })().catch(() => {
    if (ws.readyState === ws.OPEN) ws.close(1011, 'VNC login failed');
    vnc.destroy();
  });
}
