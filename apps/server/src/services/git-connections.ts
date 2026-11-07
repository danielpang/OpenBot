import {
  normalizeFullName,
  type GitActAs,
  type GitConnectionRepoAccess,
  type GitConnectionView,
  type RemoteRepo,
} from '@openbots/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { asDirectory } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { isOrgAdmin, type Role } from '../workspace.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import { ownerOAuthToken } from './git-credentials.js';
import { GithubApiError, githubAppFor, type GithubApp } from './github-app.js';
import type { GitCredentialScope, GithubPermissionLevel } from './github-app-types.js';

// The owner's git connections (GH1, GH2, GH7, GH8; I17): an installation of
// the GitHub App (`app`), the owner's OAuth sign-in (`oauth`) or a pasted
// fine-grained token (`token`). One per owner per GitHub account. An App
// connection keeps no token: it mints installation tokens narrowed to one
// repository at a time (`tokenForRepo`). The other kinds keep their token in
// `secrets`, sealed under the master key. Connectors stay separate: a
// repository with no connection falls back to the GitHub connector's token
// in git-credentials.ts.
//
// An installation reaches every repository it was given, whoever in the
// organization connects it, so an App connection is held to what its owner
// may do on GitHub (H1): at install, and again whenever the owner
// authorizes again (`refreshRepositories`), the owner's own GitHub
// authorization lists the installation's repositories it reaches, with
// `push` and `admin` (`git_connections.repositories`). The picker shows only
// those; a token is minted only for one of them, `contents: write` only
// where the owner has `push`. The user token is revoked right after it is
// read, never stored, so a re-sync cannot read the list again by itself: it
// says `needsReauthorize`, and the owner authorizes again. With that in
// place, several owners, here or in other organizations, may each connect
// the same installation, each held to their own access; nothing is refused
// because someone else connected it first.

type ConnectionDeps = Pick<AppDeps, 'db' | 'config'> & Partial<Pick<AppDeps, 'net' | 'logger'>>;
type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
export type ConnectionRow = typeof schema.gitConnections.$inferSelect;

/** What `git_connections.secrets` holds, sealed. */
interface ConnectionSecrets {
  /** The `token` kind's token, or the `oauth` kind's access token. */
  token?: string;
}

/** The username GitHub expects beside an installation token (and accepts beside any token). */
export const TOKEN_USERNAME = 'x-access-token';

const keyring = (deps: Pick<AppDeps, 'config'>) => keyringFromConfig(deps.config);

function openConnectionSecrets(deps: Pick<AppDeps, 'config'>, row: ConnectionRow) {
  if (!row.secrets) return {} as ConnectionSecrets;
  return JSON.parse(decryptSecretString(row.secrets, keyring(deps))) as ConnectionSecrets;
}

const ownedBy = (owner: Owner) =>
  and(
    eq(schema.gitConnections.ownerId, owner.id),
    eq(schema.gitConnections.workspaceId, owner.workspaceId),
  );

const NO_INSTALLATION = 'This connection has no GitHub App installation';
export const ACT_AS_NEEDS_SIGN_IN =
  'Connect GitHub sign-in under Connectors to open pull requests as you';

/** A token refused because the connection does not reach the repository (H1). */
export const connectionNoAccess = (message: string) =>
  new DomainError(403, 'CONNECTION_NO_ACCESS', message);

/** `owner/name` in the form two names are compared in: no `.git`, lower case. */
const normalName = (fullName: string) =>
  (normalizeFullName(fullName) ?? fullName.trim()).toLowerCase();

/** The repository's owner is the connection's account (an installation reaches no other). */
const ofAccount = (row: Pick<ConnectionRow, 'accountLogin'>, fullName: string) =>
  normalName(fullName).split('/')[0] === row.accountLogin.toLowerCase();

