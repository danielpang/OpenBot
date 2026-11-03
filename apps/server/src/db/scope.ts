import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { PgDatabase, PgSession, type PgTransaction } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';

// Row-level security, the second layer between organizations (plan 21.9;
// docs/SECURITY.md lists every path below in one place).
//
// Postgres keeps each organization's rows to itself (drizzle/0023): every
// table with workspace_id answers only for the organization in
// `app.workspace_id`, and nothing when it is unset. This module sets it.
// The app's database (`scopedDb`) runs every query, and every transaction,
// as a transaction that starts with
//
//   SELECT set_config('role', 'openbots_app', true),
//          set_config('app.workspace_id', <organization>, true)
//
// for the organization of the work in hand: the scope set with
// `inWorkspace` around a request (middleware/auth.ts), a job, a socket or a
// webhook delivery. Both settings end with the transaction, so a pooled
// connection carries nothing to the next one. Work with no scope sees no
// organization's rows.
//
// The few paths that are not one organization's work each use a narrow
// mechanism, never a blanket bypass:
// - `asDirectory`: better-auth and the organization directory (which
//   organizations an account is in, an invitation by its id, an API key)
//   work as openbots_auth, which reaches the account tables, workspaces,
//   memberships, invitations and API keys of every organization, and no
//   other table.
// - `forEachWorkspace`: work for every organization (startup upkeep,
//   sweeps, retention) runs in each one's scope in turn, from the ids that
//   openbots_workspace_ids(), a SECURITY DEFINER function, returns.
// - `webhookWorkspaces`: which organization a webhook path belongs to,
//   through openbots_webhook_workspaces(); the delivery then works in it.
// - `dueRoutineWorkspaces`: which organizations have a Routine due, through
//   openbots_due_routine_workspaces(); the scheduler ticks in each.
// - `connectorWorkspace`: which organization a connector's OAuth callback
//   belongs to, through openbots_connector_workspace(); the state is then
//   checked there.
// - `deviceWorkspace` and `pairingWorkspace`: which organization a device's
//   Noise static key, or a pairing code's hash, belongs to, through
//   openbots_device_workspace() and openbots_pairing_workspace(); the device
//   or the code is then read there. `devicesExist` says only whether any
//   organization has a device or an open pairing (openbots_devices_exist()).
// - Jobs carry the organization that queued them and run in it
//   (infra/index.ts); realtime events carry it too, and the gateway and the
//   outbound fan-out work in it.
// - Migrations run as the database owner (DATABASE_URL), before the app.

export const APP_ROLE = 'openbots_app';
export const DIRECTORY_ROLE = 'openbots_auth';

export type DbScope = { workspaceId: string } | { directory: true };

const scopes = new AsyncLocalStorage<DbScope>();

/**
 * Runs `fn` with its database work in one organization. A query builder is
 * lazy, so `fn`'s result is awaited inside the scope too.
 */
export function inWorkspace<T>(workspaceId: string, fn: () => T | PromiseLike<T>): Promise<T> {
  return scopes.run({ workspaceId }, async () => await fn());
}

/** Runs `fn` as the organization directory (see above): better-auth's tables, every organization. */
export function asDirectory<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return scopes.run({ directory: true }, async () => await fn());
}

/** Runs `fn` in no scope: for long-lived machinery (timers, sockets) that serves every organization. */
export function outsideScope<T>(fn: () => T): T {
  return scopes.exit(fn);
}

/** The scope of the work in hand, if any. */
export function currentScope(): DbScope | undefined {
  return scopes.getStore();
}

/** The organization of the work in hand, if it is one organization's. */
export function currentWorkspace(): string | undefined {
  const scope = scopes.getStore();
  return scope && 'workspaceId' in scope ? scope.workspaceId : undefined;
}

