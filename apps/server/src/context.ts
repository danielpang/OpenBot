import type { Auth } from './auth.js';
import type { ServerExtensions } from './extensions.js';
import type { NetOptions } from './builtins/net.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Infra } from './infra/index.js';
import type { Logger } from './logger.js';
import type { GithubFetch } from './services/skill-import.js';
import type { Role } from './workspace.js';

/** What the server is built from; `main.ts` makes one, tests make their own. */
export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  logger: Logger;
  /** Job queues and the event bus. */
  infra: Infra;
  /**
   * Exemptions from the outbound request guard for connectors, OAuth and
   * providers (S-8); tests that serve fakes on 127.0.0.1 set it.
   */
  net?: NetOptions;
  /** The GET behind Skill imports from GitHub; tests stand in recorded answers. */
  githubFetch?: GithubFetch;
  /** What the managed build (ee/server) adds; none for self-hosted (plan 21.5). */
  extensions?: ServerExtensions;
}

/** A signed-in caller, with or without an organization; set by `requireAccount`. */
export interface Account {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  /** How the request authenticated. */
  via: 'session' | 'api_key';
  /** The session's id, for a session; null for an API key. */
  sessionId: string | null;
  /**
   * Their membership in the active organization (plan 21.2): the implicit
   * one on a self-hosted install, else the session's active organization
   * or the API key's. Null when there is none, or they are not a member.
   */
  membership: { workspaceId: string; role: Role; suspended: boolean } | null;
}

/** The caller, set by `requireUser`: a member, not suspended, of the active organization. */
export interface CurrentUser extends Omit<Account, 'membership'> {
  /** Their role in the active organization. */
  role: Role;
  /** The active organization (plan 21.2); every query is scoped to it. */
  workspaceId: string;
}

export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    /** Only on routes behind `requireUser` or `requireAdmin`. */
    user: CurrentUser;
    /** Only on routes behind `requireAccount`. */
    account: Account;
  };
}