/** The owner's access to one repository through an App connection, as last read; null for none. */
function accessOf(
  row: Pick<ConnectionRow, 'repositories'>,
  fullName: string,
): GitConnectionRepoAccess | null {
  const name = normalName(fullName);
  return row.repositories?.find((r) => r.fullName.toLowerCase() === name) ?? null;
}

/**
 * What a connection allows on one repository. An App connection: read when
 * the repository is the account's and in the owner's list, write when the
 * owner also has `push` there. A token or OAuth connection is the owner's
 * own GitHub token, which GitHub holds to the owner's access: both.
 */
export function allowsOn(
  row: Pick<ConnectionRow, 'kind' | 'accountLogin' | 'repositories'>,
  fullName: string,
): { read: boolean; write: boolean } {
  if (row.kind !== 'app') return { read: true, write: true };
  const entry = ofAccount(row, fullName) ? accessOf(row, fullName) : null;
  return { read: Boolean(entry), write: entry?.push === true };
}

/**
 * What the connection `connectionId` allows on `fullName` (see `allowsOn`);
 * null when there is no such connection in the organization of the work in
 * hand, or, given `ownerId`, none of that owner's. For checking a repository
 * picked through a connection before it is remembered.
 */
export async function connectionAllows(
  deps: Pick<AppDeps, 'db'>,
  connectionId: string,
  fullName: string,
  ownerId?: string,
): Promise<{ read: boolean; write: boolean } | null> {
  const [row] = await deps.db
    .select()
    .from(schema.gitConnections)
    .where(
      and(
        eq(schema.gitConnections.id, connectionId),
        ...(ownerId ? [eq(schema.gitConnections.ownerId, ownerId)] : []),
      ),
    );
  return row ? allowsOn(row, fullName) : null;
}

export function toConnectionView(row: ConnectionRow, repoCount: number): GitConnectionView {
  return {
    id: row.id,
    provider: 'github',
    kind: row.kind as GitConnectionView['kind'],
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: (row.accountType as GitConnectionView['accountType']) ?? null,
    actAs: row.actAs as GitActAs,
    status: row.status as GitConnectionView['status'],
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    repoCount,
    error: row.error,
    repositoriesSyncedAt: row.repositoriesSyncedAt?.toISOString() ?? null,
  };
}

async function repoCounts(deps: Pick<AppDeps, 'db'>, owner: Owner) {
  const rows = await deps.db
    .select({ connectionId: schema.repos.connectionId, count: sql<number>`count(*)::int` })
    .from(schema.repos)
    .where(
      and(
        eq(schema.repos.ownerId, owner.id),
        eq(schema.repos.workspaceId, owner.workspaceId),
        isNotNull(schema.repos.connectionId),
      ),
    )
    .groupBy(schema.repos.connectionId);
  return new Map(rows.map((r) => [r.connectionId!, Number(r.count)]));
}

async function viewOf(deps: Pick<AppDeps, 'db'>, owner: Owner, row: ConnectionRow) {
  return toConnectionView(row, (await repoCounts(deps, owner)).get(row.id) ?? 0);
}

/** The owner's connections, oldest first. */
export async function listConnections(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
): Promise<GitConnectionView[]> {
  const [rows, counts] = await Promise.all([
    deps.db
      .select()
      .from(schema.gitConnections)
      .where(ownedBy(owner))
      .orderBy(schema.gitConnections.createdAt),
    repoCounts(deps, owner),
  ]);
  return rows.map((row) => toConnectionView(row, counts.get(row.id) ?? 0));
}

/** One of the owner's connections; 404 for anyone else's. */
export async function getConnection(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  id: string,
): Promise<ConnectionRow> {
  const [row] = await deps.db
    .select()
    .from(schema.gitConnections)
    .where(and(ownedBy(owner), eq(schema.gitConnections.id, id)));
  if (!row) throw notFound('Git connection not found');
  return row;
}

export async function getConnectionView(deps: Pick<AppDeps, 'db'>, owner: Owner, id: string) {
  return viewOf(deps, owner, await getConnection(deps, owner, id));
}

