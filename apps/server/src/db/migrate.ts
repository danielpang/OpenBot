import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';

/** `apps/server/drizzle`, from both `src/db` and `dist/db`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies pending migrations. The server runs this on start (plan 16.3).
 *
 * Drizzle ships one migrator per driver, and each is the same two lines over
 * the database's dialect and session; calling those directly lets one function
 * serve postgres.js and PGlite.
 */
export async function migrate(db: Db): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  const { dialect, session } = db as unknown as { dialect: PgDialect; session: PgSession };
  await dialect.migrate(readMigrationFiles(config), session, config);
}
