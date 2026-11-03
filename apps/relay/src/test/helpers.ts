import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { createRelay, type Relay, type RelayOptions } from '../relay.js';
import { fromBase64Url, helloMessage, hostIdFor, toBase64Url } from '../identity.js';

// Helpers for the relay's tests: a relay on port 0 that is closed after each
// test, a host identity, and a socket wrapper that queues what arrives so a
// test can await the next frame or the close.

const relays: Relay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', ...options });
  relays.push(relay);
  return relay;
}

export interface HostIdentity {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  hostId: string;
}

export function makeHost(): HostIdentity {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, hostId: hostIdFor(publicKey) };
}

export type Frame = { text: Record<string, unknown> } | { binary: Buffer };

export interface Closed {
  code: number;
  reason: string;
}

/** A WebSocket whose frames queue up for `next`. */
export class Peer {
  readonly closed: Promise<Closed>;
  private readonly frames: Frame[] = [];
  private readonly waiters: ((frame: Frame) => void)[] = [];

  constructor(readonly socket: WebSocket) {
    sockets.push(socket);
    socket.on('message', (data: RawData, isBinary) => {
      const buffer = data as Buffer;
      const frame: Frame = isBinary
        ? { binary: Buffer.from(buffer) }
        : { text: JSON.parse(buffer.toString('utf8')) as Record<string, unknown> };
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });
  }

  static async open(url: string): Promise<Peer> {
    const socket = new WebSocket(url);
    const peer = new Peer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return peer;
  }

  next(): Promise<Frame> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async text(): Promise<Record<string, unknown>> {
    const frame = await this.next();
    if (!('text' in frame)) throw new Error('expected a text frame, got binary');
    return frame.text;
  }

  async binary(): Promise<Buffer> {
    const frame = await this.next();
    if (!('binary' in frame))
      throw new Error(`expected a binary frame, got ${JSON.stringify(frame)}`);
    return frame.binary;
  }

  send(data: string | Buffer | Record<string, unknown>): void {
    this.socket.send(
      Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data),
    );
  }
}

export function wsUrl(relay: Relay, path: string): string {
  return relay.url.replace(/^http/, 'ws') + path;
}

/** Signs the challenge as `host` would. */
export function hello(
  host: HostIdentity,
  challenge: Record<string, unknown>,
  capabilities: string[] = ['streams', 'push'],
): Record<string, unknown> {
  const nonce = fromBase64Url(String(challenge.nonce))!;
  return {
    type: 'hello',
    v: 1,
    hostId: host.hostId,
    publicKey: toBase64Url(host.publicKey),
    sig: toBase64Url(ed25519.sign(helloMessage(nonce), host.secretKey)),
    capabilities,
  };
}

/** A host link through to `linked`. */
export async function linkHost(
  relay: Relay,
  host: HostIdentity,
  capabilities?: string[],
): Promise<Peer> {
  const peer = await Peer.open(wsUrl(relay, '/v1/host'));
  const challenge = await peer.text();
  peer.send(hello(host, challenge, capabilities));
  const linked = await peer.text();
  if (linked.type !== 'linked') throw new Error(`not linked: ${JSON.stringify(linked)}`);
  return peer;
}

/** A client stream through to `open`, and the host's matching `open`. */
export async function connectClient(
  relay: Relay,
  host: HostIdentity,
  hostLink: Peer,
): Promise<{ client: Peer; stream: number }> {
  const client = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
  const opened = await client.text();
  if (opened.type !== 'open') throw new Error(`not open: ${JSON.stringify(opened)}`);
  const hostOpen = await hostLink.text();
  return { client, stream: Number(hostOpen.stream) };
}

export function prefixed(stream: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(stream, 0);
  payload.copy(frame, 4);
  return frame;
}