/** The owner's `app` connection for an installation, made or brought up to date. */
export async function createFromInstallation(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  input: {
    installationId: string;
    accountLogin: string;
    accountType: 'user' | 'organization';
    /** The owner's reach in it, from their own GitHub authorization. */
    repositories: GitConnectionRepoAccess[];
  },
): Promise<GitConnectionView> {
  const fields = {
    kind: 'app',
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    repositories: input.repositories,
    repositoriesSyncedAt: new Date(),
    status: 'connected',
    error: null,
    updatedAt: new Date(),
  };
  const [existing] = await deps.db
    .select()
    .from(schema.gitConnections)
    .where(
      and(
        ownedBy(owner),
        eq(schema.gitConnections.provider, 'github'),
        eq(schema.gitConnections.installationId, input.installationId),
      ),
    );
  const [row] = existing
    ? await deps.db
        .update(schema.gitConnections)
        .set(fields)
        .where(eq(schema.gitConnections.id, existing.id))
        .returning()
    : await deps.db
        .insert(schema.gitConnections)
        .values({
          ...fields,
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          provider: 'github',
          installationId: input.installationId,
        })
        .returning();
  return viewOf(deps, owner, row!);
}

/** Revokes a user token after use; a failure is logged, as the token expires anyway. */
async function revokeQuietly(deps: ConnectionDeps, github: GithubApp, userToken: string) {
  await github.revokeUserToken(userToken).catch((err: unknown) => {
    deps.logger?.warn({ err }, 'GitHub user token not revoked');
  });
}

/**
 * The owner's reach in an installation, read with their own GitHub
 * authorization (the `code` the install or the reauthorization sent):
 * 403 unless that authorization lists the installation. The user token is
 * revoked before this returns, whatever happened.
 */
async function ownerReach(
  deps: ConnectionDeps,
  installationId: string,
  code: string,
): Promise<GitConnectionRepoAccess[]> {
  const github = githubAppFor(deps);
  const userToken = await github.userToken(code);
  try {
    const reachable = await github.userInstallationIds(userToken);
    if (!reachable.includes(installationId)) {
      throw new DomainError(403, 'INSTALLATION_NOT_YOURS', 'This installation is not yours');
    }
    return await github.userInstallationRepos(userToken, installationId);
  } finally {
    await revokeQuietly(deps, github, userToken);
  }
}

/**
 * The installation callback's work: binds `installationId` to the owner
 * only when the owner's own GitHub authorization (the install's `code`,
 * exchanged for a user token) lists it, so nobody binds an installation by
 * typing its id, and keeps the repositories that authorization reaches as
 * the connection's reach (H1). Another owner having connected the same
 * installation is no reason to refuse: each is held to their own access.
 * Then the connection is made or brought up to date and listed once.
 */
export async function connectInstallation(
  deps: ConnectionDeps,
  owner: Owner,
  input: { installationId: string; code: string },
): Promise<GitConnectionView> {
  const repositories = await ownerReach(deps, input.installationId, input.code);
  const found = await githubAppFor(deps).installation(input.installationId);
  const made = await createFromInstallation(deps, owner, {
    installationId: input.installationId,
    accountLogin: found.accountLogin,
    accountType: found.accountType,
    repositories,
  });
  // The first listing: the status and `last_synced_at` come from it.
  return syncConnection(deps, owner, made.id).then(
    (synced) => synced.connection,
    (err: unknown) => {
      deps.logger?.warn({ err, connectionId: made.id }, 'new git connection not synced');
      return made;
    },
  );
}

/**
 * The reauthorization callback's work (`reauth` state): reads the owner's
 * reach in the connection's installation again with the `code`, then
 * re-syncs. 403 when the owner's GitHub no longer lists the installation.
 */
