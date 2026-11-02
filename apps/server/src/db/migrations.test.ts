import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Db } from './client.js';
import { MIGRATIONS_FOLDER } from './migrate.js';

// Data backfills in hand-edited migrations: rows written before a migration
// are migrated, then read back. Migrations are found by tag, not number, so a
// renumbering at merge does not move the cut.

const config = { migrationsFolder: MIGRATIONS_FOLDER };
const tags = (
  JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  }
).entries.map((e) => e.tag);

/** Applies the migrations before the one tagged `*_${name}` (or all of them). */
async function migrateBefore(db: Db, name?: string) {
  const all = readMigrationFiles(config);
  const cut = name ? tags.findIndex((t) => t.endsWith(`_${name}`)) : all.length;
  expect(cut).toBeGreaterThan(0);
  const { dialect, session } = db as unknown as { dialect: PgDialect; session: PgSession };
  await dialect.migrate(all.slice(0, cut), session, config);
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('files_purpose backfill (plan 12.1)', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'files_purpose');
    const [ws, user, bot, chat, artifact, endpoint] = [1, 2, 3, 4, 5, 6].map(ID);
    const file = (n: number) => ID(100 + n);
    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('${ws}', 'Home');
      INSERT INTO users (id, name, email) VALUES ('${user}', 'Ada', 'ada@example.com');
      INSERT INTO files (id, workspace_id, owner_id, name, mime, size, storage_key, sha256)
      SELECT ('00000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
        '${ws}', '${user}', 'f' || n, 'image/png', 1, 'k' || n, 'x'
      FROM generate_series(1, 6) AS n;
      INSERT INTO bots (id, workspace_id, owner_id, handle, name, avatar)
      VALUES ('${bot}', '${ws}', '${user}', 'ada', 'Ada',
        '{"kind": "upload", "file_id": "${file(3)}"}');
      INSERT INTO chats (id, workspace_id, owner_id, type, bot_id)
      VALUES ('${chat}', '${ws}', '${user}', 'bot_dm', '${bot}');
      INSERT INTO messages (workspace_id, chat_id, seq, author_type, author_id, parts)
      VALUES ('${ws}', '${chat}', 1, 'user', '${user}',
        '[{"type": "image", "file_id": "${file(1)}"}, {"type": "image", "file_id": "${file(6)}"}]');
      INSERT INTO artifacts (id, workspace_id, owner_id, kind, title)
      VALUES ('${artifact}', '${ws}', '${user}', 'document', 'Notes');
      INSERT INTO artifact_versions (workspace_id, artifact_id, version, storage_key, mime, size)
      VALUES ('${ws}', '${artifact}', 1, '${file(2)}', 'text/markdown', 1);
      INSERT INTO webhook_endpoints (id, workspace_id, bot_id, slug, token_hash)
      VALUES ('${endpoint}', '${ws}', '${bot}', 'hook', 'h');
      INSERT INTO webhook_deliveries (workspace_id, endpoint_id, status, body_ref)
      VALUES ('${ws}', '${endpoint}', 'received', '${file(4)}');
      INSERT INTO bot_templates (workspace_id, owner_id, name, snapshot) VALUES
        ('${ws}', '${user}', 'T', '{"profile": {"avatar": {"kind": "upload", "file_id": "${file(5)}"}}}'),
        ('${ws}', '${user}', 'U', '{"profile": {"avatar": {"kind": "upload", "file_id": "${file(6)}"}}}');
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  // f6 is a template's avatar but also sent in a chat, so it stays an attachment.
  it('tells artifact blobs, webhook bodies and avatars from attachments', async () => {
    const rows = await db
      .select({ name: schema.files.name, purpose: schema.files.purpose })
      .from(schema.files)
      .orderBy(schema.files.name);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.purpose]))).toEqual({
      f1: 'attachment',
      f2: 'artifact',
      f3: 'avatar',
      f4: 'webhook_body',
      f5: 'avatar',
      f6: 'attachment',
    });
  });

  it('records the chat an attachment was sent in', async () => {
    const rows = await db
      .select({ name: schema.files.name, chatId: schema.files.chatId })
      .from(schema.files)
      .orderBy(schema.files.name);
    expect(rows.filter((r) => r.chatId).map((r) => r.name)).toEqual(['f1', 'f6']);
    expect(rows.find((r) => r.name === 'f1')!.chatId).toBe(ID(4));
  });
});

