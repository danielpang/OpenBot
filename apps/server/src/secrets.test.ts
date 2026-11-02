import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  decodeEnvelope,
  decryptSecret,
  decryptSecretString,
  encodeEnvelope,
  encryptSecret,
  generateMasterKey,
  keyId,
  keyringFromConfig,
  keyringFromKeys,
  openEnvelope,
  parseMasterKey,
  resealSecret,
  type Keyring,
} from './secrets.js';

const keyring = keyringFromKeys(generateMasterKey());

describe('secrets', () => {
  it('round-trips strings and bytes', () => {
    const sealed = encryptSecret('sk-live-🔑', keyring);
    expect(decryptSecretString(sealed, keyring)).toBe('sk-live-🔑');

    const bytes = Buffer.from([0, 1, 2, 255]);
    expect(decryptSecret(encryptSecret(bytes, keyring), keyring).equals(bytes)).toBe(true);
    expect(decryptSecretString(encryptSecret('', keyring), keyring)).toBe('');
  });

  it('uses a fresh nonce every time', () => {
    const a = decodeEnvelope(encryptSecret('same', keyring));
    const b = decodeEnvelope(encryptSecret('same', keyring));
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ct.equals(b.ct)).toBe(false);
  });

  it('never stores the plaintext', () => {
    const sealed = encryptSecret('hunter2-hunter2', keyring);
    expect(sealed.includes(Buffer.from('hunter2'))).toBe(false);
  });

  it('records the envelope and key versions', () => {
    const env = decodeEnvelope(encryptSecret('x', keyring));
    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.kid).toBe(keyId(keyring.current.key));
    expect(env.kid).toBe(keyring.current.id);
    expect(env.nonce).toHaveLength(12);
    expect(env.tag).toHaveLength(16);
    expect(encodeEnvelope(env)[0]).toBe(1);
  });

  it('detects tampering with ciphertext, tag, nonce, or key version', () => {
    const sealed = encryptSecret('top secret', keyring);
    for (const offset of [sealed.length - 1, 20, 5]) {
      const tampered = Buffer.from(sealed);
      tampered[offset]! ^= 0x01;
      expect(() => decryptSecret(tampered, keyring)).toThrow();
    }
    const twoKeys = keyringFromKeys(generateMasterKey(), [keyring.current.key.toString('base64')]);
    const relabelled = Buffer.from(sealed);
    relabelled[1] = twoKeys.current.id;
    expect(() => decryptSecret(relabelled, twoKeys)).toThrow(/no configured master key/);
  });

  it('rejects the wrong key, unknown versions, and truncation', () => {
    const sealed = encryptSecret('x', keyring);
    expect(() => decryptSecret(sealed, keyringFromKeys(generateMasterKey()))).toThrow();

    const future = Buffer.from(sealed);
    future[0] = ENVELOPE_VERSION + 1;
    expect(() => decryptSecret(future, keyring)).toThrow(/unsupported secret envelope version 2/);

    const unknownKey = Buffer.from(sealed);
    unknownKey[1] = (keyring.current.id + 1) % 256;
    expect(() => decryptSecret(unknownKey, keyring)).toThrow(
      new RegExp(
        `no configured master key opens this secret \\(sealed under key id ${unknownKey[1]}\\)`,
      ),
    );

    expect(() => decryptSecret(sealed.subarray(0, 20), keyring)).toThrow(/truncated/);
  });

  it('opens envelopes sealed under a previous key after rotation (plan 4.9)', () => {
    const oldKey = generateMasterKey();
    const before = keyringFromKeys(oldKey);
    const sealedOld = encryptSecret('old', before);
    const rotated = keyringFromKeys(generateMasterKey(), [oldKey]);
    expect(decryptSecretString(sealedOld, rotated)).toBe('old');
    expect(openEnvelope(sealedOld, rotated).current).toBe(false);

    const sealedNew = encryptSecret('new', rotated);
    expect(decodeEnvelope(sealedNew).kid).toBe(rotated.current.id);
    expect(openEnvelope(sealedNew, rotated)).toMatchObject({ current: true });
    expect(decryptSecretString(sealedNew, rotated)).toBe('new');
    // The previous key never seals, and alone cannot open what the new one sealed.
    expect(() => decryptSecret(sealedNew, before)).toThrow(/no configured master key/);
  });

  it('re-seals under the current key, and leaves what it sealed already', () => {
    const oldKey = generateMasterKey();
    const sealedOld = encryptSecret('carry me over', keyringFromKeys(oldKey));
    const rotated = keyringFromKeys(generateMasterKey(), [oldKey]);
    const resealed = resealSecret(sealedOld, rotated)!;
    expect(decodeEnvelope(resealed).kid).toBe(rotated.current.id);
    expect(
      decryptSecretString(resealed, keyringFromKeys(rotated.current.key.toString('base64'))),
    ).toBe('carry me over');
    expect(resealSecret(resealed, rotated)).toBeNull();
  });

  it('fails clearly for a leftover once its key is removed', () => {
    const oldKey = generateMasterKey();
    const sealedOld = encryptSecret('left over', keyringFromKeys(oldKey));
    const withoutOld = keyringFromKeys(generateMasterKey());
    expect(() => decryptSecret(sealedOld, withoutOld)).toThrow(
      /no configured master key opens this secret[\s\S]*OPENBOTS_MASTER_KEY_PREVIOUS[\s\S]*rotate-key/,
    );
  });

  it('opens envelopes from before key ids (kid 1) with the key that sealed them', () => {
    const base64 = generateMasterKey();
    const key = parseMasterKey(base64);
    // What encryptSecret wrote before key ids: the only key, as version 1.
    const legacy: Keyring = { current: { id: 1, key }, previous: [] };
    const sealed = encryptSecret('from 0.x', legacy);
    expect(decodeEnvelope(sealed).kid).toBe(1);
    const now = keyringFromKeys(base64);
    expect(decryptSecretString(sealed, now)).toBe('from 0.x');
    expect(openEnvelope(sealed, now).current).toBe(now.current.id === 1);
  });

  it('opens envelopes whose key ids collide by trying every key', () => {
    const a = parseMasterKey(generateMasterKey());
    const b = parseMasterKey(generateMasterKey());
    // Both keys claim id 7: GCM authentication picks the right one.
    const ring: Keyring = { current: { id: 7, key: a }, previous: [{ id: 7, key: b }] };
    const underB = encryptSecret('b', { current: { id: 7, key: b }, previous: [] });
    expect(openEnvelope(underB, ring)).toEqual({ plaintext: Buffer.from('b'), current: false });
    expect(openEnvelope(encryptSecret('a', ring), ring).current).toBe(true);
  });

  it('builds one keyring per config from OPENBOTS_MASTER_KEY and OPENBOTS_MASTER_KEY_PREVIOUS', () => {
    const config = { masterKey: generateMasterKey(), previousMasterKeys: [generateMasterKey()] };
    const ring = keyringFromConfig(config);
    expect(ring).toBe(keyringFromConfig(config));
    expect(ring.current.key.toString('base64')).toBe(config.masterKey);
    expect(ring.previous.map((k) => k.key.toString('base64'))).toEqual(config.previousMasterKeys);
  });

  it('validates master keys', () => {
    expect(parseMasterKey(generateMasterKey())).toHaveLength(32);
    expect(() => parseMasterKey('too-short')).toThrow(/32 bytes/);
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
