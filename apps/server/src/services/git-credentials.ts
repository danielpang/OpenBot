import { normalizeFullName } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { openSecrets } from './connectors.js';
import { DomainError } from '../errors.js';
import {
  connectionForRepo,
  tokenForConnection as mintForConnection,
  TOKEN_USERNAME,
} from './git-connections.js';

// Git credentials for the computer (I5, GH7; docs/TECHNICAL_PLAN.md 22.4
// and 22.12). git on the computer asks openbots-git-credential, which asks
// the agent, which sends a `credential_request` over the session's socket;
// the runner answers it from here. The token never touches the computer's
// disk and is never logged: it travels in the one `credential` frame.
//
// What is served depends on the repository's git connection
// (git-connections.ts):
// - A server-managed App connection (kind 'app') mints a token narrowed to that one
//   repository: `contents: read` for a fetch, and `contents: write,
//   pull_requests: write` only once the push is allowed. GitHub enforces it:
//   a push with the read token answers 403 whatever the agent does.
// - A device-authorized App user token (kind 'device'), token or OAuth
//   connection, or with no connection the GitHub
//   connector's token (`githubTokenFor`), cannot be narrowed. The runner's
//   own clone and fetch get it; a session gets it only once its push is
//   allowed, and then only for the push url. The runner fetched the worktree
//   before the session, so a session needs no fetch of its own.
//
// The runner clones with `https://fetch@host/...` as the remote's url and
// `https://push@host/...` as its push url, so a request says what git is
// about to do by its username. Scope fails closed: a request is served only
// when git named the path (the image sets `credential.useHttpPath`, so a
// request without one is not git's) and the path is the repository the
// session, or the runner's own operation, works on.

type CredentialsDeps = Pick<AppDeps, 'db' | 'config' | 'logger'> & Partial<Pick<AppDeps, 'net'>>;

/** The git hosts OpenBots has a credential for; the API host is not one (the PR call skips the helper). */
const GITHUB_HOSTS = new Set(['github.com']);

/** The username in a remote's fetch url and push url (repos-checkout.ts sets both). */
export const FETCH_USERNAME = 'fetch';
export const PUSH_USERNAME = 'push';

/** One of the runner's own git operations, while it runs. */
export interface RunnerGit {
  /** The repository it works on: its requests are served for that one only. */
  repoFullName: string | null;
  /** The approved push; every other runner operation (clone, fetch) gets fetch only. */
  push: boolean;
  /**
   * The token's reach: write (a push) or read. Defaults to `push`. A rescue
   * push (GH5) registers `write: true`, which allows its push as well.
   */
  write?: boolean;
}

/**
 * The session ids of the runner's own git operations (clone, fetch,
 * worktree, the approved push), with the repository each works on. They get
 * the same host and path check as a session's git; a push only for the one
 * the owner approved. Each id lives only while its git command runs:
 * `runGit` (repos-checkout.ts) deletes it in a `finally`.
 */
export const runnerSessionIds = new Map<string, RunnerGit>();

export const PUSH_NEEDS_APPROVAL = "Push needs the owner's approval";
export const OWN_REPOSITORY_ONLY = 'This session may only reach its own repository';
export const FETCH_NEEDS_APP =
  'Fetching inside a session needs a GitHub App connection. The worktree was fetched before the session began.';
export const USE_OPENBOTS_REMOTE = 'Use the repository remote OpenBots set up';
export const NO_TOKEN =
  'Add a GitHub token on the Connectors page (GitHub, or the GitHub built-in) first';

export interface CredentialAsk {
  ownerId: string;
  workspaceId: string;
  host: string;
  /** git's path, `owner/name.git`, when `credential.useHttpPath` is on. */
  path?: string | undefined;
  username?: string | undefined;
  /** The `session_id` of the process git runs in. */
  sessionId: string;
  /** The coding session the process is, when it is one, as the runner knows it now. */
  session?: { pushAllowed: boolean; repoFullName?: string | null } | null;
}

export type CredentialAnswer = { username: string; password: string } | { denied: string };

/**
 * `tokenForConnection`, with a refusal (the connection does not reach the
 * repository, or not for writing; H1) as the denial git is told.
 */
async function tokenForConnection(
  ...args: Parameters<typeof mintForConnection>
): Promise<CredentialAnswer | null> {
  try {
    return await mintForConnection(...args);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'CONNECTION_NO_ACCESS') {
      return { denied: error.message };
    }
    throw error;
  }
}

/** The `owner/name` a credential path names, lower case; null when it names none. */
const repoOfPath = (path: string) =>
  normalizeFullName(path.replace(/^\/+|\/+$/g, ''))?.toLowerCase() ?? null;

/**
 * Answers one `credential_request`: a username and token, or why not.
 * Never throws for a missing token; the answer says so.
 */