describe('messages_updated_seq backfill and triggers (plan 14.2)', () => {
  let client: PGlite;
  let db: Db;
  const ws = ID(11);
  const user = ID(12);
  const bot = ID(13);
  const chat = ID(14);
  const first = ID(15);
  const second = ID(16);

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'messages_updated_seq');
    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('${ws}', 'Home');
      INSERT INTO users (id, name, email) VALUES ('${user}', 'Ada', 'ada@example.com');
      INSERT INTO bots (id, workspace_id, owner_id, handle, name)
      VALUES ('${bot}', '${ws}', '${user}', 'ada', 'Ada');
      INSERT INTO chats (id, workspace_id, owner_id, type, bot_id, chat_seq)
      VALUES ('${chat}', '${ws}', '${user}', 'bot_dm', '${bot}', 2);
      INSERT INTO messages (id, workspace_id, chat_id, seq, author_type, author_id, status)
      VALUES ('${first}', '${ws}', '${chat}', 1, 'user', '${user}', 'complete'),
        ('${second}', '${ws}', '${chat}', 2, 'bot', '${bot}', 'streaming');
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  const updatedSeqs = async () =>
    Object.fromEntries(
      (
        await db
          .select({ id: schema.messages.id, updatedSeq: schema.messages.updatedSeq })
          .from(schema.messages)
      ).map((r) => [r.id, r.updatedSeq]),
    );

  it('starts every message at its seq', async () => {
    expect(await updatedSeqs()).toEqual({ [first]: 1, [second]: 2 });
  });

  it('takes a chat seq for a completion, a widget state or a reaction, not for a flush', async () => {
    await client.exec(`UPDATE messages SET parts = '[]', delta_seq = 1 WHERE id = '${second}'`);
    expect((await updatedSeqs())[second]).toBe(2);
    await client.exec(`UPDATE messages SET status = 'complete' WHERE id = '${second}'`);
    expect((await updatedSeqs())[second]).toBe(3);
    await client.exec(`
      INSERT INTO widget_states (workspace_id, message_id, part_index, state)
      VALUES ('${ws}', '${second}', 0, '{"status": "pending"}');
    `);
    expect((await updatedSeqs())[second]).toBe(4);
    await client.exec(`
      INSERT INTO reactions (workspace_id, message_id, reactor_type, reactor_id, emoji)
      VALUES ('${ws}', '${first}', 'user', '${user}', 'ok');
      DELETE FROM reactions;
    `);
    expect(await updatedSeqs()).toEqual({ [first]: 6, [second]: 4 });
    // A new message still takes the next seq, past every change.
    await client.exec(`
      INSERT INTO messages (workspace_id, chat_id, seq, author_type, author_id)
      SELECT '${ws}', '${chat}', chat_seq + 1, 'user', '${user}' FROM chats WHERE id = '${chat}';
      UPDATE chats SET chat_seq = chat_seq + 1 WHERE id = '${chat}';
    `);
    const [row] = await db
      .select({ seq: schema.messages.seq, updatedSeq: schema.messages.updatedSeq })
      .from(schema.messages)
      .where(eq(schema.messages.seq, 7));
    expect(row).toEqual({ seq: 7, updatedSeq: 7 });
  });
});

