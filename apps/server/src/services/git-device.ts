import { and, asc, eq, sql } from 'drizzle-orm';
import { netFetch } from '../builtins/net.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { getConnectionView } from './git-connections.js';
import { openConnectionSecrets, sealConnectionSecrets } from './git-connection-secrets.js';
import {
  beginGitHubDevice,
  GitHubAppAuthorizationError,
  pollGitHubDevice,
} from './github-device.js';
import { userAppRepositories } from './github-user-app.js';

type Deps = Pick<AppDeps, 'db' | 'config'> & Partial<Pick<AppDeps, 'net'>>;
type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
const owned = (owner: Owner) =>
  and(
    eq(schema.gitConnections.ownerId, owner.id),
    eq(schema.gitConnections.workspaceId, owner.workspaceId),
  );

/** Public identifiers, never an App private key or OAuth client secret. */
export interface DeviceClient {
  clientId: string;
  appSlug: string;
}
export function defaultDeviceClient(deps: Pick<AppDeps, 'config'>): DeviceClient | null {
  const clientId = deps.config.githubConnectorClientId;
  const appSlug = deps.config.githubConnectorAppSlug;
  return clientId && appSlug ? { clientId, appSlug } : null;
}

/** Serialize starts/completions for this owner, including two browser tabs. */
async function ownerLock(tx: Db, owner: Owner) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`github-device:${owner.workspaceId}:${owner.id}`}, 0))`,
  );
}

/** A pending connection is an owned, encrypted authorization attempt, not a
 * credential. Reauthorizing retains the old working authorization until the
 * new user token AND installation/repository access have been verified.
 */
export async function startGitDevice(
  deps: Deps,
  owner: Owner,
  input: {
    connectionId?: string;
    clientId?: string;
    appSlug?: string;
  },
) {
  // Authorize the resource before contacting GitHub (including reconnects).
  const previous = input.connectionId ? await getOwned(deps.db, owner, input.connectionId) : null;
  if (previous && previous.kind !== 'device')
    throw new DomainError(
      409,
      'NOT_DEVICE_CONNECTION',
      'This connection does not use device authorization.',
    );
  const previousAuth = previous ? openConnectionSecrets(deps, previous).githubDevice : null;
  const client =
    input.clientId && input.appSlug
      ? { clientId: input.clientId, appSlug: input.appSlug }
      : previousAuth
        ? { clientId: previousAuth.clientId, appSlug: previousAuth.appSlug }
        : defaultDeviceClient(deps);
  if (!client)
    throw new DomainError(
      409,
      'GITHUB_DEVICE_CLIENT_MISSING',
      'Set a GitHub App client ID and slug with Device Flow enabled. No client secret is used.',
    );
  return deps.db.transaction(async (tx) => {
    await ownerLock(tx, owner);
    // One owned connection per App: retry failed attempts and reconnect working
    // ones in place. Custom Apps and other owners remain independent.
    const rows = input.connectionId
      ? [await getOwned(tx, owner, input.connectionId, true)]
      : await tx
          .select()
          .from(schema.gitConnections)
          .where(and(owned(owner), eq(schema.gitConnections.kind, 'device')))
          .orderBy(asc(schema.gitConnections.createdAt), asc(schema.gitConnections.id))
          .for('update');
    const row = input.connectionId
      ? rows[0]
      : (rows.find((candidate) => {
          const auth = openConnectionSecrets(deps, candidate).githubDevice;
          return (
            auth?.clientId === client.clientId && auth.appSlug === client.appSlug && auth.tokens
          );
        }) ??
        rows.find((candidate) => {
          const auth = openConnectionSecrets(deps, candidate).githubDevice;
          return auth?.clientId === client.clientId && auth.appSlug === client.appSlug;
        }));
    if (row) {
      // Retire credential-free attempts left by older retry behavior. A
      // completed account or exchanged pending token is never discarded.
      for (const duplicate of rows) {
        if (duplicate.id === row.id) continue;
        const stored = openConnectionSecrets(deps, duplicate);
        const other = stored.githubDevice;
        if (
          stored.token ||
          other?.tokens ||
          other?.pending?.tokens ||
          other?.clientId !== client.clientId ||
          other.appSlug !== client.appSlug
        )
          continue;
        await tx
          .update(schema.repos)
          .set({ connectionId: row.id })
          .where(
            and(
              eq(schema.repos.connectionId, duplicate.id),
              eq(schema.repos.ownerId, owner.id),
              eq(schema.repos.workspaceId, owner.workspaceId),
            ),
          );
        await tx.delete(schema.gitConnections).where(eq(schema.gitConnections.id, duplicate.id));
      }
    }
    const secrets = row ? openConnectionSecrets(deps, row) : {};
    const auth = secrets.githubDevice ?? { ...client };
    const pending = auth.pending;
    if (
      pending?.instructions &&
      pending.device.clientId === client.clientId &&
      pending.device.appSlug === client.appSlug &&
      pending.device.expiresAt > Date.now()
    )
      return {
        connectionId: row!.id,
        device: { ...pending.instructions, interval: pending.device.interval },
      };
    let started;
    try {
      // Acquire the owner lock BEFORE issuing a code. Other callers return
      // these same instructions rather than replacing the code on screen.
      started = await beginGitHubDevice(client.clientId, client.appSlug, netFetch(deps.net));
    } catch {
      throw new DomainError(
        502,
        'GITHUB_DEVICE_FAILED',
        'Could not start GitHub authorization. Check that Device Flow is enabled on the GitHub App.',
      );
    }
    if (!auth.tokens) Object.assign(auth, client);
    auth.pending = { device: started.device, instructions: started.public };
    secrets.githubDevice = auth;
    const fields = {
      secrets: sealConnectionSecrets(deps, secrets),
      updatedAt: new Date(),
      ...(auth.tokens ? {} : { status: 'pending', error: null }),
    };
    if (row) {
      await tx
        .update(schema.gitConnections)
        .set(fields)
        .where(eq(schema.gitConnections.id, row.id));
      return { connectionId: row.id, device: started.public };
    }
    const [made] = await tx
      .insert(schema.gitConnections)
      .values({
        workspaceId: owner.workspaceId,
        ownerId: owner.id,
        kind: 'device',
        provider: 'github',
        accountLogin: 'GitHub',
        actAs: 'owner',
        ...fields,
      })
      .returning({ id: schema.gitConnections.id });
    return { connectionId: made!.id, device: started.public };
  });
}

async function getOwned(db: Db, owner: Owner, id: string, lock = false) {
  const query = db
    .select()
    .from(schema.gitConnections)
    .where(and(owned(owner), eq(schema.gitConnections.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Git connection not found');
  return row;
}

type PollOutcome =
  | { status: 'pending'; interval: number; stage: 'authorization' | 'installation' }
  | { status: 'connected'; connectionId: string }
  | { status: 'error'; message: string };

/** Authenticated polling. No device_code, access token or refresh token ever
 * reaches the browser. Row locks enforce GitHub's polling interval across
 * workers and prevent a late poll overwriting a newer start or a deletion.
 */
export async function pollGitDevice(deps: Deps, owner: Owner, id: string) {
  const outcome: PollOutcome = await deps.db.transaction(async (tx): Promise<PollOutcome> => {
    await ownerLock(tx, owner);
    const row = await getOwned(tx, owner, id, true);
    if (row.kind !== 'device')
      throw new DomainError(
        409,
        'NOT_DEVICE_CONNECTION',
        'This connection does not use device authorization.',
      );
    const secrets = openConnectionSecrets(deps, row);
    const auth = secrets.githubDevice;
    const pending = auth?.pending;
    // Retried successful poll is idempotent.
    if (!pending && auth?.tokens) return { status: 'connected', connectionId: row.id };
    if (!pending)
      throw new DomainError(409, 'GITHUB_DEVICE_MISSING', 'Start GitHub authorization again.');
    const device = pending.device;
    const waiting = (): PollOutcome => ({
      status: 'pending',
      interval: device.interval,
      stage: pending.tokens ? 'installation' : 'authorization',
    });
    const save = async (fields: Partial<typeof schema.gitConnections.$inferInsert> = {}) => {
      await tx
        .update(schema.gitConnections)
        .set({ ...fields, secrets: sealConnectionSecrets(deps, secrets), updatedAt: new Date() })
        .where(eq(schema.gitConnections.id, row.id));
    };
    const fail = async (message: string): Promise<PollOutcome> => {
      delete auth!.pending;
      await save(auth!.tokens ? {} : { status: 'error', error: message });
      return { status: 'error', message };
    };
    if (Date.now() >= device.expiresAt)
      return fail('The GitHub code expired. Connect again for a new code.');
    if (Date.now() < device.nextPollAt) return waiting();
    if (!pending.tokens) {
      let result;
      try {
        result = await pollGitHubDevice(device, netFetch(deps.net));
      } catch (error) {
        if (error instanceof GitHubAppAuthorizationError) return fail(error.message);
        device.nextPollAt = Date.now() + Math.max(device.interval * 1000, 20_000);
        await save();
        return waiting();
      }
      if ('error' in result) {
        if (result.error === 'authorization_pending' || result.error === 'slow_down') {
          if (result.error === 'slow_down')
            device.interval = Math.max(device.interval + 5, result.interval ?? 0);
          device.nextPollAt = Date.now() + device.interval * 1000;
          await save();
          return waiting();
        }
        return fail(
          result.error === 'access_denied'
            ? 'GitHub authorization was cancelled. Connect again to retry.'
            : 'GitHub authorization ended. Connect again for a new code.',
        );
      }
      pending.tokens = result.tokens;
    }
    let access;
    try {
      access = await userAppRepositories(deps, pending.tokens.access_token, device.appSlug);
    } catch {
      // Retain an already exchanged, encrypted token so transient API failures
      // never require exchanging a single-use device code for a second time.
      device.nextPollAt = Date.now() + Math.max(device.interval * 1000, 20_000);
      await save();
      return waiting();
    }
    if (!access.installed) {
      device.nextPollAt = Date.now() + device.interval * 1000;
      await save();
      return waiting();
    }
    if (auth!.userId && auth!.userId !== access.user.id)
      return fail(
        'This is a different GitHub account. Disconnect this connection before connecting a different account.',
      );
    const targetSecrets = secrets;
    targetSecrets.githubDevice = {
      clientId: device.clientId,
      appSlug: device.appSlug,
      userId: access.user.id,
      tokens: pending.tokens,
    };
    await tx
      .update(schema.gitConnections)
      .set({
        secrets: sealConnectionSecrets(deps, targetSecrets),
        accountLogin: access.user.login,
        accountType: 'user',
        actAs: 'owner',
        status: 'connected',
        error: null,
        repositories: access.repositories.map(({ fullName, push, admin }) => ({
          fullName,
          push,
          admin,
        })),
        repositoriesSyncedAt: new Date(),
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.gitConnections.id, row.id));
    return { status: 'connected', connectionId: row.id };
  });
  if (outcome.status !== 'connected') return outcome;
  return {
    status: 'connected' as const,
    connection: await getConnectionView(deps, owner, outcome.connectionId),
  };
}
