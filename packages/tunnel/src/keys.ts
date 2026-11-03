import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The keys of docs/RELAY_PROTOCOL.md sections 1 to 3. A server holds one
// Ed25519 signing key: its public key hashes to the host id the relay knows it
// by, it signs the relay's link challenge, and its X25519 form (the standard
// libsodium conversion) is the Noise static key a paired device pins. A device
// holds one X25519 key, made at pairing. Everything here is plain Uint8Array
// so the same code runs in Node, a browser and React Native.

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_INDEX = new Map([...BASE64URL].map((char, index) => [char, index]));
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Base64url without padding (RFC 4648 section 5), the encoding of binary in the protocol's JSON. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += BASE64URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += BASE64URL[c & 0x3f];
  }
  return out;
}

/**
 * Decodes base64url. Padding is tolerated and stripped; any other character
 * outside the alphabet, or a length no encoder produces, throws.
 */
export function base64urlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('invalid base64url: bad length');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = BASE64URL_INDEX.get(char);
    if (digit === undefined)
      throw new Error(`invalid base64url: unexpected character ${JSON.stringify(char)}`);
    value = ((value << 6) | digit) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** Lower case base32 (RFC 4648 alphabet `a-z2-7`) without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f];
  return out;
}

/** A fresh Ed25519 pair: the server signing key of spec section 2. `privateKey` is the 32 byte seed. */
export function generateSigningKey(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/** The host id of spec section 1: the first 26 characters of base32(SHA-256(Ed25519 public key)). */
export function hostIdFromPublicKey(ed25519PublicKey: Uint8Array): string {
  if (ed25519PublicKey.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return base32Encode(sha256(ed25519PublicKey)).slice(0, 26);
}

/** True when `hostId` has the shape of a host id (26 characters of `a-z2-7`). */
export function isHostId(hostId: string): boolean {
  return /^[a-z2-7]{26}$/.test(hostId);
}

/**
 * The server tunnel key of spec section 2: the X25519 pair derived from the
 * Ed25519 signing key, as libsodium's `crypto_sign_ed25519_sk_to_curve25519`
 * does. The public half equals the conversion of the Ed25519 public key.
 */
export function tunnelKeyFromSigningKey(ed25519PrivateKey: Uint8Array): KeyPair {
  const privateKey = ed25519.utils.toMontgomerySecret(ed25519PrivateKey);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** The X25519 public key of an Ed25519 public key, so a server's tunnel key can be found from its signing key's public half alone. */
export function tunnelPublicKeyFromSigningPublicKey(ed25519PublicKey: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(ed25519PublicKey);
}

/** A fresh X25519 pair: the device static key of spec section 2. */
export function generateDeviceKey(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/** The X25519 public key of a private key. */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

const HOST_CHALLENGE_PREFIX = new TextEncoder().encode('openbots-relay-host-v1\n');

function hostChallengeMessage(nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 32) throw new Error('a relay challenge nonce is 32 bytes');
  const message = new Uint8Array(HOST_CHALLENGE_PREFIX.length + nonce.length);
  message.set(HOST_CHALLENGE_PREFIX);
  message.set(nonce, HOST_CHALLENGE_PREFIX.length);
  return message;
}

/** Signs the relay's link challenge (spec 3.1): the UTF-8 of `openbots-relay-host-v1\n` then the 32 nonce bytes. */
export function signHostChallenge(ed25519PrivateKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  return ed25519.sign(hostChallengeMessage(nonce), ed25519PrivateKey);
}

/** Checks a host's challenge signature. A malformed key, signature or nonce is false, never a throw. */
export function verifyHostChallenge(
  ed25519PublicKey: Uint8Array,
  nonce: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, hostChallengeMessage(nonce), ed25519PublicKey);
  } catch {
    return false;
  }
}
