import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { and, asc, eq, gt, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { authSecret, isEncrypted } from './auth.js';
import type { Config } from './config.js';
import { schema, type Db } from './db/client.js';
import { keyringFromConfig, resealSecret } from './secrets.js';
import { forEachWorkspace } from './db/scope.js';

// Master key rotation (plan 4.9). After OPENBOTS_MASTER_KEY is replaced and the
// old key moved to OPENBOTS_MASTER_KEY_PREVIOUS, this re-seals every stored
// secret under the new key: each sealed column below, and the sign-in
// providers' OAuth tokens, which better-auth encrypts with a secret derived
// from the master key (auth.ts). `rotate-key` (rotate-key.ts) runs it, and so
// does a worker that starts with previous keys configured.
//
// Safe to interrupt and to run again, or twice at once: rows are read in id
// order a batch at a time and each is updated alone, only if it still holds
// the value that was read, so a secret someone saved meanwhile (under the
// current key) is never overwritten. A row the current key sealed already is
// skipped. A row no configured key opens is reported and left as it is.

export interface SealedColumn {
  /** `table.column`, as it is named in the database. */
  name: string;
  table: PgTable;
  id: PgColumn;
  column: PgColumn;
  /** The column's property in the Drizzle table. */
  key: string;
  /** The table's updated_at, kept as it is: re-sealing is not an edit. */
  updatedAt?: PgColumn;
  /** The install's, not an organization's: no workspace_id, read once outside any scope. */
  install?: true;
}

/** Every column holding a sealed envelope (`bytea` in the schema; rotation.test.ts checks none is missing). */
export const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    name: 'connectors.secrets',
    table: schema.connectors,
    id: schema.connectors.id,
    column: schema.connectors.secrets,
    key: 'secrets',
    updatedAt: schema.connectors.updatedAt,
  },
  {
    name: 'providers.secrets',
    table: schema.providers,
    id: schema.providers.id,
    column: schema.providers.secrets,
    key: 'secrets',
    updatedAt: schema.providers.updatedAt,
  },
  {
    name: 'providers.header_secrets',
    table: schema.providers,
    id: schema.providers.id,
    column: schema.providers.headerSecrets,
    key: 'headerSecrets',
    updatedAt: schema.providers.updatedAt,
  },
  {
    name: 'computers.agent_token',
    table: schema.computers,
    id: schema.computers.id,
    column: schema.computers.agentToken,
    key: 'agentToken',
  },
  {
    name: 'webhook_endpoints.signature_secret',
    table: schema.webhookEndpoints,
    id: schema.webhookEndpoints.id,
    column: schema.webhookEndpoints.signatureSecret,
    key: 'signatureSecret',
  },
  {
    name: 'event_subscriptions.secret',
    table: schema.eventSubscriptions,
    id: schema.eventSubscriptions.id,
    column: schema.eventSubscriptions.secret,
    key: 'secret',
  },
  {
    name: 'devices.push_token',
    table: schema.devices,
    id: schema.devices.id,
    column: schema.devices.pushToken,
    key: 'pushToken',
  },
  {
    name: 'devices.push_key',
    table: schema.devices,
    id: schema.devices.id,
    column: schema.devices.pushKey,
    key: 'pushKey',
  },
  {
    name: 'git_connections.secrets',
    table: schema.gitConnections,
    id: schema.gitConnections.id,
    column: schema.gitConnections.secrets,
    key: 'secrets',
    updatedAt: schema.gitConnections.updatedAt,
  },
  {
    name: 'instance_settings.value',
    table: schema.instanceSettings,
    id: schema.instanceSettings.key,
    column: schema.instanceSettings.value,
    key: 'value',
    updatedAt: schema.instanceSettings.updatedAt,
    install: true,
  },
  {
    name: 'instance_keys.signing_key',
    table: schema.instanceKeys,
    id: schema.instanceKeys.id,
    column: schema.instanceKeys.signingKey,
    key: 'signingKey',
    install: true,
  },
];

/**
 * bytea columns that hold no secret, so nothing to re-seal: public keys and
 * a code's hash (rotation.test.ts checks every other bytea column is above).
 */
export const PLAIN_BYTEA_COLUMNS: readonly string[] = [
  'devices.public_key',
  'device_pairings.code_hash',
  'instance_keys.public_key',
];

/** The OAuth token columns of `accounts` better-auth encrypts (it never encrypts the id token). */
const ACCOUNT_TOKENS = ['accessToken', 'refreshToken'] as const;

export interface RotationProgress {
  /** A `table.column` name, or `accounts.oauth_tokens`. */
  column: string;
  checked: number;
  resealed: number;
}

export interface RotationReport {
  /** Rows re-sealed under the current key. */
  resealed: number;
  /** Rows the current key sealed already. */
  current: number;
  /** Rows no configured key opens; they keep their value. */
  failed: { column: string; id: string; error: string }[];
}

export interface RotationOptions {
  db: Db;
  config: Pick<Config, 'masterKey' | 'previousMasterKeys'>;
  batchSize?: number;
  /** Called after every batch. */
  onProgress?: (progress: RotationProgress) => void;
}

