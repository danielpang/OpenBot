import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import { schema, type Db } from '../db/client.js';
import { decryptSecret, encryptSecret, keyringFromConfig } from '../secrets.js';

// The install's relay identity (RELAY_PROTOCOL.md sections 1 and 2; plan
// MOBILE_AND_VM_PLAN.md 4.1): an Ed25519 key pair made at first start, its
// private key sealed with the master key in `instance_keys` (one row, id 1;
// `rotateMasterKey` re-seals it). Its public key hashes to the host id the
// relay knows this server by, and the X25519 pair derived from it is the
// Noise static key phones pin from the pairing link.

export interface InstanceKey {
  /** The first 26 characters of base32(SHA-256(publicKey)), lower case. */
  hostId: string;
  /** The Ed25519 public key, 32 bytes. */
  publicKey: Uint8Array;
  /** The Ed25519 private key (the 32 byte seed): it signs the relay's challenge. */
  signingKey: Uint8Array;
  /** The X25519 public key derived from the pair: the Noise static key, the link's `key`. */
  tunnelPublicKey: Uint8Array;
  /** The X25519 private key derived from the pair. */
  tunnelPrivateKey: Uint8Array;
}

const INSTANCE_KEY_ID = 1;
const HOST_ID_LENGTH = 26;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower case, without padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The host id of an Ed25519 public key (RELAY_PROTOCOL.md section 1). */
export function hostIdOf(publicKey: Uint8Array): string {
  return base32(createHash('sha256').update(publicKey).digest()).slice(0, HOST_ID_LENGTH);
}

/** Everything else, from the Ed25519 private key. */
export function instanceKeyFrom(signingKey: Uint8Array): InstanceKey {
  const publicKey = ed25519.getPublicKey(signingKey);
  return {
    hostId: hostIdOf(publicKey),
    publicKey,
    signingKey,
    tunnelPublicKey: ed25519.utils.toMontgomery(publicKey),
    tunnelPrivateKey: ed25519.utils.toMontgomerySecret(signingKey),
  };
}

// Per database: the key never changes once made (rotation re-seals, it does not replace).
const cache = new WeakMap<Db, Promise<InstanceKey>>();

/**
 * The install's key pair, made and stored on the first call. Safe to call
 * from several processes at once: the row has a fixed id, so only one
 * insert lands and every caller reads that one.
 */
export function ensureInstanceKey({
  db,
  config,
}: {
  db: Db;
  config: Pick<Config, 'masterKey' | 'previousMasterKeys'>;
}): Promise<InstanceKey> {
  let pending = cache.get(db);
  if (!pending) {
    pending = loadOrCreate(db, config);
    cache.set(db, pending);
    pending.catch(() => cache.delete(db));
  }
  return pending;
}

async function loadOrCreate(
  db: Db,
  config: Pick<Config, 'masterKey' | 'previousMasterKeys'>,
): Promise<InstanceKey> {
  const keyring = keyringFromConfig(config);
  const existing = await read(db);
  if (existing) return instanceKeyFrom(decryptSecret(existing.signingKey, keyring));
  const signingKey = ed25519.utils.randomSecretKey();
  await db
    .insert(schema.instanceKeys)
    .values({
      id: INSTANCE_KEY_ID,
      signingKey: encryptSecret(signingKey, keyring),
      publicKey: Buffer.from(ed25519.getPublicKey(signingKey)),
    })
    .onConflictDoNothing();
  const stored = await read(db);
  if (!stored) throw new Error('the instance key could not be stored');
  return instanceKeyFrom(decryptSecret(stored.signingKey, keyring));
}

async function read(db: Db) {
  const [row] = await db
    .select()
    .from(schema.instanceKeys)
    .where(eq(schema.instanceKeys.id, INSTANCE_KEY_ID));
  return row;
}
