import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import postgres from 'postgres';
import { createDb, schema, type Db } from './client.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';

export interface TestDb {
  db: Db;
  /** Which backend the tests ran against. */
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/**
 * A freshly migrated, empty database for tests: in-memory PGlite with
 * pgvector by default, or a throwaway database on the server in DATABASE_URL
 * when it is set (dropped again on close, or at the end of the test file
 * under vitest). Either way each test database is a copy of one migrated
 * template, so test files running in parallel do not each replay every
 * migration, and a test that builds a second app does not pay for initdb.
 *
 * To run the server tests on real Postgres, as CI's `server-postgres` job
 * does, set DATABASE_URL to a server with pgvector whose user may create
 * databases (docs/CONTRIBUTING.md). PGlite runs one query at a time, in
 * order; a real server runs a pool's queries side by side, so a test that
 * checks one write right after waiting for another can race there.
 */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const client = new PGlite({ extensions: { vector }, loadDataDir: await pgliteTemplate() });
    const db = drizzle(client, { schema });
    return { db, kind: 'pglite', close: () => client.close() };
  }

  const template = await migratedTemplate(url);
  const name = `openbots_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const db = createDb(databaseUrl(url, name));
  return {
    db,
    kind: 'postgres',
    close: async () => {
      await db.close();
      const drop = admin.unsafe(`DROP DATABASE ${name}`).finally(() => admin.end());
      if (deferred) {
        drop.catch(() => {}); // awaited, and reported, by dropClosedTestDbs
        deferred.push(drop);
      } else {
        await drop;
      }
    },
  };
}

/** Drops of closed test databases waiting for the end of the test file. */
let deferred: Promise<unknown>[] | null = null;

/**
 * DROP DATABASE forces a checkpoint, which takes seconds while the suite is
 * writing, so under vitest a closed test database is dropped when its test
 * file ends rather than inside the test that closed it. test-setup.ts turns
 * this on and awaits `dropClosedTestDbs` after each file.
 */
export function deferTestDbDrops() {
  deferred ??= [];
}

export async function dropClosedTestDbs() {
  const drops = deferred ?? [];
  deferred &&= [];
  await Promise.all(drops);
}

let pglite: Promise<Blob> | undefined;

/**
 * A migrated, empty PGlite data directory, built once per test file (vitest
 * gives each file its own modules). Starting PGlite from it skips initdb and
 * the migrations, which take seconds on a loaded machine: long enough to time
 * out a test that builds its own app.
 */
function pgliteTemplate(): Promise<Blob> {
  pglite ??= (async () => {
    const client = new PGlite({ extensions: { vector } });
    try {
      await migrate(drizzle(client, { schema }));
      return await client.dumpDataDir('none');
    } finally {
      await client.close();
    }
  })().catch((error: unknown) => {
    pglite = undefined;
    throw error;
  });
  return pglite;
}

let template: Promise<string> | undefined;

/**
 * The template database for this set of migrations, built once on the server
 * and reused by every test process (and later runs) until a migration changes.
 */
function migratedTemplate(url: string): Promise<string> {
  template ??= buildTemplate(url).catch((error: unknown) => {
    template = undefined;
    throw error;
  });
  return template;
}

async function buildTemplate(url: string): Promise<string> {
  const hashes = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map((m) => m.hash);
  const digest = createHash('sha256').update(hashes.join(',')).digest('hex').slice(0, 16);
  const name = `openbots_test_template_${digest}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // One process builds it while the others wait on the lock.
    await admin`SELECT pg_advisory_lock(hashtext(${name}))`;
    const [row] = await admin<{ datistemplate: boolean }[]>`
      SELECT datistemplate FROM pg_database WHERE datname = ${name}`;
    if (row?.datistemplate) return name;
    // Left half built by an interrupted run.
    if (row) await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const db = createDb(databaseUrl(url, name));
    try {
      await migrate(db);
    } finally {
      await db.close();
    }
    await admin.unsafe(`ALTER DATABASE ${name} IS_TEMPLATE true`);
    return name;
  } finally {
    await admin.end();
  }
}

function databaseUrl(url: string, name: string) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