export async function refreshRepositories(
  deps: ConnectionDeps,
  owner: Owner,
  id: string,
  code: string,
): Promise<GitConnectionView> {
  const row = await getConnection(deps, owner, id);
  if (row.kind !== 'app' || !row.installationId) {
    throw new DomainError(409, 'NO_INSTALLATION', NO_INSTALLATION);
  }
  const repositories = await ownerReach(deps, row.installationId, code);
  await deps.db
    .update(schema.gitConnections)
    .set({ repositories, repositoriesSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.gitConnections.id, row.id));
  return (await syncConnection(deps, owner, id)).connection;
}

/** A pasted fine-grained token (the `token` kind): checked with GitHub, then kept sealed. */
export async function createTokenConnection(
  deps: ConnectionDeps,
  owner: Owner,
  input: { token: string },
): Promise<GitConnectionView> {
  const token = input.token.trim();
  let user;
  try {
    user = await githubAppFor(deps).tokenUser(token);
  } catch (error) {
    if (error instanceof GithubApiError && error.githubStatus === 401) {
      throw new DomainError(400, 'GITHUB_TOKEN_INVALID', 'GitHub did not accept this token');
    }
    throw error;
  }
  const [row] = await deps.db
    .insert(schema.gitConnections)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      provider: 'github',
      kind: 'token',
      accountLogin: user.login,
      accountType: user.type,
      secrets: encryptSecret(JSON.stringify({ token } satisfies ConnectionSecrets), keyring(deps)),
      status: 'connected',
    })
    .returning();
  return viewOf(deps, owner, row!);
}

/**
 * Who opens pull requests through an App connection (GH8). 400 for a token
 * or OAuth connection, which always opens them with its own token; 409 for
 * `owner` while the owner has no GitHub sign-in to open them with.
 */
export async function setActAs(
  deps: Pick<AppDeps, 'db' | 'config' | 'logger'>,
  owner: Owner,
  id: string,
  actAs: GitActAs,
): Promise<GitConnectionView> {
  const existing = await getConnection(deps, owner, id);
  if (existing.kind !== 'app') {
    throw new DomainError(
      400,
      'ACT_AS_APP_ONLY',
      'Only a GitHub App connection can choose who opens pull requests',
    );
  }
  if (actAs === 'owner' && !(await ownerOAuthToken(deps, owner))) {
    throw new DomainError(409, 'ACT_AS_NEEDS_SIGN_IN', ACT_AS_NEEDS_SIGN_IN);
  }
  const [row] = await deps.db
    .update(schema.gitConnections)
    .set({ actAs, updatedAt: new Date() })
    .where(and(ownedBy(owner), eq(schema.gitConnections.id, id)))
    .returning();
  return viewOf(deps, owner, row!);
}

/** Every repository the connection reaches, from GitHub. */
async function reachable(deps: ConnectionDeps, row: ConnectionRow) {
  const github = githubAppFor(deps);
  if (row.kind === 'app') {
    if (!row.installationId) throw new DomainError(409, 'NO_INSTALLATION', NO_INSTALLATION);
    return github.listInstallationRepos(row.installationId);
  }
  const { token } = openConnectionSecrets(deps, row);
  if (!token) throw new DomainError(409, 'NO_TOKEN', 'The connection has no token');
  return github.listTokenRepos(token);
}

/** The status GitHub's error means for the connection. */
function statusOf(row: ConnectionRow, error: unknown) {
  if (error instanceof GithubApiError) {
    if (row.kind === 'app' && (error.githubStatus === 404 || error.githubStatus === 403)) {
      return {
        status: 'needs_reinstall',
        error: 'GitHub no longer finds this installation. Install the App again.',
      };
    }
    if (error.githubStatus === 401) {
      return { status: 'revoked', error: 'GitHub no longer accepts this token' };
    }
  }
  return { status: 'error', error: (error as Error).message.slice(0, 500) };
}