function setup(scope: DbScope | undefined) {
  const role = scope && 'directory' in scope ? DIRECTORY_ROLE : APP_ROLE;
  const workspaceId = scope && 'workspaceId' in scope ? scope.workspaceId : '';
  return sql`select set_config('role', ${role}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
}

type AnySession = PgSession & {
  prepareQuery(...args: unknown[]): {
    execute(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown;
  };
  transaction(
    fn: (tx: PgTransaction<never, never, never>) => unknown,
    config?: unknown,
  ): Promise<unknown>;
};

/**
 * A session whose every query and transaction is a transaction in the scope
 * of the work in hand (or `fixed`). Inside a transaction the queries go to
 * the driver's own transaction, already in scope.
 */
class ScopedSession extends PgSession {
  constructor(
    private readonly base: AnySession,
    dialect: PgSession['dialect'],
    private readonly fixed: DbScope | undefined,
  ) {
    super(dialect);
  }

  private inScope<T>(fn: (tx: PgTransaction<never, never, never>) => Promise<T>, config?: unknown) {
    const scope = this.fixed ?? scopes.getStore();
    return this.base.transaction(async (tx) => {
      await tx.execute(setup(scope));
      return fn(tx);
    }, config) as Promise<T>;
  }

  override prepareQuery(...args: unknown[]) {
    const prepared = this.base.prepareQuery(...args);
    // Drizzle sets fields on the prepared query after this returns (such as
    // `joinsNotNullableMap` for left joins); the one made in the transaction
    // gets them too.
    const wrapper: Record<string, unknown> = Object.create(prepared) as Record<string, unknown>;
    const run = (method: 'execute' | 'all', rest: unknown[]) =>
      this.inScope((tx) => {
        const session = (tx as unknown as { session: AnySession }).session;
        const inner = session.prepareQuery(...args) as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(wrapper)) {
          if (key !== 'execute' && key !== 'all') inner[key] = value;
        }
        const call = inner[method] as (...a: unknown[]) => unknown;
        return Promise.resolve(call.apply(inner, rest));
      });
    wrapper.execute = (...rest: unknown[]) => run('execute', rest);
    wrapper.all = (...rest: unknown[]) => run('all', rest);
    return wrapper as never;
  }

  override transaction<T>(
    fn: (tx: PgTransaction<never, never, never>) => Promise<T>,
    config?: unknown,
  ): Promise<T> {
    return this.inScope(fn, config);
  }
}

/**
 * The app's database over `base` (the driver's): every query in the scope of
 * the work in hand, or always in `fixed`. `close` closes `base`'s client.
 */
const bases = new WeakMap<object, Db>();

export function scopedDb<D extends Db>(base: D, fixed?: DbScope): D {
  const internals = base as unknown as {
    dialect: PgSession['dialect'];
    session: AnySession;
    _: { schema: unknown; fullSchema: unknown; tableNamesMap: unknown };
    close?: () => Promise<void>;
  };
  const session = new ScopedSession(internals.session, internals.dialect, fixed);
  const db = new PgDatabase(
    internals.dialect,
    session as never,
    {
      schema: internals._.schema,
      fullSchema: internals._.fullSchema,
      tableNamesMap: internals._.tableNamesMap,
    } as never,
  );
  const scoped = Object.assign(db, internals.close ? { close: internals.close } : {});
  bases.set(scoped, base);
  return scoped as unknown as D;
}

/** The app's database `db` always in `scope` (better-auth's is the directory's). */
export function withScope<D extends Db>(db: D, scope: DbScope): D {
  const base = bases.get(db);
  return base ? scopedDb(base as D, scope) : db;
}

/** Every organization's id (openbots_workspace_ids(), a SECURITY DEFINER function). */
export async function workspaceIds(db: Db): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`select openbots_workspace_ids() as id`);
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/** Runs `fn` once in each organization's scope, one after another; returns the results. */
export async function forEachWorkspace<T>(
  db: Db,
  fn: (workspaceId: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const id of await workspaceIds(db)) results.push(await inWorkspace(id, () => fn(id)));
  return results;
}

/**
 * The organizations of the webhook endpoints a path names (the Bot by id or
 * handle, and the slug): at most two, so an ambiguous handle is refused.
 */
export async function webhookWorkspaces(
  db: Db,
  bot: string,
  slug: string,
  byId: boolean,
): Promise<string[]> {
  const result = await db.execute<{ id: string }>(
    sql`select openbots_webhook_workspaces(${bot}, ${slug}, ${byId}) as id`,
  );
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/** The organizations with a Routine due at `now` (openbots_due_routine_workspaces()). */
export async function dueRoutineWorkspaces(db: Db, now = new Date()): Promise<string[]> {
  const result = await db.execute<{ id: string }>(
    sql`select openbots_due_routine_workspaces(${now.toISOString()}::timestamptz) as id`,
  );
  return rowsOf<{ id: string }>(result).map((r) => r.id);
}

/** The organization of a connector, by id (openbots_connector_workspace()): for its OAuth callback. */
export async function connectorWorkspace(db: Db, connectorId: string): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(
    sql`select openbots_connector_workspace(${connectorId}::uuid) as id`,
  );
  return rowsOf<{ id: string | null }>(result)[0]?.id ?? null;
}

/** The organization of an unrevoked device by its static key (openbots_device_workspace()). */
export async function deviceWorkspace(db: Db, publicKey: Uint8Array): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(
    sql`select openbots_device_workspace(${Buffer.from(publicKey)}) as id`,
  );
  return rowsOf<{ id: string | null }>(result)[0]?.id ?? null;
}

/** The organization of a pairing by its code's SHA-256 (openbots_pairing_workspace()). */
export async function pairingWorkspace(db: Db, codeHash: Uint8Array): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(
    sql`select openbots_pairing_workspace(${Buffer.from(codeHash)}) as id`,
  );
  return rowsOf<{ id: string | null }>(result)[0]?.id ?? null;
}

/** Whether any organization has an unrevoked device or an open pairing (openbots_devices_exist()). */
export async function devicesExist(db: Db, now = new Date()): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(
    sql`select openbots_devices_exist(${now.toISOString()}::timestamptz) as exists`,
  );
  return rowsOf<{ exists: boolean }>(result)[0]?.exists === true;
}

/** postgres.js answers an array of rows, PGlite `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows: T[] }).rows ?? []);
}
