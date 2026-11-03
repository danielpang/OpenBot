import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The host identity of docs/RELAY_PROTOCOL.md sections 1 and 3.1. A host id is
// the first 26 characters of the lower case base32 of SHA-256 of the server's
// Ed25519 public key, so nobody can link as another server's host id without
// its private key: the relay challenges each link with a nonce and checks the
// signature against the key whose hash is the claimed id. packages/tunnel
// exports the same helpers for the server; these are the relay's own copy so
// the relay depends on nothing but the wire contract.

/** What a host id looks like: 26 characters of the RFC 4648 base32 alphabet, lower case. */
export const HOST_ID_PATTERN = /^[a-z2-7]{26}$/;

/** The bytes a host signs before the nonce (3.1). */
export const HELLO_CONTEXT = 'openbots-relay-host-v1\n';

export const NONCE_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function isHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

/** The host id that `publicKey` proves (section 1). */
export function hostIdFor(publicKey: Uint8Array): string {
  return base32(sha256(publicKey)).slice(0, 26);
}

/** The message a host signs for `nonce`: the context's UTF-8 bytes, then the nonce. */
export function helloMessage(nonce: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode(HELLO_CONTEXT);
  const message = new Uint8Array(context.length + nonce.length);
  message.set(context, 0);
  message.set(nonce, context.length);
  return message;
}

export interface HelloProof {
  hostId: string;
  publicKey: Uint8Array;
  sig: Uint8Array;
}

/**
 * Whether a host's `hello` proves `hostId` for `nonce`: the id must be the
 * hash of the key and the signature must verify. A key that is not a curve
 * point makes noble throw, which is a failed proof like any other.
 */
export function verifyHello({ hostId, publicKey, sig }: HelloProof, nonce: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES || sig.length !== SIGNATURE_BYTES) return false;
  if (hostIdFor(publicKey) !== hostId) return false;
  try {
    return ed25519.verify(sig, helloMessage(nonce), publicKey);
  } catch {
    return false;
  }
}

/** RFC 4648 base32 in lower case, without padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    // Only the low `bits` bits are still owed; dropping the rest keeps the
    // number small enough for 32 bit shifts.
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** base64url without padding (RFC 4648 section 5), the encoding of every binary JSON field. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Decodes base64url without padding, or answers undefined for anything else.
 * Node's decoder skips characters outside the alphabet, so the text is
 * checked first and a string that does not round trip is refused.
 */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return undefined;
  return new Uint8Array(bytes);
}