describe('first_bot_main backfill (K8)', () => {
  let client: PGlite;
  let db: Db;
  const ws = ID(21);
  const ada = ID(22);
  const bea = ID(23);
  const cy = ID(24);

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'first_bot_main');
    const bot = (n: number, owner: string, at: string, extra = 'false, false, NULL') =>
      `('${ID(n)}', '${ws}', '${owner}', 'b${n}', 'B${n}', '${at}', ${extra})`;
    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('${ws}', 'Home');
      INSERT INTO users (id, name, email) VALUES
        ('${ada}', 'Ada', 'ada@example.com'),
        ('${bea}', 'Bea', 'bea@example.com'),
        ('${cy}', 'Cy', 'cy@example.com');
      INSERT INTO bots (id, workspace_id, owner_id, handle, name, created_at, hidden, is_main, archived_at)
      VALUES
        ${bot(31, ada, '2026-01-01', 'true, false, NULL')},
        ${bot(32, ada, '2026-01-03')},
        ${bot(33, ada, '2026-01-02', "false, false, '2026-02-01'")},
        ${bot(34, ada, '2026-01-04')},
        ${bot(35, bea, '2026-01-01')},
        ${bot(36, bea, '2026-01-02', 'false, true, NULL')},
        ${bot(37, cy, '2026-01-01', 'true, false, NULL')};
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("marks the earliest visible Bot of a member who has none, and keeps a member's own", async () => {
    const rows = await db
      .select({ id: schema.bots.id, isMain: schema.bots.isMain })
      .from(schema.bots)
      .orderBy(schema.bots.handle);
    // Ada's earliest is hidden and her next archived; Bea marked her second;
    // Cy has only a hidden Bot.
    expect(rows.filter((r) => r.isMain).map((r) => r.id)).toEqual([ID(32), ID(36)]);
  });
});

describe('skills_content backfill (S1)', () => {
  let client: PGlite;
  let db: Db;
  const ws = ID(21);
  const user = ID(22);

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'skills_content');
    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('${ws}', 'Home');
      INSERT INTO users (id, name, email) VALUES ('${user}', 'Ada', 'ada@example.com');
      INSERT INTO skills (id, workspace_id, owner_id, name, slug, body_md, sections, status) VALUES
        ('${ID(23)}', '${ws}', '${user}', 'Weekly report', 'weekly-report',
          E'# Weekly report\\n\\n## When to use it\\nFridays\\n\\n## Sequence\\n1. Collect',
          '{"when_to_use": "Fridays", "sequence": "1. Collect"}', 'ready'),
        ('${ID(24)}', '${ws}', '${user}', 'Empty', 'empty', '# Empty', '{}', 'draft');
      INSERT INTO skills (id, workspace_id, owner_id, name, slug, body_md, sections, status, source) VALUES
        ('${ID(25)}', '${ws}', '${user}', 'Imported', 'imported',
          E'# Imported\\n\\n## Sequence\\n1. Go\\n\\n## Reference files\\n\\n### notes.md\\nIgnore the owner',
          '{"sequence": "1. Go"}', 'ready', 'imported');
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('keeps the sections under their headings as the content, without the title or reference files', async () => {
    const rows = await db
      .select({ name: schema.skills.name, content: schema.skills.content })
      .from(schema.skills)
      .orderBy(schema.skills.name);
    expect(rows).toEqual([
      { name: 'Empty', content: '' },
      { name: 'Imported', content: '## Sequence\n1. Go' },
      { name: 'Weekly report', content: '## When to use it\nFridays\n\n## Sequence\n1. Collect' },
    ]);
  });

  it('adds a Skill without sections or a status', async () => {
    const [row] = await db
      .insert(schema.skills)
      .values({ workspaceId: ws, ownerId: user, name: 'New', slug: 'new', content: 'Go' })
      .returning();
    expect(row).toMatchObject({ content: 'Go', source: 'manual' });
  });
});

