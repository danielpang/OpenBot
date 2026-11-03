import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  base64urlDecode,
  base64urlEncode,
  generateDeviceKey,
  generateSigningKey,
  hostIdFromPublicKey,
  isHostId,
  signHostChallenge,
  tunnelKeyFromSigningKey,
  tunnelPublicKeyFromSigningPublicKey,
  verifyHostChallenge,
  x25519PublicKey,
} from './keys.js';

describe('base64url', () => {
  it('matches Node for every length and has no padding', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
      const encoded = base64urlEncode(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(encoded).not.toContain('=');
      expect(base64urlDecode(encoded)).toEqual(bytes);
    }
  });

  it('refuses characters outside the alphabet and impossible lengths', () => {
    expect(() => base64urlDecode('ab+c')).toThrow(/unexpected character/);
    expect(() => base64urlDecode('abcde')).toThrow(/bad length/);
  });
});

describe('base32 and host ids', () => {
  it('encodes the RFC 4648 test vectors in lower case without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [input, output] of vectors)
      expect(base32Encode(new TextEncoder().encode(input))).toBe(output);
  });

  it('is the first 26 characters of base32(sha256(public key))', () => {
    const { publicKey } = generateSigningKey();
    const hostId = hostIdFromPublicKey(publicKey);
    expect(hostId).toHaveLength(26);
    expect(isHostId(hostId)).toBe(true);
    expect(base32Encode(sha256(publicKey)).startsWith(hostId)).toBe(true);
    expect(hostIdFromPublicKey(new Uint8Array(32))).toBe(
      base32Encode(sha256(new Uint8Array(32))).slice(0, 26),
    );
    expect(isHostId('NOT-A-HOST')).toBe(false);
  });
});

describe('keys', () => {
  it('derives the tunnel key from the signing key the libsodium way', () => {
    const signing = generateSigningKey();
    const tunnel = tunnelKeyFromSigningKey(signing.privateKey);
    expect(tunnel.privateKey).toHaveLength(32);
    expect(tunnel.publicKey).toEqual(tunnelPublicKeyFromSigningPublicKey(signing.publicKey));
    expect(tunnel.publicKey).toEqual(ed25519.utils.toMontgomery(signing.publicKey));
    expect(x25519PublicKey(tunnel.privateKey)).toEqual(tunnel.publicKey);
  });

  it('makes X25519 device keys', () => {
    const device = generateDeviceKey();
    expect(device.publicKey).toHaveLength(32);
    expect(x25519PublicKey(device.privateKey)).toEqual(device.publicKey);
  });

  it('signs and verifies the relay host challenge over the prefixed nonce', () => {
    const signing = generateSigningKey();
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const sig = signHostChallenge(signing.privateKey, nonce);
    expect(verifyHostChallenge(signing.publicKey, nonce, sig)).toBe(true);

    const prefix = new TextEncoder().encode('openbots-relay-host-v1\n');
    const message = new Uint8Array([...prefix, ...nonce]);
    expect(ed25519.verify(sig, message, signing.publicKey)).toBe(true);

    const otherNonce = nonce.slice();
    otherNonce[0]! ^= 1;
    expect(verifyHostChallenge(signing.publicKey, otherNonce, sig)).toBe(false);
    expect(verifyHostChallenge(generateSigningKey().publicKey, nonce, sig)).toBe(false);
    expect(verifyHostChallenge(signing.publicKey, nonce, new Uint8Array(3))).toBe(false);
    expect(() => signHostChallenge(signing.privateKey, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
