import { sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createDb, type Db } from './client.js';
import { APP_ROLE, scopedDb } from './scope.js';

// The connection the app works through (db/scope.ts). Migrations run as
// DATABASE_URL's user, the tables' owner. With OPENBOTS_DB_APP_PASSWORD the
// app then connects as openbots_app, a role that owns nothing and does not
// bypass row-level security, so a statement that escaped the scope still
// could not read past it. Without it, the app connects as DATABASE_URL's
// user and switches to openbots_app in each transaction (SET LOCAL ROLE),
// which row-level security holds to the same policies.

const PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

/** Lets openbots_app log in with `password` (run as the owner, after migrations). */
export async function prepareAppRole(owner: Db, password: string | undefined): Promise<void> {
  if (!password) return;
  // Checked again here since it goes into the statement: ALTER ROLE takes no parameters.
  if (!PASSWORD.test(password))
    throw new Error('OPENBOTS_DB_APP_PASSWORD has characters it may not');
  await owner.execute(sql.raw(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password}'`));
}

/** DATABASE_URL with openbots_app and its password in place of the owner's. */
export function appDatabaseUrl(url: string, password: string): string {
  const u = new URL(url);
  u.username = APP_ROLE;
  u.password = password;
  return u.toString();
}

/**
 * The app's database, after migrations on `owner`: as openbots_app when
 * OPENBOTS_DB_APP_PASSWORD is set (then `owner` is closed), else over
 * `owner`'s connections.
 */
export async function openAppDb(
  owner: Db & { close(): Promise<void> },
  config: Pick<Config, 'databaseUrl' | 'dbAppPassword'>,
  logger: Pick<Logger, 'warn'>,
): Promise<Db & { close(): Promise<void> }> {
  if (!config.dbAppPassword) {
    logger.warn(
      'OPENBOTS_DB_APP_PASSWORD is unset: the app connects as the database owner and switches to openbots_app in each transaction; set it to connect as openbots_app',
    );
    return scopedDb(owner);
  }
  await prepareAppRole(owner, config.dbAppPassword);
  await owner.close();
  return scopedDb(createDb(appDatabaseUrl(config.databaseUrl, config.dbAppPassword)));
}
