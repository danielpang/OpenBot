import { createCipheriv, randomBytes } from 'node:crypto';

// x11vnc behind a password (S-7). Each screen's x11vnc gets a random password
// only the agent knows; `/vnc/:n` answers x11vnc's VNC authentication itself
// and offers the noVNC client no authentication, since the agent token on
// the upgrade has already authenticated it. Only the RFB handshake (RFC 6143
// 7.1) is read here; after it the bridge copies bytes both ways.

const VNC_AUTH = 2;
const NO_AUTH = 1;

/** A screen's x11vnc password. VNC authentication reads 8 characters. */
export const vncPassword = () => randomBytes(6).toString('base64url');

/** Buffers a byte stream so the handshake can read it a field at a time. */
export class ByteReader {
  private buffered = Buffer.alloc(0);
  private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null;
  private error: Error | null = null;

  push(chunk: Buffer) {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.flush();
  }

  fail(error: Error) {
    this.error ??= error;
    this.waiting?.reject(this.error);
    this.waiting = null;
  }

  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this.flush();
    });
  }

  /** Everything buffered and not yet read. */
  rest(): Buffer {
    const rest = this.buffered;
    this.buffered = Buffer.alloc(0);
    return rest;
  }

  private flush() {
    if (!this.waiting || this.buffered.length < this.waiting.n) return;
    const { n, resolve } = this.waiting;
    this.waiting = null;
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    resolve(out);
  }
}

const reverseBits = (b: number) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
};

/**
 * The answer to a VNC authentication challenge: the 16 bytes DES-encrypted
 * with the password as the key, each key byte's bits reversed.
 */
export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]!);
  // Single DES is in OpenSSL 3's legacy provider, which Node does not load;
  // triple DES with the same key three times is single DES.
  const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

const fail = (why: string) => new Error(`VNC handshake: ${why}`);

/** The minor version both sides speak: 3.8, 3.7 or 3.3. */
function minorVersion(greeting: Buffer): number {
  const m = /^RFB 003\.(\d{3})\n$/.exec(greeting.toString('latin1'));
  if (!m) throw fail('not an RFB greeting');
  const minor = Number(m[1]);
  return minor >= 8 ? 8 : minor === 7 ? 7 : 3;
}

const version = (minor: number) => Buffer.from(`RFB 003.00${minor}\n`, 'latin1');
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

async function reason(server: ByteReader) {
  const length = (await server.read(4)).readUInt32BE(0);
  return (await server.read(Math.min(length, 1024))).toString('utf8');
}

/** Logs in to x11vnc with `password`; the session continues with ClientInit. */
export async function authenticateToServer(
  server: ByteReader,
  send: (b: Buffer) => void,
  password: string,
): Promise<void> {
  const minor = minorVersion(await server.read(12));
  send(version(minor));
  if (minor === 3) {
    const type = (await server.read(4)).readUInt32BE(0);
    if (type === 0) throw fail(await reason(server));
    if (type !== VNC_AUTH) throw fail(`the server wants security type ${type}`);
  } else {
    const count = (await server.read(1))[0]!;
    if (count === 0) throw fail(await reason(server));
    const types = await server.read(count);
    if (!types.includes(VNC_AUTH)) throw fail(`the server offers types ${[...types].join(',')}`);
    send(Buffer.from([VNC_AUTH]));
  }
  send(vncAuthResponse(password, await server.read(16)));
  if ((await server.read(4)).readUInt32BE(0) !== 0) {
    throw fail(minor === 8 ? await reason(server) : 'authentication failed');
  }
}

/** Greets the noVNC client and lets it in without a password. */
export async function acceptClient(client: ByteReader, send: (b: Buffer) => void): Promise<void> {
  send(version(8));
  const minor = minorVersion(await client.read(12));
  if (minor === 3) return send(u32(NO_AUTH));
  send(Buffer.from([1, NO_AUTH]));
  const chosen = (await client.read(1))[0];
  if (chosen !== NO_AUTH) throw fail(`the client chose security type ${chosen}`);
  if (minor === 8) send(u32(0));
}
