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
  /**
   * The relay link (src/relay, docs/RELAY_PROTOCOL.md section 3), in a
   * process that keeps one. `GET /relay` answers from it; without it the
   * relay reads as `off`.
   */
  relay?: RelayLink;
}

/** The relay link (src/relay/link.ts) as the rest of the server uses it. */
export interface RelayLink {
  /** What `GET /relay` answers. */
  status(): RelayStatus;
  /** Checks at once whether to dial: a pairing was just made (services/devices.ts). */
  wake(): void;
  /**
   * Sends one `push` frame (spec 3.3) and resolves its `push.result`.
   * Rejects at once when the link is not linked, and after 15 seconds
   * without an answer.
   */
  push(request: RelayPushRequest): Promise<RelayPushOutcome>;
  /**
   * Calls `handler` each time the link becomes `linked`; returns the way to
   * stop. The push worker catches up on what waits for the owner then.
   */
  onLinked?(handler: () => void): () => void;
  /** Closes the link for good. */
  stop(): Promise<void>;
}

/** A `push` frame less its `type` and `id` (RELAY_PROTOCOL.md 3.3). */
export interface RelayPushRequest {
  platform: 'ios';
  /** The APNs device token, lower case hex. */
  token: string;
  /**
   * The APNs environment the token belongs to (`devices.push_environment`,
   * `production` when unset): the relay picks the APNs host by it.
   */
  environment: 'production' | 'sandbox';
  /** base64url(nonce || ciphertext || tag), section 7. */
  ciphertext: string;
  collapseId?: string;
  priority: 10 | 5;
  /** Unix seconds. */
  expiresAt: number;
  threadId?: string;
}

/** A `push.result` less its `type` and `id`. */
export type RelayPushOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'unregistered' | 'unavailable' | 'invalid' | 'error';
      status: number | null;
    };

export interface RelayStatus {
  hostId: string;
  relayUrl: string | null;
  status: 'off' | 'connecting' | 'linked';
  /** When the status last changed, ISO 8601; null when it never has. */
  since: string | null;
  /**
   * Why the last attempt to link failed, while `connecting`: the socket's
   * error (a relay name that does not resolve, a refused connection) or the
   * close that ended the link before `linked`. Null once linked, and when off.
   */
  error: string | null;
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
  /** The API key's id, for an API key (a device's included); null for a session. */
  apiKeyId: string | null;
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
