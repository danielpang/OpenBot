import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair } from './keys.js';

// Noise_IK_25519_ChaChaPoly_SHA256, Noise protocol framework revision 34
// (https://noiseprotocol.org/noise.html), the handshake of RELAY_PROTOCOL.md
// section 5.1. The three objects follow the specification's sections 5.1 to
// 5.3 by name: a CipherState holds a key and a nonce counter, a
// SymmetricState holds the chaining key and the handshake hash, and a
// HandshakeState runs the IK message pattern for one side:
//
//   <- s
//   ...
//   -> e, es, s, ss
//   <- e, ee, se
//
// The client is the initiator and knows the server's static key in advance
// (the pre-message `<- s`). After message 2 both sides call `split()` for two
// transport CipherStates, one per direction. Version 1 has no rekey, so a
// CipherState refuses to go past `maxMessages` (2^32 by default, spec 5.1).

export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
/** The prologue of spec 5.1, mixed into the handshake hash so a different protocol can never complete a handshake with this one. */
export const TUNNEL_PROLOGUE = new TextEncoder().encode('openbots-tunnel-v1');
/** Messages per direction before the stream is closed 4400 (spec 5.1). */
export const MAX_NOISE_MESSAGES = 2 ** 32;

const HASHLEN = 32;
const DHLEN = 32;
const TAGLEN = 16;
const EMPTY = new Uint8Array(0);

export class NoiseError extends Error {
  override name = 'NoiseError';
}

/** A CipherState reached its message limit; the stream must close (4400). */
export class NoiseNonceExhaustedError extends NoiseError {
  override name = 'NoiseNonceExhaustedError';
  constructor() {
    super('the Noise message counter reached its limit');
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The ChaChaPoly nonce of Noise section 12.3: 32 bits of zeros, then the counter as 64 bit little-endian. */
function chachaNonce(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, n >>> 0, true);
  view.setUint32(8, Math.floor(n / 2 ** 32), true);
  return nonce;
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(privateKey, publicKey);
  } catch (error) {
    throw new NoiseError(`X25519 failed: ${(error as Error).message}`);
  }
}

/** HKDF of Noise section 4.3 with SHA-256: RFC 5869 with the chaining key as salt and no info. */
function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const okm = hkdf(sha256, ikm, chainingKey, EMPTY, HASHLEN * outputs);
  const out: Uint8Array[] = [];
  for (let i = 0; i < outputs; i++) out.push(okm.slice(i * HASHLEN, (i + 1) * HASHLEN));
  return out;
}

export interface CipherStateOptions {
  /** Messages this state may encrypt or decrypt before it refuses. Defaults to 2^32 (spec 5.1). */
  maxMessages?: number;
}

/** Noise section 5.1. */
export class CipherState {
  #k: Uint8Array | null = null;
  #n = 0;
  readonly maxMessages: number;

  constructor(key: Uint8Array | null = null, options: CipherStateOptions = {}) {
    this.maxMessages = options.maxMessages ?? MAX_NOISE_MESSAGES;
    if (key) this.initializeKey(key);
  }

  initializeKey(key: Uint8Array): void {
    if (key.length !== 32) throw new NoiseError('a cipher key is 32 bytes');
    this.#k = key.slice();
    this.#n = 0;
  }

  hasKey(): boolean {
    return this.#k !== null;
  }

  /** The next nonce, which is also the number of messages this state has handled. */
  get nonce(): number {
    return this.#n;
  }

  setNonce(n: number): void {
    this.#n = n;
  }

  /** True when the next message would pass `maxMessages`. */
  get exhausted(): boolean {
    return this.#n >= this.maxMessages;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#k) return plaintext.slice();
    if (this.exhausted) throw new NoiseNonceExhaustedError();
    const ciphertext = chacha20poly1305(this.#k, chachaNonce(this.#n), ad).encrypt(plaintext);
    this.#n++;
    return ciphertext;
  }

  /** Throws a NoiseError when the tag does not verify; the counter then stays where it was, as section 5.1 asks. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#k) return ciphertext.slice();
    if (this.exhausted) throw new NoiseNonceExhaustedError();
    if (ciphertext.length < TAGLEN) throw new NoiseError('a ciphertext is shorter than its tag');
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#k, chachaNonce(this.#n), ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError('decryption failed');
    }
    this.#n++;
    return plaintext;
  }

  /** Transport messages have no associated data. */
  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.decryptWithAd(EMPTY, ciphertext);
  }
}

