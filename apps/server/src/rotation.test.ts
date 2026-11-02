import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { eq, getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authSecret } from './auth.js';
import { schema } from './db/client.js';
import { createTestDb, type TestDb } from './db/test-db.js';
import { SEALED_COLUMNS, rotateMasterKey } from './rotation.js';
import {
  decodeEnvelope,
  decryptSecretString,
  encryptSecret,
  generateMasterKey,
  keyringFromConfig,
} from './secrets.js';

// Plan 4.9: re-sealing every stored secret under a new master key.

const oldKey = generateMasterKey();
const newKey = generateMasterKey();
const before = { masterKey: oldKey, previousMasterKeys: [] };
const rotating = { masterKey: newKey, previousMasterKeys: [oldKey] };
const after = { masterKey: newKey, previousMasterKeys: [] };

describe('SEALED_COLUMNS', () => {
  it('lists every bytea column in the schema', () => {
    const found: string[] = [];
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      for (const column of Object.values(getTableColumns(table))) {
        if (column.getSQLType() === 'bytea') found.push(`${getTableName(table)}.${column.name}`);
      }
    }
    expect(found.sort()).toEqual(SEALED_COLUMNS.map((c) => c.name).sort());
  });
});

describe('rotateMasterKey', () => {
  let t: TestDb;
  let workspaceId: string;
  let ownerId: string;
  let botId: string;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    const [workspace] = await t.db
      .insert(schema.workspaces)
      .values({ name: 'Home', slug: 'home' })
      .returning();
    const [owner] = await t.db
      .insert(schema.users)
      .values({ name: 'Ada', email: 'ada@example.com' })
      .returning();
    workspaceId = workspace!.id;
    ownerId = owner!.id;
    const [bot] = await t.db
      .insert(schema.bots)
      .values({ workspaceId, ownerId, handle: 'ada', name: 'Ada' })
      .returning();
    botId = bot!.id;
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  const seal = (value: string, config = before) => encryptSecret(value, keyringFromConfig(config));

  async function connector(value: string, config = before) {
    n++;
    const [row] = await t.db
      .insert(schema.connectors)
      .values({
        workspaceId,
        ownerId,
        name: `C${n}`,
        slug: `c${n}`,
        kind: 'mcp_stdio',
        status: 'ok',
        secrets: seal(value, config),
      })
      .returning();
    return row!;
  }

  async function clear() {
    for (const table of [
      schema.connectors,
      schema.providers,
      schema.computers,
      schema.webhookEndpoints,
      schema.eventSubscriptions,
      schema.accounts,
    ]) {
      await t.db.delete(table);
    }
  }

  it('re-seals every sealed column and the OAuth tokens under the new key, once', async () => {
    await clear();
    const conn = await connector('{"values":{"TOKEN":"c"}}');
    await t.db.insert(schema.providers).values({
      workspaceId,
      kind: 'custom',
      protocol: 'openai_compatible',
      name: 'P',
      slug: 'p',
      status: 'ok',
      secrets: seal('sk-provider'),
      headerSecrets: seal('{"X-Key":"h"}'),
    });
    await t.db
      .insert(schema.computers)
      .values({ workspaceId, ownerId, status: 'stopped', agentToken: seal('agent') });
    await t.db
      .insert(schema.webhookEndpoints)
      .values({ workspaceId, botId, slug: 'w', tokenHash: 'h', signatureSecret: seal('whsec') });
    await t.db
      .insert(schema.eventSubscriptions)
      .values({ workspaceId, ownerId, url: 'https://example.com/hook', secret: seal('evsec') });
    const oldAuth = authSecret(oldKey);
    await t.db.insert(schema.accounts).values({
      accountId: '1',
      providerId: 'github',
      userId: ownerId,
      accessToken: await symmetricEncrypt({ key: oldAuth, data: 'gho_access' }),
      refreshToken: await symmetricEncrypt({ key: oldAuth, data: 'ghr_refresh' }),
    });

    const progress: string[] = [];
    const report = await rotateMasterKey({
      db: t.db,
      config: rotating,
      onProgress: (p) => progress.push(`${p.column} ${p.checked}/${p.resealed}`),
    });
    expect(report).toEqual({ resealed: 7, current: 0, failed: [] });
    expect(progress).toEqual([
      'connectors.secrets 1/1',
      'providers.secrets 1/1',
      'providers.header_secrets 1/1',
      'computers.agent_token 1/1',
      'webhook_endpoints.signature_secret 1/1',
      'event_subscriptions.secret 1/1',
      'accounts.oauth_tokens 1/1',
    ]);

    // Everything opens with the new key alone, and says so in its header.
    const ring = keyringFromConfig(after);
    const [c] = await t.db.select().from(schema.connectors);
    const [p] = await t.db.select().from(schema.providers);
    const [k] = await t.db.select().from(schema.computers);
    const [w] = await t.db.select().from(schema.webhookEndpoints);
    const [e] = await t.db.select().from(schema.eventSubscriptions);
    const opened = [
      c!.secrets,
      p!.secrets,
      p!.headerSecrets,
      k!.agentToken,
      w!.signatureSecret,
      e!.secret,
    ];
    expect(opened.map((v) => decryptSecretString(v!, ring))).toEqual([
      '{"values":{"TOKEN":"c"}}',
      'sk-provider',
      '{"X-Key":"h"}',
      'agent',
      'whsec',
      'evsec',
    ]);
    for (const v of opened) expect(decodeEnvelope(v!).kid).toBe(ring.current.id);
    // Re-sealing is not an edit.
    expect(c!.updatedAt).toEqual(conn.updatedAt);
    const [account] = await t.db.select().from(schema.accounts);
    const newAuth = authSecret(newKey);
    expect(await symmetricDecrypt({ key: newAuth, data: account!.accessToken! })).toBe(
      'gho_access',
    );
    expect(await symmetricDecrypt({ key: newAuth, data: account!.refreshToken! })).toBe(
      'ghr_refresh',
    );

    // Idempotent: a second run finds everything current.
    expect(await rotateMasterKey({ db: t.db, config: rotating })).toEqual({
      resealed: 0,
      current: 7,
      failed: [],
    });
  });

  it('resumes where an interrupted run stopped', async () => {
    await clear();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await connector(`{"n":${i}}`)).id);

    let batches = 0;
    await expect(
      rotateMasterKey({
        db: t.db,
        config: rotating,
        batchSize: 2,
        onProgress: () => {
          if (++batches === 1) throw new Error('killed');
        },
      }),
    ).rejects.toThrow('killed');
    const ring = keyringFromConfig(after);
    const kids = async () =>
      (await t.db.select().from(schema.connectors)).map((r) => decodeEnvelope(r.secrets!).kid);
    expect((await kids()).filter((kid) => kid === ring.current.id)).toHaveLength(2);

    const report = await rotateMasterKey({ db: t.db, config: rotating, batchSize: 2 });
    expect(report).toEqual({ resealed: 3, current: 2, failed: [] });
    expect((await kids()).every((kid) => kid === ring.current.id)).toBe(true);
    const rows = await t.db.select().from(schema.connectors);
    expect(rows.map((r) => decryptSecretString(r.secrets!, ring)).sort()).toEqual(
      [0, 1, 2, 3, 4].map((i) => `{"n":${i}}`),
    );
  });

  it('reports leftovers no configured key opens once the previous key is gone, and keeps them', async () => {
    await clear();
    const done = await connector('{"done":true}', after);
    const left = await connector('{"left":true}');

    expect(() => decryptSecretString(left.secrets!, keyringFromConfig(after))).toThrow(
      /no configured master key opens this secret[\s\S]*was a previous key removed before `rotate-key` finished/,
    );
    const report = await rotateMasterKey({ db: t.db, config: after });
    expect(report.resealed).toBe(0);
    expect(report.current).toBe(1);
    expect(report.failed).toEqual([
      {
        column: 'connectors.secrets',
        id: left.id,
        error: expect.stringMatching(/no configured master key/),
      },
    ]);
    const [still] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, left.id));
    expect(still!.secrets!.equals(left.secrets!)).toBe(true);
    expect(done.id).not.toBe(left.id);

    // Putting the previous key back lets the next run finish.
    expect(await rotateMasterKey({ db: t.db, config: rotating })).toEqual({
      resealed: 1,
      current: 1,
      failed: [],
    });
  });
});
