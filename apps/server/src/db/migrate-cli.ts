// `pnpm --filter @openbots/server db:migrate`: applies migrations to DATABASE_URL
// (or the file in DATABASE_URL_FILE).
import { secretFromEnv } from '../env-files.js';
import { prepareAppRole } from './app-role.js';
import { createDb } from './client.js';
import { migrate } from './migrate.js';

const url = secretFromEnv('DATABASE_URL');
if (!url) {
  console.error('db:migrate: DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb(url);
try {
  await migrate(db);
  // openbots_app logs in with OPENBOTS_DB_APP_PASSWORD, when set (app-role.ts).
  await prepareAppRole(db, secretFromEnv('OPENBOTS_DB_APP_PASSWORD'));
  console.log('db:migrate: up to date');
} finally {
  await db.close();
}