export async function rotateMasterKey({
  db,
  config,
  batchSize = 200,
  onProgress,
}: RotationOptions): Promise<RotationReport> {
  const keyring = keyringFromConfig(config);
  const report: RotationReport = { resealed: 0, current: 0, failed: [] };

  for (const sealed of SEALED_COLUMNS) {
    const progress: RotationProgress = { column: sealed.name, checked: 0, resealed: 0 };
    // Each organization's rows in its scope (db/scope.ts); the install's once, in none.
    const workspaceColumn = (sealed.table as unknown as { workspaceId: PgColumn }).workspaceId;
    const each = (run: (where: SQL) => Promise<void>) =>
      sealed.install
        ? run(isNotNull(sealed.column))
        : forEachWorkspace(db, (workspaceId) =>
            run(and(isNotNull(sealed.column), eq(workspaceColumn, workspaceId))!),
          );
    await each((where) =>
      inBatches(db, sealed.table, sealed.id, where, batchSize, {
        select: { value: sealed.column },
        each: async (id, row) => {
          const value = row.value as Buffer;
          progress.checked++;
          let next: Buffer | null;
          try {
            next = resealSecret(value, keyring);
          } catch (err) {
            report.failed.push({ column: sealed.name, id, error: (err as Error).message });
            return;
          }
          if (!next) {
            report.current++;
            return;
          }
          const set: Record<string, unknown> = { [sealed.key]: next };
          if (sealed.updatedAt) set.updatedAt = sql`${sealed.updatedAt}`;
          const updated = await db
            .update(sealed.table)
            .set(set as never)
            .where(and(eq(sealed.id, id), eq(sealed.column, value)))
            .returning({ id: sealed.id });
          if (updated.length) {
            report.resealed++;
            progress.resealed++;
          }
        },
        batch: () => onProgress?.({ ...progress }),
      }),
    );
  }

  // The sign-in providers' tokens, sealed by better-auth with the secret derived from a key.
  const current = authSecret(config.masterKey);
  const previous = config.previousMasterKeys.map(authSecret);
  const progress: RotationProgress = { column: 'accounts.oauth_tokens', checked: 0, resealed: 0 };
  const accounts = schema.accounts;
  await inBatches(
    db,
    accounts,
    accounts.id,
    or(isNotNull(accounts.accessToken), isNotNull(accounts.refreshToken))!,
    batchSize,
    {
      select: { accessToken: accounts.accessToken, refreshToken: accounts.refreshToken },
      each: async (id, row) => {
        progress.checked++;
        const set: Partial<Record<(typeof ACCOUNT_TOKENS)[number], string>> = {};
        const unchanged: SQL[] = [];
        let failed = false;
        for (const field of ACCOUNT_TOKENS) {
          const token = row[field] as string | null;
          if (!token) continue;
          // Plain-text tokens are encryptStoredOAuthTokens' job; it runs at every start.
          if (!isEncrypted(token)) continue;
          if (await opens(current, token)) continue;
          const opened = await openWithAny(previous, token);
          if (opened === null) {
            report.failed.push({
              column: `accounts.${field === 'accessToken' ? 'access_token' : 'refresh_token'}`,
              id,
              error: 'no configured master key opens this token',
            });
            failed = true;
            continue;
          }
          set[field] = await symmetricEncrypt({ key: current, data: opened });
          unchanged.push(eq(accounts[field], token));
        }
        if (!unchanged.length) {
          if (!failed) report.current++;
          return;
        }
        const updated = await db
          .update(accounts)
          .set({ ...set, updatedAt: sql`${accounts.updatedAt}` })
          .where(and(eq(accounts.id, id), ...unchanged))
          .returning({ id: accounts.id });
        if (updated.length) {
          report.resealed++;
          progress.resealed++;
        }
      },
      batch: () => onProgress?.({ ...progress }),
    },
  );

  return report;
}

/** Walks the rows matching `where` in id order, `size` at a time. */
async function inBatches<T extends Record<string, PgColumn>>(
  db: Db,
  table: PgTable,
  id: PgColumn,
  where: SQL,
  size: number,
  visit: {
    select: T;
    each: (id: string, row: Record<keyof T, unknown>) => Promise<void>;
    batch: () => void;
  },
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const rows = (await db
      .select({ ...visit.select, rowId: id })
      .from(table)
      .where(after === undefined ? where : and(where, gt(id, after)))
      .orderBy(asc(id))
      .limit(size)) as (Record<keyof T, unknown> & { rowId: string })[];
    if (!rows.length) return;
    for (const row of rows) await visit.each(row.rowId, row);
    after = rows.at(-1)!.rowId;
    visit.batch();
  }
}

async function opens(key: string, token: string): Promise<boolean> {
  return (await openWithAny([key], token)) !== null;
}

async function openWithAny(keys: readonly string[], token: string): Promise<string | null> {
  for (const key of keys) {
    try {
      return await symmetricDecrypt({ key, data: token });
    } catch {
      // not this key
    }
  }
  return null;
}