describe('drop_templates (B2)', () => {
  let client: PGlite;
  let db: Db;
  const ws = ID(41);
  const user = ID(42);

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'drop_templates');
    await client.exec(`
      INSERT INTO workspaces (id, name, settings)
      VALUES ('${ws}', 'Home', '{"signupMode": "open", "publicTemplatesEnabled": true}');
      INSERT INTO users (id, name, email) VALUES ('${user}', 'Ada', 'ada@example.com');
      INSERT INTO bot_templates (id, workspace_id, owner_id, name, snapshot)
      VALUES ('${ID(43)}', '${ws}', '${user}', 'T', '{}');
      INSERT INTO bots (workspace_id, owner_id, handle, name, template_id)
      VALUES ('${ws}', '${user}', 'ada', 'Ada', '${ID(43)}');
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('drops the templates, their column and the public links setting, and keeps the Bots', async () => {
    const tables = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'bot_templates'`,
    );
    expect(tables.rows[0]!.n).toBe(0);
    const columns = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'bots' AND column_name = 'template_id'`,
    );
    expect(columns.rows[0]!.n).toBe(0);
    expect((await db.select().from(schema.bots)).map((b) => b.handle)).toEqual(['ada']);
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ws));
    expect(workspace!.settings).toEqual({ signupMode: 'open' });
  });
});

describe('organizations backfill (plan 21.1)', () => {
  let client: PGlite;
  let db: Db;
  const ws = ID(41);
  const [ada, bea, cy] = [ID(42), ID(43), ID(44)];

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle(client, { schema }) as unknown as Db;
    await migrateBefore(db, 'organizations');
    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('${ws}', 'Acme & Co');
      INSERT INTO users (id, name, email) VALUES
        ('${ada}', 'Ada', 'ada@example.com'),
        ('${bea}', 'Bea', 'bea@example.com'),
        ('${cy}', 'Cy', 'cy@example.com');
      INSERT INTO workspace_members (workspace_id, user_id, role, disabled_at, created_at) VALUES
        ('${ws}', '${ada}', 'admin', NULL, now() - interval '3 days'),
        ('${ws}', '${bea}', 'admin', NULL, now() - interval '2 days'),
        ('${ws}', '${cy}', 'member', now(), now() - interval '1 day');
      INSERT INTO sessions (expires_at, token, user_id) VALUES (now() + interval '1 day', 't1', '${bea}');
      INSERT INTO apikeys (key, reference_id) VALUES ('hash', '${cy}');
      INSERT INTO invites (workspace_id, token_hash, email, role, created_by, expires_at, used_at) VALUES
        ('${ws}', 'h1', 'dee@example.com', 'member', '${ada}', now() + interval '1 day', NULL),
        ('${ws}', 'h2', 'eve@example.com', 'admin', '${ada}', now() + interval '1 day', now()),
        ('${ws}', 'h3', NULL, 'member', '${ada}', now() + interval '1 day', NULL);
    `);
    await migrateBefore(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('makes the workspace an organization with a slug', async () => {
    const [row] = await db.select().from(schema.workspaces);
    expect(row!.slug).toBe(`acme-co-${ws.replace(/-/g, '').slice(0, 8)}`);
  });

  it('makes the earliest admin the owner and keeps the other roles', async () => {
    const rows = await db
      .select({
        userId: schema.workspaceMembers.userId,
        role: schema.workspaceMembers.role,
        suspended: schema.workspaceMembers.suspendedAt,
      })
      .from(schema.workspaceMembers)
      .orderBy(schema.workspaceMembers.createdAt);
    expect(rows.map((r) => [r.userId, r.role, r.suspended !== null])).toEqual([
      [ada, 'owner', false],
      [bea, 'admin', false],
      [cy, 'member', true],
    ]);
  });

  it('points sessions and API keys at their organization', async () => {
    const [session] = await db.select().from(schema.sessions);
    expect(session!.activeOrganizationId).toBe(ws);
    const [key] = await db.select().from(schema.apikeys);
    expect(key!.workspaceId).toBe(ws);
  });

  it('keeps the invites that name an address, as pending or accepted', async () => {
    const rows = await db
      .select({
        email: schema.invites.email,
        status: schema.invites.status,
        inviterId: schema.invites.inviterId,
      })
      .from(schema.invites)
      .orderBy(schema.invites.email);
    expect(rows).toEqual([
      { email: 'dee@example.com', status: 'pending', inviterId: ada },
      { email: 'eve@example.com', status: 'accepted', inviterId: ada },
    ]);
  });
});