/** Noise section 5.2. */
export class SymmetricState {
  readonly cipher: CipherState;
  #ck: Uint8Array;
  #h: Uint8Array;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.#h = new Uint8Array(HASHLEN);
      this.#h.set(name);
    } else {
      this.#h = sha256(name);
    }
    this.#ck = this.#h.slice();
    this.cipher = new CipherState();
  }

  get handshakeHash(): Uint8Array {
    return this.#h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.#ck, ikm, 2);
    this.#ck = ck!;
    this.cipher.initializeKey(tempK!);
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(concat(this.#h, data));
  }

  /** For PSK patterns; IK does not use it, but the object is complete. */
  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = noiseHkdf(this.#ck, ikm, 3);
    this.#ck = ck!;
    this.mixHash(tempH!);
    this.cipher.initializeKey(tempK!);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(options: CipherStateOptions = {}): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.#ck, EMPTY, 2);
    return [new CipherState(k1!, options), new CipherState(k2!, options)];
  }
}

export interface HandshakeOptions {
  initiator: boolean;
  /** This side's static X25519 pair. */
  staticKey: KeyPair;
  /** The responder's static public key. Required on the initiator (the `<- s` pre-message). */
  remoteStaticKey?: Uint8Array;
  /** Defaults to the tunnel's `openbots-tunnel-v1`. */
  prologue?: Uint8Array;
  /** A fixed ephemeral pair, for known-answer tests only. */
  ephemeralKey?: KeyPair;
  /** Passed to the transport CipherStates `split()` makes. */
  maxMessages?: number;
}

/** The two transport CipherStates of one side, already oriented. */
export interface TransportCiphers {
  send: CipherState;
  receive: CipherState;
}

/**
 * Noise section 5.3 for the IK pattern only. Each side calls `writeMessage`
 * and `readMessage` in turn (the initiator writes first), then `split()`.
 */
export class HandshakeState {
  readonly initiator: boolean;
  #ss: SymmetricState;
  #s: KeyPair;
  #e: KeyPair | null = null;
  #rs: Uint8Array | null;
  #re: Uint8Array | null = null;
  #fixedEphemeral: KeyPair | undefined;
  #step = 0;
  #maxMessages: number | undefined;

  constructor(options: HandshakeOptions) {
    this.initiator = options.initiator;
    this.#s = options.staticKey;
    this.#rs = options.remoteStaticKey ?? null;
    this.#fixedEphemeral = options.ephemeralKey;
    this.#maxMessages = options.maxMessages;
    if (this.#s.publicKey.length !== DHLEN || this.#s.privateKey.length !== DHLEN) {
      throw new NoiseError('a static key is 32 bytes');
    }
    if (this.initiator && (!this.#rs || this.#rs.length !== DHLEN)) {
      throw new NoiseError('the initiator needs the responder static key (32 bytes)');
    }
    this.#ss = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.#ss.mixHash(options.prologue ?? TUNNEL_PROLOGUE);
    // The pre-message `<- s`: both sides hash the responder's static key.
    this.#ss.mixHash(this.initiator ? this.#rs! : this.#s.publicKey);
  }

  /** True once both messages have been written and read. */
  get isComplete(): boolean {
    return this.#step === 2;
  }

  get handshakeHash(): Uint8Array {
    return this.#ss.handshakeHash;
  }

  /** The peer's static key: known from the start on the initiator, learned from message 1 on the responder. */
  get remoteStaticKey(): Uint8Array | null {
    return this.#rs ? this.#rs.slice() : null;
  }

  #ephemeral(): KeyPair {
    if (this.#fixedEphemeral) return this.#fixedEphemeral;
    const { secretKey, publicKey } = x25519.keygen();
    return { publicKey, privateKey: secretKey };
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    const ss = this.#ss;
    if (this.initiator && this.#step === 0) {
      // -> e, es, s, ss
      const e = (this.#e = this.#ephemeral());
      ss.mixHash(e.publicKey);
      ss.mixKey(dh(e.privateKey, this.#rs!));
      const encryptedStatic = ss.encryptAndHash(this.#s.publicKey);
      ss.mixKey(dh(this.#s.privateKey, this.#rs!));
      const encryptedPayload = ss.encryptAndHash(payload);
      this.#step = 1;
      return concat(e.publicKey, encryptedStatic, encryptedPayload);
    }
    if (!this.initiator && this.#step === 1) {
      // <- e, ee, se
      const e = (this.#e = this.#ephemeral());
      ss.mixHash(e.publicKey);
      ss.mixKey(dh(e.privateKey, this.#re!));
      ss.mixKey(dh(e.privateKey, this.#rs!));
      const encryptedPayload = ss.encryptAndHash(payload);
      this.#step = 2;
      return concat(e.publicKey, encryptedPayload);
    }
    throw new NoiseError('writeMessage out of turn');
  }

  readMessage(message: Uint8Array): Uint8Array {
    const ss = this.#ss;
    if (!this.initiator && this.#step === 0) {
      // -> e, es, s, ss
      if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) {
        throw new NoiseError('handshake message 1 is too short');
      }
      const re = (this.#re = message.slice(0, DHLEN));
      ss.mixHash(re);
      ss.mixKey(dh(this.#s.privateKey, re));
      const rs = ss.decryptAndHash(message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
      this.#rs = rs;
      ss.mixKey(dh(this.#s.privateKey, rs));
      const payload = ss.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
      this.#step = 1;
      return payload;
    }
    if (this.initiator && this.#step === 1) {
      // <- e, ee, se
      if (message.length < DHLEN + TAGLEN) throw new NoiseError('handshake message 2 is too short');
      const re = (this.#re = message.slice(0, DHLEN));
      ss.mixHash(re);
      ss.mixKey(dh(this.#e!.privateKey, re));
      ss.mixKey(dh(this.#s.privateKey, re));
      const payload = ss.decryptAndHash(message.subarray(DHLEN));
      this.#step = 2;
      return payload;
    }
    throw new NoiseError('readMessage out of turn');
  }

  /** The transport CipherStates: the first `Split` output carries initiator to responder. */
  split(): TransportCiphers {
    if (!this.isComplete) throw new NoiseError('split before the handshake completed');
    const [c1, c2] = this.#ss.split({ maxMessages: this.#maxMessages });
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}
