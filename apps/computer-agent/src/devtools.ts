import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex, Readable, Writable } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { bearer, tokenMatches } from './auth.js';
import { AgentError } from './errors.js';

// Chromium's DevTools without a port (S-7). With `--remote-debugging-pipe`
// Chromium reads CDP commands from fd 3 and writes replies to fd 4, each a
// NUL-terminated JSON message, and only the agent holds those fds. Playwright
// connects over a WebSocket, so the agent bridges the pipe to one on a port
// on 127.0.0.1 that the kernel picks, and that port takes a single client
// carrying the screen's random secret. The Bots' commands run as the agent's
// uid, so anything the agent could put on disk they could replace; a port
// the agent holds they cannot, and the secret keeps them out of it.

/** What Playwright's `connectOverCDP` needs to reach a screen's Chromium. */
export interface DevToolsEndpoint {
  url: string;
  headers: Record<string, string>;
}

// The readiness probe's id; Playwright's own ids count up from 1.
const PROBE_ID = 2 ** 31 - 1;

function refuse(socket: Duplex, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class DevToolsBridge {
  private readonly secret = randomBytes(32).toString('base64url');
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private client: WebSocket | undefined;
  private probe: (() => void) | undefined;
  private partial: Buffer[] = [];
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly input: Writable,
  ) {}

  /**
   * Listens on 127.0.0.1 and bridges it to Chromium's pipe: `input` is
   * Chromium's fd 3, `output` its fd 4.
   */
  static async listen(input: Writable, output: Readable) {
    const server = createServer((_req, res) => res.writeHead(404).end());
    const bridge = new DevToolsBridge(server, input);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      bridge.upgrade(req, socket, head),
    );
    input.on('error', () => void bridge.close());
    output.on('data', (chunk: Buffer) => bridge.fromChromium(chunk));
    output.once('close', () => void bridge.close());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return bridge;
  }

  endpoint(): DevToolsEndpoint {
    return {
      url: `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/devtools/browser`,
      headers: { authorization: `Bearer ${this.secret}` },
    };
  }

  /** Resolves once Chromium answers on the pipe. */
  async ready(timeoutMs = 30_000): Promise<void> {
    const answered = new Promise<void>((resolve) => (this.probe = () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AgentError(500, 'START_TIMEOUT', 'Timed out waiting for Chromium')),
        timeoutMs,
      );
    });
    this.toChromium(JSON.stringify({ id: PROBE_ID, method: 'Browser.getVersion' }));
    try {
      await Promise.race([answered, timeout]);
    } finally {
      clearTimeout(timer);
      this.probe = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client?.close(1001, 'Chromium exited');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!tokenMatches(this.secret, bearer(req.headers.authorization)))
      return refuse(socket, 401, 'Unauthorized');
    // One pipe, one CDP session: a second client would share the message ids.
    if (this.client || this.closed) return refuse(socket, 409, 'Conflict');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.client = ws;
      ws.on('message', (data: RawData) => this.toChromium(data.toString()));
      ws.once('close', () => {
        if (this.client === ws) this.client = undefined;
      });
    });
  }

  private toChromium(message: string) {
    if (!this.closed) this.input.write(`${message}\0`);
  }

  private fromChromium(chunk: Buffer) {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.partial.push(chunk.subarray(start, end));
      const message = Buffer.concat(this.partial).toString('utf8');
      this.partial = [];
      start = end + 1;
      if (this.probe && (JSON.parse(message) as { id?: number }).id === PROBE_ID) {
        this.probe();
        continue;
      }
      const client = this.client;
      if (client && client.readyState === client.OPEN) client.send(message);
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
  }
}