/**
 * Lists the connection's repositories again: refreshes its status and
 * `last_synced_at`. For an App connection, the owner's list loses what the
 * installation no longer reaches; it cannot gain anything without the
 * owner's own authorization, which OpenBots does not keep, so
 * `needsReauthorize` is true and the owner may authorize again
 * (`GET /git-connections/{id}/reauthorize`) to pick up new repositories.
 */
export async function syncConnection(
  deps: ConnectionDeps,
  owner: Owner,
  id: string,
): Promise<{ connection: GitConnectionView; needsReauthorize: boolean }> {
  const row = await getConnection(deps, owner, id);
  let set: Partial<ConnectionRow>;
  try {
    const repos = await reachable(deps, row);
    set = { status: 'connected', error: null, lastSyncedAt: new Date() };
    if (row.kind === 'app' && row.repositories) {
      const present = new Set(repos.map((r) => r.fullName.toLowerCase()));
      set.repositories = row.repositories.filter((r) => present.has(r.fullName.toLowerCase()));
    }
  } catch (error) {
    // GitHub out of reach says nothing about the connection.
    if (error instanceof DomainError && error.code === 'GITHUB_UNAVAILABLE') throw error;
    set = statusOf(row, error);
  }
  const [updated] = await deps.db
    .update(schema.gitConnections)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(schema.gitConnections.id, row.id))
    .returning();
  return { connection: await viewOf(deps, owner, updated!), needsReauthorize: row.kind === 'app' };
}

/** Forgets the connection; its repositories keep their rows with `connection_id` null. */
export async function deleteConnection(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  id: string,
): Promise<void> {
  await getConnection(deps, owner, id);
  await deps.db
    .delete(schema.gitConnections)
    .where(and(ownedBy(owner), eq(schema.gitConnections.id, id)));
}

/**
 * The picker's list (GH2): what the connection reaches, filtered by `q`,
 * with `remembered` set. For an App connection, only the repositories of
 * the owner's own list (H1) that the installation still reaches.
 */
export async function remoteRepos(
  deps: ConnectionDeps,
  owner: Owner,
  id: string,
  q?: string,
): Promise<RemoteRepo[]> {
  const row = await getConnection(deps, owner, id);
  let repos;
  try {
    repos = await reachable(deps, row);
  } catch (error) {
    if (error instanceof GithubApiError) {
      const set = statusOf(row, error);
      await deps.db
        .update(schema.gitConnections)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(schema.gitConnections.id, row.id));
    }
    throw error;
  }
  const remembered = new Set(
    (
      await deps.db
        .select({ fullName: schema.repos.fullName })
        .from(schema.repos)
        .where(
          and(eq(schema.repos.ownerId, owner.id), eq(schema.repos.workspaceId, owner.workspaceId)),
        )
    ).map((r) => r.fullName.toLowerCase()),
  );
  const needle = q?.trim().toLowerCase();
  return repos
    .filter((r) => allowsOn(row, r.fullName).read)
    .filter((r) => !needle || r.fullName.toLowerCase().includes(needle))
    .map(({ id: _id, ...repo }) => ({
      ...repo,
      remembered: remembered.has(repo.fullName.toLowerCase()),
    }));
}

/**
 * The connection a repository goes through: the one it was picked from,
 * else the owner's connected App installation on the repository's account.
 * Null when there is none (git-credentials.ts then falls back to the GitHub
 * connector's token).
 */
