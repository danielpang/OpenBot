import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { upgradeAuthorized } from './auth.js';
import { childEnv } from './config.js';
import { mcpStdioSession, stopAllMcpStdio } from './mcp-stdio.js';
import { PtyClientMessageSchema, ScreenNumberSchema, type PtyServerMessage } from './protocol.js';
import { acceptClient, authenticateToServer, ByteReader } from './rfb.js';
import type { ScreenManager } from './screens.js';
import { BOT, UNPRIVILEGED, type Users } from './users.js';

// The WebSocket endpoints (plan 9.3). `/pty` is a terminal session on
// node-pty; `/vnc/:n` is websockify: binary frames carrying RFB, bridged to
// the screen's x11vnc on its unix socket (`ScreenManager.vnc`), which is what
// noVNC speaks. The bridge logs in to x11vnc with the screen's password
// (rfb.ts, S-7). `/mcp/stdio` runs a connector's stdio MCP server
// (mcp-stdio.ts).

export interface WsDeps {
  token: string;
  home: string;
  screens: ScreenManager;
  shell?: string;
  users?: Users;
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
      void loadPty().then((pty) => {
        if (!pty) return reject(socket, 503, 'Service Unavailable');
        wss.handleUpgrade(req, socket, head, (ws) => ptySession(ws, url, deps, pty));
      });
      return;
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
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** The part of node-pty's API used here, so typecheck does not need it installed. */
export interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): Pty;
}

interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// Typed as string, not a literal, so tsc does not try to resolve it.
const NODE_PTY: string = 'node-pty';
let ptyModule: Promise<NodePty | undefined> | undefined;

/**
 * node-pty, or undefined where it is not installed or its native binding did
 * not build. It is an optional dependency so a checkout without a C++
 * toolchain still installs; the image build checks that it loads.
 */
export function loadPty(): Promise<NodePty | undefined> {
  ptyModule ??= import(NODE_PTY).then(
    (m: NodePty) => m,
    () => undefined,
  );
  return ptyModule;
}

const dim = (value: string | null, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
};

/** One login shell per connection; it ends when either side closes. */
export function ptySession(
  ws: WebSocket,
  url: URL,
  deps: Pick<WsDeps, 'home' | 'shell' | 'users'>,
  nodePty: NodePty,
): void {
  const send = (msg: PtyServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  let pty: Pty;
  // The owner's terminal is the bot user's, on no screen.
  const program = (deps.users ?? UNPRIVILEGED).command(BOT, deps.shell ?? '/bin/bash', ['-l']);
  try {
    pty = nodePty.spawn(program.command, program.args, {
      name: 'xterm-256color',
      cols: dim(url.searchParams.get('cols'), 80),
      rows: dim(url.searchParams.get('rows'), 24),
      cwd: deps.home,
      env: childEnv({ HOME: deps.home, TERM: 'xterm-256color' }) as Record<string, string>,
    });
  } catch (err) {
    ws.close(1011, err instanceof Error ? err.message.slice(0, 120) : 'pty failed');
    return;
  }
  pty.onData((data) => send({ type: 'output', data }));
  pty.onExit(({ exitCode, signal }) => {
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
