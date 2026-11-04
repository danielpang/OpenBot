import { createHash } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { scopedDb } from '../db/scope.js';
import { createTestDb, type TestDb } from '../db/test-db.js';
import { decodeEnvelope, generateMasterKey, keyringFromConfig } from '../secrets.js';
import { ensureWorkspace } from '../workspace.js';
import { base32, ensureInstanceKey, hostIdOf, openInstanceKey } from './instance-key.js';

// The relay identity (RELAY_PROTOCOL.md sections 1 and 2).

describe('base32 and the host id', () => {
  it('encodes as RFC 4648, lower case, without padding', () => {
    // RFC 4648 section 10's test vectors.
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [input, output] of vectors) expect(base32(Buffer.from(input))).toBe(output);
  });

  it('is the first 26 characters of base32(SHA-256(public key))', () => {
    const key = Buffer.alloc(32, 5);
    const id = hostIdOf(key);
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    expect(id).toBe(base32(createHash('sha256').update(key).digest()).slice(0, 26));
  });
});

describe('ensureInstanceKey', () => {
  let t: TestDb;
  const config = { masterKey: generateMasterKey(), previousMasterKeys: [] };

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(() => t?.close());

  it('makes one sealed Ed25519 pair, derives the X25519 tunnel key, and keeps it', async () => {
    const db = scopedDb(t.db);
    const key = await ensureInstanceKey({ db, config });
    expect(key.hostId).toBe(hostIdOf(key.publicKey));
    expect(ed25519.getPublicKey(key.signingKey)).toEqual(key.publicKey);
    expect(x25519.getPublicKey(key.tunnelPrivateKey)).toEqual(key.tunnelPublicKey);
    // A signature with it verifies, as the relay checks the host's (3.1).
    const message = Buffer.from('openbots-relay-host-v1\n');
    expect(ed25519.verify(ed25519.sign(message, key.signingKey), message, key.publicKey)).toBe(
      true,
    );

    const rows = await t.db.select().from(schema.instanceKeys);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.publicKey)).toEqual(Buffer.from(key.publicKey));
    expect(decodeEnvelope(rows[0]!.signingKey).kid).toBe(keyringFromConfig(config).current.id);
    expect(rows[0]!.signingKey.includes(Buffer.from(key.signingKey))).toBe(false);

    // Another process (another handle on the same database) reads the same key.
    const again = await ensureInstanceKey({ db: scopedDb(t.db), config });
    expect(again.hostId).toBe(key.hostId);
    expect(await t.db.select().from(schema.instanceKeys)).toHaveLength(1);
  });
});

describe('openInstanceKey at start', () => {
  let t: TestDb;
  const config = { masterKey: generateMasterKey(), previousMasterKeys: [] };
  const logger = () => {
    const errors: unknown[][] = [];
    return { errors, error: (...args: unknown[]) => void errors.push(args) };
  };

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(() => t?.close());

  it('says loudly that phones must pair again when the key is gone but devices are paired', async () => {
    const workspace = await ensureWorkspace(scopedDb(t.db));
    await t.db.insert(schema.devicePairings).values({
      workspaceId: workspace.id,
      codeHash: Buffer.alloc(32, 1),
      name: 'Home',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: 'cli',
    });
    const log = logger();
    const key = await openInstanceKey({ db: scopedDb(t.db), config, logger: log });
    expect(key).not.toBeNull();
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]![0])).toMatch(/every paired phone must pair again/);
    // Once it is there, nothing more is said.
    const quiet = logger();
    expect((await openInstanceKey({ db: scopedDb(t.db), config, logger: quiet }))?.hostId).toBe(
      key!.hostId,
    );
    expect(quiet.errors).toEqual([]);
  });

  it('runs with the relay off, saying why, when the master key does not open it', async () => {
    const log = logger();
    const wrong = { masterKey: generateMasterKey(), previousMasterKeys: [] };
    expect(await openInstanceKey({ db: scopedDb(t.db), config: wrong, logger: log })).toBeNull();
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]![1])).toMatch(/the relay is off/);
    // A route that needs it answers 503, not a crash.
    await expect(ensureInstanceKey({ db: scopedDb(t.db), config: wrong })).rejects.toMatchObject({
      status: 503,
      code: 'INSTANCE_KEY_UNAVAILABLE',
    });
  });
});