export async function resolveGitCredential(
  deps: CredentialsDeps,
  ask: CredentialAsk,
): Promise<CredentialAnswer> {
  const host = ask.host.toLowerCase().replace(/:\d+$/, '');
  if (!GITHUB_HOSTS.has(host)) return { denied: `OpenBots has no credential for ${host}` };
  const runner = runnerSessionIds.get(ask.sessionId);
  // git reaches its own repository only, and must say which it asks for.
  const own = runner ? runner.repoFullName : ask.session?.repoFullName;
  const repoFullName = own ? repoOfPath(own) : null;
  if (!ask.path || !repoFullName || repoOfPath(ask.path) !== repoFullName) {
    return { denied: OWN_REPOSITORY_ONLY };
  }
  const isPush = ask.username === PUSH_USERNAME;
  const isFetch = ask.username === FETCH_USERNAME;
  const pushAllowed = runner
    ? runner.push || runner.write === true
    : ask.session?.pushAllowed === true;
  if (isPush && !pushAllowed) return { denied: PUSH_NEEDS_APPROVAL };
  if (!isPush && !isFetch && !pushAllowed) return { denied: USE_OPENBOTS_REMOTE };

  const connection = await connectionForRepo(deps, {
    ownerId: ask.ownerId,
    workspaceId: ask.workspaceId,
    repoFullName,
  });
  const owner = { id: ask.ownerId, workspaceId: ask.workspaceId };
  if (runner) {
    const write = runner.write ?? runner.push;
    const served = connection
      ? await tokenForConnection(deps, connection, { repoFullName, write })
      : await connectorCredential(deps, owner);
    return served ?? { denied: NO_TOKEN };
  }
  if (connection?.kind === 'app') {
    // GitHub holds the read token to reads; the write token waits for the push.
    // Once the push is approved a fetch gets the write token too, on purpose:
    // the session may write to the repository by then, so a separate read
    // token would narrow nothing.
    let served = await tokenForConnection(deps, connection, {
      repoFullName,
      write: pushAllowed,
    });
    // A fetch still gets read where the owner may not push.
    if (served && 'denied' in served && pushAllowed && !isPush) {
      served = await tokenForConnection(deps, connection, { repoFullName, write: false });
    }
    return served ?? { denied: NO_TOKEN };
  }
  // A token GitHub cannot narrow: a session gets it for its allowed push only.
  if (!pushAllowed) return { denied: FETCH_NEEDS_APP };
  if (!isPush) return { denied: 'Push with the remote OpenBots set up (its push url)' };
  const served = connection
    ? await tokenForConnection(deps, connection, { repoFullName, write: true })
    : await connectorCredential(deps, owner);
  return served ?? { denied: NO_TOKEN };
}

async function connectorCredential(
  deps: CredentialsDeps,
  owner: { id: string; workspaceId: string },
) {
  const token = await githubTokenFor(deps, owner);
  return token ? { username: TOKEN_USERNAME, password: token } : null;
}

/**
 * The owner's GitHub token: the built-in's first, then the GitHub
 * connector's bearer token or OAuth access token. Null when there is none.
 */
export async function githubTokenFor(
  deps: CredentialsDeps,
  owner: { id: string; workspaceId: string },
): Promise<string | null> {
  // The fallback for a repository with no git connection
  // (git-connections.ts `connectionForRepo`); connections come first.
  const rows = await deps.db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, owner.id),
        eq(schema.connectors.workspaceId, owner.workspaceId),
      ),
    );
  const ranked = [
    ...rows.filter((r) => r.catalogId === 'github_builtin'),
    ...rows.filter((r) => r.catalogId === 'github'),
  ].filter((r) => r.status !== 'disabled');
  for (const row of ranked) {
    let token: string | undefined;
    try {
      const secrets = openSecrets(deps, row);
      token =
        row.catalogId === 'github_builtin'
          ? secrets.values.GITHUB_TOKEN
          : (secrets.values.GITHUB_PERSONAL_ACCESS_TOKEN ?? secrets.oauth?.tokens?.access_token);
    } catch (error) {
      deps.logger.warn({ err: error, connectorId: row.id }, 'GitHub connector secrets unreadable');
      continue;
    }
    if (token) return token;
  }
  return null;
}

/** The owner's own GitHub OAuth token, from the GitHub connector's sign-in, or null. */
export async function ownerOAuthToken(
  deps: CredentialsDeps,
  owner: { id: string; workspaceId: string },
): Promise<string | null> {
  const rows = await deps.db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, owner.id),
        eq(schema.connectors.workspaceId, owner.workspaceId),
        eq(schema.connectors.catalogId, 'github'),
      ),
    );
  for (const row of rows.filter((r) => r.status !== 'disabled')) {
    try {
      const token = openSecrets(deps, row).oauth?.tokens?.access_token;
      if (token) return token;
    } catch (error) {
      deps.logger.warn({ err: error, connectorId: row.id }, 'GitHub connector secrets unreadable');
    }
  }
  return null;
}

/**
 * The token a pull request on `repoFullName` is opened with (GH8): through
 * an App connection an installation token with `pull_requests: write`, so
 * the App opens it, unless the connection acts as the owner and the owner
 * signed in with OAuth; through a token or OAuth connection its token; with
 * no connection the GitHub connector's.
 */
export async function pullRequestToken(
  deps: CredentialsDeps,
  owner: { id: string; workspaceId: string },
  repoFullName: string,
): Promise<string | null> {
  const connection = await connectionForRepo(deps, {
    ownerId: owner.id,
    workspaceId: owner.workspaceId,
    repoFullName,
  });
  if (!connection) return githubTokenFor(deps, owner);
  if (connection.kind === 'app' && connection.actAs === 'owner') {
    const mine = await ownerOAuthToken(deps, owner);
    if (mine) return mine;
  }
  // A refusal (CONNECTION_NO_ACCESS) is thrown: the caller says why the
  // pull request was not opened.
  const served = await mintForConnection(
    deps,
    connection,
    { repoFullName, write: true },
    { pull_requests: 'write' },
  );
  return served?.password ?? null;
}

export const gitCredentials = { resolve: resolveGitCredential };
