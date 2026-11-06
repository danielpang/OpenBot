import type { RemoteRepo } from '@openbots/shared';
import type { GithubAppConfig } from '../config.js';

// The GitHub App service's contract (GH1, GH2, GH7, GH8; I17). Types only:
// services/github-app.ts implements `GithubAppService`, and
// services/git-credentials.ts consumes `GitCredentialScope` and
// `InstallationToken`.
//
// Where the App comes from: the managed service's shared App is
// `config.githubApp` (GITHUB_APP_*). A self-hosted install makes its own App
// through GitHub's manifest flow and stores it, as a `StoredGithubApp`, in
// `instance_settings` under `INSTANCE_SETTING_GITHUB_APP` (db/schema/git.ts),
// one sealed JSON envelope (secrets.ts `encryptSecret`, re-sealed by
// `rotateMasterKey`). `credentials()` reads the config first, then that row.

/** A GitHub App's credentials, whichever source they came from. */
export type GithubAppCredentials = GithubAppConfig;

/** What `instance_settings.github_app` holds, sealed: the App the manifest flow made. */
export interface StoredGithubApp {
  appId: string;
  slug: string;
  /** PEM, as GitHub returned it from the manifest conversion. */
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** ISO time the App was made. */
  createdAt: string;
}

/** A short-lived installation token (one hour), minted with the App's JWT. */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
  /** GitHub's granted permissions, e.g. `{ contents: 'write', metadata: 'read' }`. */
  permissions: Record<string, string>;
  /** Full names the token is narrowed to; absent when it reaches every repository of the installation. */
  repositories?: string[];
}

/** A repository an installation reaches: the picker's row plus GitHub's numeric id. */
export interface InstallationRepo extends RemoteRepo {
  /** GitHub's repository id, as a string. */
  id: string;
}

export type GithubPermissionLevel = 'read' | 'write';

/** What a minted token may reach. */
export interface InstallationTokenScope {
  /** Repository names (`name`, or `owner/name` of the installation's account); absent for all. */
  repositories?: string[];
  /** e.g. `{ contents: 'read' }` for a fetch, `{ contents: 'write', pull_requests: 'write' }` for a push. */
  permissions: Record<string, GithubPermissionLevel>;
}

export interface GithubAppService {
  /** The App to use: `config.githubApp`, else the stored one, else null (no App yet). */
  credentials(): Promise<GithubAppCredentials | null>;
  /**
   * The manifest flow's form for a self-hosted install: the URL to post to
   * (github.com/settings/apps/new, or `organization`'s) and the manifest
   * (name, url, hook_attributes at `GITHUB_APP_WEBHOOK_PATH`, redirect_url,
   * callback_urls, setup_url, permissions, `GITHUB_APP_MANIFEST_EVENTS`).
   */
  manifestUrl(
    state: string,
    options?: { organization?: string },
  ): Promise<{ url: string; manifest: Record<string, unknown> }>;
  /** Exchanges the manifest flow's code for the App and stores it; returns its credentials. 409 when one exists. */
  completeManifest(code: string): Promise<GithubAppCredentials>;
  /** github.com/apps/<slug>/installations/new, carrying `state`. Throws when there is no App. */
  installUrl(state: string): Promise<string>;
  /** Mints a token for one installation, narrowed to `scope`. */
  installationToken(
    installationId: string,
    scope: InstallationTokenScope,
  ): Promise<InstallationToken>;
  /** Every repository the installation reaches, all pages. */
  listInstallationRepos(installationId: string): Promise<InstallationRepo[]>;
  /** HMAC SHA-256 of the raw body with the App's webhook secret, against `X-Hub-Signature-256`, in constant time. */
  verifyWebhook(rawBody: Buffer, signature256: string | undefined): Promise<boolean>;
}

/** What git-credentials.ts asks a token for: one repository, read or write. */
export interface GitCredentialScope {
  /** `owner/name`. */
  repoFullName: string;
  /** A push (contents write); otherwise a fetch or clone (contents read). */
  write: boolean;
}
