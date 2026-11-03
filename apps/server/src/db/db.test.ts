import { readdirSync } from 'node:fs';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSeq, schema } from './client.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';
import { createTestDb, type TestDb } from './test-db.js';

const SECTION_4_TABLES = [
  'bots',
  'bot_state',
  'chats',
  'chat_members',
  'messages',
  'message_deletions',
  'reactions',
  'widget_states',
  'runs',
  'run_steps',
  'approvals',
  'connectors',
  'connector_tools',
  'bot_connectors',
  'connector_policy',
  'computers',
  'bot_screens',
  'skills',
  'bot_skills',
  'routines',
  'routine_runs',
  'webhook_endpoints',
  'webhook_deliveries',
  'event_subscriptions',
  'event_deliveries',
  'artifacts',
  'artifact_versions',
  'bot_memories',
  'files',
  'audit_log',
  'providers',
  'provider_models',
  'devices',
  'device_pairings',
];

const AUTH_TABLES = ['users', 'sessions', 'accounts', 'verifications', 'apikeys'];
const WORKSPACE_TABLES = ['workspaces', 'workspace_members', 'invites'];
/** The install's own, no organization's (the relay identity, MOBILE_AND_VM_PLAN.md 4.1). */
const INSTALL_TABLES = ['instance_keys'];

// postgres.js returns rows as an array; PGlite wraps them in `{ rows }`.
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

const schemaTables = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => is(value, PgTable),
);

describe('schema', () => {
  it('declares every plan section 4 table', () => {
    const names = schemaTables.map((table) => getTableName(table)).sort();
    expect(names).toEqual(
      [...SECTION_4_TABLES, ...AUTH_TABLES, ...WORKSPACE_TABLES, ...INSTALL_TABLES].sort(),
    );
  });

  it('puts workspace_id on every section 4 table', () => {
    for (const table of schemaTables) {
      const name = getTableName(table);
      if (AUTH_TABLES.includes(name) || INSTALL_TABLES.includes(name) || name === 'workspaces')
        continue;
      expect(table, getTableName(table)).toHaveProperty('workspaceId');
    }
  });

  it('starts from the frozen first migration, then numbered ones', () => {
    const sqlFiles = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles[0]).toBe('0000_init.sql');
    sqlFiles.forEach((f, i) => expect(f).toMatch(new RegExp(`^${String(i).padStart(4, '0')}_`)));
  });
});

describe('database', () => {
  let t: TestDb;
  let workspaceId: string;
  let ownerId: string;

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
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  async function createBot(handle: string) {
    const [bot] = await t.db
      .insert(schema.bots)
      .values({ workspaceId, ownerId, handle, name: handle })
      .returning();
    return bot!;
  }

  async function createDm(botId: string) {
    const [chat] = await t.db
      .insert(schema.chats)
      .values({ workspaceId, ownerId, type: 'bot_dm', botId })
      .returning();
    return chat!;
  }

  async function postMessage(chatId: string, text: string) {
    return t.db.transaction(async (tx) => {
      const seq = await nextSeq(tx, chatId);
      const [message] = await tx
        .insert(schema.messages)
        .values({
          workspaceId,
          chatId,
          seq,
          authorType: 'user',
          authorId: ownerId,
          parts: [{ type: 'text', text }],
        })
        .returning();
      return message!;
    });
  }

  it('creates every table and the vector extension', async () => {
    const tables = await t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rowsOf<{ table_name: string }>(tables).map((r) => r.table_name);
    for (const name of [...SECTION_4_TABLES, ...AUTH_TABLES, ...WORKSPACE_TABLES]) {
      expect(names).toContain(name);
    }
    const ext = await t.db.execute(sql`select 1 from pg_extension where extname = 'vector'`);
    expect(rowsOf(ext)).toHaveLength(1);
  });

  it('is a no-op to migrate again', async () => {
    await expect(migrate(t.db)).resolves.toBeUndefined();
  });

  it('assigns message seq per chat', async () => {
    const bot = await createBot('scribe');
    const chat = await createDm(bot.id);
    const first = await postMessage(chat.id, 'hello');
    const second = await postMessage(chat.id, 'again');
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const other = await createDm((await createBot('other')).id);
    expect((await postMessage(other.id, 'hi')).seq).toBe(1);

    const [row] = await t.db.select().from(schema.chats).where(eq(schema.chats.id, chat.id));
    expect(row!.chatSeq).toBe(2);
  });

  it('rejects a duplicate seq in one chat', async () => {
    const chat = await createDm((await createBot('dupes')).id);
    await postMessage(chat.id, 'one');
    await expect(
      t.db
        .insert(schema.messages)
        .values({ workspaceId, chatId: chat.id, seq: 1, authorType: 'system' }),
    ).rejects.toThrow();
  });

  it('fails nextSeq for an unknown chat', async () => {
    await expect(nextSeq(t.db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /not found/,
    );
  });

  it('keeps bot handles unique per workspace', async () => {
    await createBot('unique-handle');
    await expect(createBot('unique-handle')).rejects.toThrow();
  });

  it('allows one transcript per (owner, bot)', async () => {
    const bot = await createBot('solo');
    await createDm(bot.id);
    await expect(createDm(bot.id)).rejects.toThrow();
  });

  it('allows one bot_to_bot chat per unordered pair', async () => {
    const [a, b] = [await createBot('pair-a'), await createBot('pair-b')].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    );
    const pair = (botId: string, peerBotId: string) =>
      t.db
        .insert(schema.chats)
        .values({ workspaceId, ownerId, type: 'bot_to_bot', botId, peerBotId });
    await pair(a!.id, b!.id);
    await expect(pair(a!.id, b!.id)).rejects.toThrow();
    // The reversed order is refused by the check constraint.
    await expect(pair(b!.id, a!.id)).rejects.toThrow();
  });

  it('stores memory embeddings', async () => {
    const bot = await createBot('memo');
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
    const [memory] = await t.db
      .insert(schema.botMemories)
      .values({ workspaceId, botId: bot.id, kind: 'fact', content: 'likes tea', embedding })
      .returning();
    expect(memory!.embedding).toHaveLength(1536);
    expect(memory!.embedding![1]).toBeCloseTo(1 / 7, 5);
  });

  it('round-trips bytea secret columns', async () => {
    const secret = Buffer.from([0, 1, 2, 254, 255]);
    const [connector] = await t.db
      .insert(schema.connectors)
      .values({
        workspaceId,
        ownerId,
        name: 'GitHub',
        slug: 'github',
        kind: 'builtin',
        status: 'ok',
        secrets: secret,
      })
      .returning();
    expect(Buffer.isBuffer(connector!.secrets)).toBe(true);
    expect(connector!.secrets!.equals(secret)).toBe(true);
  });

  it('allows one computer per owner', async () => {
    const computer = { workspaceId, ownerId, status: 'stopped' };
    await t.db.insert(schema.computers).values(computer);
    await expect(t.db.insert(schema.computers).values(computer)).rejects.toThrow();
  });
});

describe('test databases', () => {
  let a: TestDb;
  let b: TestDb;

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestDb(), createTestDb()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
  });

  it('each start migrated and empty, and do not share rows', async () => {
    await a.db.insert(schema.workspaces).values({ name: 'Only in a', slug: 'only-in-a' });
    expect(await a.db.select().from(schema.workspaces)).toHaveLength(1);
    expect(await b.db.select().from(schema.workspaces)).toEqual([]);
    await expect(migrate(b.db)).resolves.toBeUndefined();
  });
});
