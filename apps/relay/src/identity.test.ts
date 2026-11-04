import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  base32,
  fromBase64Url,
  helloMessage,
  isHostId,
  toBase64Url,
  verifyHello,
} from './identity.js';
import { makeHost } from './test/helpers.js';

describe('identity', () => {
  it('encodes base32 as RFC 4648 does, in lower case and without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [input, output] of vectors) {
      expect(base32(new TextEncoder().encode(input))).toBe(output);
    }
  });

  it('makes a host id from the first 26 characters of the hash of the key', () => {
    const { publicKey, hostId } = makeHost();
    expect(hostId).toBe(base32(sha256(publicKey)).slice(0, 26));
    expect(isHostId(hostId)).toBe(true);
    expect(isHostId(hostId.toUpperCase())).toBe(false);
    expect(isHostId(hostId.slice(1))).toBe(false);
  });

  it('round trips base64url and refuses padding and foreign characters', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).not.toContain('=');
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(fromBase64Url(`${text}=`)).toBeUndefined();
    expect(fromBase64Url('ab+/')).toBeUndefined();
    expect(fromBase64Url('a')).toBeUndefined();
  });

  it('verifies a hello over the context and the nonce', () => {
    const host = makeHost();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const sig = ed25519.sign(helloMessage(nonce), host.secretKey);
    expect(verifyHello({ ...host, sig }, nonce)).toBe(true);
    expect(verifyHello({ ...host, sig }, new Uint8Array(32))).toBe(false);
    expect(verifyHello({ ...host, hostId: makeHost().hostId, sig }, nonce)).toBe(false);
    expect(verifyHello({ ...host, sig: new Uint8Array(64) }, nonce)).toBe(false);
    expect(new TextDecoder().decode(helloMessage(nonce).subarray(0, 23))).toBe(
      'openbots-relay-host-v1\n',
    );
  });
});
