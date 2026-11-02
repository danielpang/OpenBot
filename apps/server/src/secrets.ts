import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// Secrets at rest (plan 4.9). Every secret column holds one sealed envelope:
//
//   byte 0       v      envelope format version (ENVELOPE_VERSION)
//   byte 1       kid    id of the master key that sealed it (`keyId`)
//   bytes 2-13   nonce  12 random bytes
//   bytes 14-29  tag    16-byte GCM auth tag
//   bytes 30-    ct     AES-256-GCM ciphertext
//
// The two header bytes are bound as additional authenticated data, so editing
// either fails decryption. A key's id comes from the key itself, so operators
// never number keys: OPENBOTS_MASTER_KEY seals, and the keys listed in
// OPENBOTS_MASTER_KEY_PREVIOUS still open what they sealed until `rotate-key`
// (rotation.ts) re-seals it under the current one. Envelopes from before key
// ids carry kid 1. One byte of id can collide, so `kid` only picks which key
// to try first: GCM authentication decides, and every other configured key
// is tried before giving up.

export const ENVELOPE_VERSION = 1;
const HEADER_BYTES = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Envelope {
  v: number;
  kid: number;
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
}

export interface MasterKey {
  id: number;
  key: Buffer;
}

export interface Keyring {
  /** Seals every new envelope. */
  current: MasterKey;
  /** Keys being rotated out; they only open envelopes. */
  previous: readonly MasterKey[];
}

/** A new master key, base64: what `pnpm keygen` prints for OPENBOTS_MASTER_KEY. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== base64.trim()) {
    throw new Error(`master key must be ${KEY_BYTES} bytes, base64-encoded`);
  }
  return key;
}

/** A key's id in envelope headers: one byte of an HMAC under the key, which says nothing about it. */
export function keyId(key: Buffer): number {
  return createHmac('sha256', key).update('openbots:master-key-id').digest()[0]!;
}

export function masterKey(base64: string): MasterKey {
  const key = parseMasterKey(base64);
  return { id: keyId(key), key };
}

/** A keyring from base64 keys: the current one, and the ones being rotated out. */
export function keyringFromKeys(current: string, previous: readonly string[] = []): Keyring {
  return { current: masterKey(current), previous: previous.map(masterKey) };
}

const keyrings = new WeakMap<object, Keyring>();

/** The keyring of OPENBOTS_MASTER_KEY and OPENBOTS_MASTER_KEY_PREVIOUS, built once per config. */
export function keyringFromConfig(config: {
  masterKey: string;
  previousMasterKeys: readonly string[];
}): Keyring {
  let keyring = keyrings.get(config);
  if (!keyring) {
    keyring = keyringFromKeys(config.masterKey, config.previousMasterKeys);
    keyrings.set(config, keyring);
  }
  return keyring;
}

export function encodeEnvelope(env: Envelope): Buffer {
  return Buffer.concat([header(env.v, env.kid), env.nonce, env.tag, env.ct]);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const buf = Buffer.from(bytes);
  if (buf.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new Error('secret envelope is truncated');
  }
  const v = buf[0]!;
  if (v !== ENVELOPE_VERSION) throw new Error(`unsupported secret envelope version ${v}`);
  const nonceEnd = HEADER_BYTES + NONCE_BYTES;
  return {
    v,
    kid: buf[1]!,
    nonce: buf.subarray(HEADER_BYTES, nonceEnd),
    tag: buf.subarray(nonceEnd, nonceEnd + TAG_BYTES),
    ct: buf.subarray(nonceEnd + TAG_BYTES),
  };
}

export function encryptSecret(plaintext: string | Uint8Array, keyring: Keyring): Buffer {
  const { id: kid, key } = keyring.current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header(ENVELOPE_VERSION, kid));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return encodeEnvelope({ v: ENVELOPE_VERSION, kid, nonce, ct, tag: cipher.getAuthTag() });
}

/** Throws if the envelope was tampered with or sealed under a key the keyring does not hold. */
export function decryptSecret(sealed: Uint8Array, keyring: Keyring): Buffer {
  return openEnvelope(sealed, keyring).plaintext;
}

/**
 * Opens an envelope and says whether the current key sealed it, which is what
 * the rotation job needs to know. Keys whose id matches the header go first.
 */
export function openEnvelope(
  sealed: Uint8Array,
  keyring: Keyring,
): { plaintext: Buffer; current: boolean } {
  const env = decodeEnvelope(sealed);
  const keys = [keyring.current, ...keyring.previous];
  const ordered = [
    ...keys.filter((k) => k.id === env.kid),
    ...keys.filter((k) => k.id !== env.kid),
  ];
  for (const candidate of ordered) {
    const plaintext = tryOpen(env, candidate.key);
    if (plaintext) {
      return { plaintext, current: candidate === keyring.current && env.kid === candidate.id };
    }
  }
  throw new Error(
    `no configured master key opens this secret (sealed under key id ${env.kid}): ` +
      'it was tampered with, or sealed under a key no longer in OPENBOTS_MASTER_KEY or OPENBOTS_MASTER_KEY_PREVIOUS ' +
      '(was a previous key removed before `rotate-key` finished?)',
  );
}

function tryOpen(env: Envelope, key: Buffer): Buffer | null {
  const decipher = createDecipheriv('aes-256-gcm', key, env.nonce);
  decipher.setAAD(header(env.v, env.kid));
  decipher.setAuthTag(env.tag);
  try {
    return Buffer.concat([decipher.update(env.ct), decipher.final()]);
  } catch {
    return null;
  }
}

/** Re-seals an envelope under the current key; null when the current key sealed it already. */
export function resealSecret(sealed: Uint8Array, keyring: Keyring): Buffer | null {
  const { plaintext, current } = openEnvelope(sealed, keyring);
  return current ? null : encryptSecret(plaintext, keyring);
}

export function decryptSecretString(sealed: Uint8Array, keyring: Keyring): string {
  return decryptSecret(sealed, keyring).toString('utf8');
}

function header(v: number, kid: number): Buffer {
  if (!Number.isInteger(kid) || kid < 0 || kid > 255) throw new Error(`invalid key id ${kid}`);
  return Buffer.from([v, kid]);
}
