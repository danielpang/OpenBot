import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach } from 'vitest';
import type { Relay } from '../relay.js';

// A stand-in for Fly's proxy in front of several relays in one process. Each
// upgrade lands on one relay (the next in `landOn`, else in turn); when that
// relay answers with `fly-replay: instance=<id>`, the proxy sends the same
// request to the relay with that node id, once, with `fly-replay-src` added,
// as Fly does. A replay to a relay that is gone answers 502. Plain requests
// are forwarded to the next relay in turn.

const proxies: FlyProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

export interface Replay {
  from: string;
  to: string;
  path: string;
}

export class FlyProxy {
  /** Every replay followed, in order. */
  readonly replays: Replay[] = [];
  /** Replays a relay asked for on a request that was already replayed; never expected. */
  readonly loops: Replay[] = [];
  private readonly relays: Relay[];
  private readonly landing: Relay[] = [];
  private next = 0;
  private readonly sockets = new Set<Duplex>();

  private constructor(
    private readonly server: Server,
    relays: Relay[],
    readonly url: string,
  ) {
    this.relays = [...relays];
  }

  static async start(relays: Relay[]): Promise<FlyProxy> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const proxy = new FlyProxy(server, relays, `http://127.0.0.1:${port}`);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const target = proxy.pick();
      if (!target) {
        res.writeHead(502).end();
        return;
      }
      const upstream = request(
        {
          host: '127.0.0.1',
          port: target.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      req.pipe(upstream);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      proxy.track(socket);
      socket.on('error', () => socket.destroy());
      void proxy.upgrade(req, socket, head);
    });
    proxies.push(proxy);
    return proxy;
  }

  /** The next upgrades land on these relays, in order; after them, each relay in turn. */
  landOn(...relays: Relay[]): void {
    this.landing.push(...relays);
  }

  /** The relay is gone: nothing lands or is replayed on it. */
  remove(relay: Relay): void {
    const index = this.relays.indexOf(relay);
    if (index !== -1) this.relays.splice(index, 1);
  }

  add(relay: Relay): void {
    this.relays.push(relay);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private pick(): Relay | undefined {
    while (this.landing.length > 0) {
      const relay = this.landing.shift()!;
      if (this.relays.includes(relay)) return relay;
    }
    if (this.relays.length === 0) return undefined;
    const relay = this.relays[this.next % this.relays.length]!;
    this.next += 1;
    return relay;
  }

  private async upgrade(req: IncomingMessage, client: Duplex, head: Buffer) {
    const first = this.pick();
    if (!first) return refuse(client, 502);
    let answer = await this.send(first, req, head, undefined);
    if (!answer) return refuse(client, 502);
    const target = replayTarget(answer.headers);
    if (target !== undefined) {
      answer.upstream.destroy();
      const owner = this.relays.find((relay) => relay.nodeId === target);
      const replay = { from: first.nodeId, to: target, path: req.url ?? '' };
      if (!owner) return refuse(client, 502);
      this.replays.push(replay);
      answer = await this.send(
        owner,
        req,
        head,
        `instance=${first.nodeId};region=test;t=${Date.now() * 1000}`,
      );
      if (!answer) return refuse(client, 502);
      if (replayTarget(answer.headers) !== undefined) {
        // Fly would not be asked twice by a relay that follows the rules.
        this.loops.push({
          from: owner.nodeId,
          to: replayTarget(answer.headers)!,
          path: replay.path,
        });
      }
    }
    const { upstream, raw, rest } = answer;
    this.track(upstream);
    client.write(raw);
    if (rest.length > 0) client.write(rest);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  }

  /** Sends the upgrade request to `relay` and reads the response head. */
  private send(
    relay: Relay,
    req: IncomingMessage,
    head: Buffer,
    replaySource: string | undefined,
  ): Promise<{ upstream: Socket; headers: Map<string, string>; raw: Buffer; rest: Buffer } | null> {
    return new Promise((resolve) => {
      const upstream = connect(relay.port, '127.0.0.1');
      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf('\r\n\r\n');
        if (end === -1) return;
        upstream.off('data', onData);
        upstream.pause();
        const raw = buffered.subarray(0, end + 4);
        const headers = new Map<string, string>();
        for (const line of raw.toString('latin1').split('\r\n').slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0)
            headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        resolve({ upstream, headers, raw, rest: buffered.subarray(end + 4) });
      };
      upstream.on('data', onData);
      upstream.once('error', () => resolve(null));
      upstream.once('close', () => resolve(null));
      upstream.once('connect', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i]!.toLowerCase() === 'fly-replay-src') continue;
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        if (replaySource) lines.push(`fly-replay-src: ${replaySource}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
      });
    });
  }
}

function replayTarget(headers: Map<string, string>): string | undefined {
  const value = headers.get('fly-replay');
  return value?.match(/(?:^|;)\s*instance=([^;\s]+)/)?.[1];
}

function refuse(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