export async function connectionForRepo(
  deps: Pick<AppDeps, 'db'>,
  ask: { ownerId: string; workspaceId?: string; repoFullName: string },
): Promise<ConnectionRow | null> {
  const fullName = normalName(ask.repoFullName);
  const [repo] = await deps.db
    .select({ connectionId: schema.repos.connectionId })
    .from(schema.repos)
    .where(
      and(
        eq(schema.repos.ownerId, ask.ownerId),
        ...(ask.workspaceId ? [eq(schema.repos.workspaceId, ask.workspaceId)] : []),
        sql`lower(${schema.repos.fullName}) = ${fullName}`,
      ),
    );
  const connections = await deps.db
    .select()
    .from(schema.gitConnections)
    .where(
      and(
        eq(schema.gitConnections.ownerId, ask.ownerId),
        ...(ask.workspaceId ? [eq(schema.gitConnections.workspaceId, ask.workspaceId)] : []),
      ),
    );
  if (repo?.connectionId) {
    const picked = connections.find((c) => c.id === repo.connectionId);
    if (picked) return picked;
  }
  const account = fullName.split('/')[0];
  return (
    connections.find(
      (c) =>
        c.kind === 'app' && c.status === 'connected' && c.accountLogin.toLowerCase() === account,
    ) ?? null
  );
}

/** What a git token for one repository may do: read, or push (and open a pull request). */
export const permissionsFor = (write: boolean): Record<string, GithubPermissionLevel> =>
  write ? { contents: 'write', pull_requests: 'write' } : { contents: 'read' };

/**
 * A credential for one repository through `connection`: for an App, an
 * installation token narrowed to that repository with `permissionsFor(write)`;
 * for a token or OAuth connection, its stored token (which GitHub does not
 * narrow). Null when a token or OAuth connection has no token.
 *
 * An App token is refused (403 `CONNECTION_NO_ACCESS`) unless the
 * repository is of the connection's account and in the owner's own list
 * (H1), and a write token unless the owner has `push` there.
 */
export async function tokenForConnection(
  deps: ConnectionDeps,
  connection: ConnectionRow,
  scope: GitCredentialScope,
  permissions: Record<string, GithubPermissionLevel> = permissionsFor(scope.write),
): Promise<{ username: string; password: string } | null> {
  if (connection.kind === 'app') {
    if (!connection.installationId) throw connectionNoAccess(NO_INSTALLATION);
    const fullName = normalizeFullName(scope.repoFullName) ?? scope.repoFullName.trim();
    if (!ofAccount(connection, fullName)) {
      throw connectionNoAccess(
        `This connection reaches repositories of ${connection.accountLogin} only, not ${fullName}`,
      );
    }
    if (!connection.repositories) {
      throw connectionNoAccess(
        'Authorize this GitHub connection again on the Connectors page so OpenBots knows which repositories are yours',
      );
    }
    const allowed = allowsOn(connection, fullName);
    if (!allowed.read) {
      throw connectionNoAccess(
        `Your GitHub access through this installation does not include ${fullName}. If that changed, authorize the connection again on the Connectors page.`,
      );
    }
    const wantsWrite = scope.write || Object.values(permissions).includes('write');
    if (wantsWrite && !allowed.write) {
      throw connectionNoAccess(`You can read ${fullName} on GitHub but not push to it`);
    }
    const minted = await githubAppFor(deps).installationToken(connection.installationId, {
      repositories: [fullName],
      permissions,
    });
    return { username: TOKEN_USERNAME, password: minted.token };
  }
  const { token } = openConnectionSecrets(deps, connection);
  return token ? { username: TOKEN_USERNAME, password: token } : null;
}

/** git-credentials.ts's ask: a credential for one of the owner's repositories, or null when it has no connection. */
export async function tokenForRepo(
  deps: ConnectionDeps,
  ask: { ownerId: string; workspaceId?: string; repoFullName: string; write: boolean },
): Promise<{ username: string; password: string } | null> {
  const connection = await connectionForRepo(deps, ask);
  if (!connection) return null;
  return tokenForConnection(deps, connection, ask);
}

/** The user is, now, an admin (or owner) of the organization, and not suspended. */
export async function isOrgAdminNow(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  const [member] = await asDirectory(() =>
    db
      .select({
        role: schema.workspaceMembers.role,
        suspendedAt: schema.workspaceMembers.suspendedAt,
      })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      ),
  );
  return Boolean(member && !member.suspendedAt && isOrgAdmin(member.role as Role));
}
