import { eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError } from '../errors.js';
import { decryptSecret, encryptSecret, keyringFromConfig } from '../secrets.js';
import type { GithubAppCredentials, StoredGithubApp } from './github-app-types.js';

// Where the GitHub App's credentials come from (GH1; plan I17). The managed
// service's shared App is `config.githubApp`, set from GITHUB_APP_*. A
// self-hosted install makes its own App through GitHub's manifest flow and
// keeps it in `instance_settings` as one sealed JSON envelope, which master
// key rotation re-seals. Config wins when both exist, so an operator can move
// an install onto env-provided credentials without deleting the row.

export type GithubAppSource = 'config' | 'instance';

export interface LoadedGithubApp {
  app: GithubAppCredentials;
  source: GithubAppSource;
  /** When the App was made through the manifest flow (`instance` only). */
  createdAt?: string;
}

type StoreDeps = Pick<AppDeps, 'db' | 'config'>;

function fromStored(stored: StoredGithubApp): GithubAppCredentials {
  return {
    appId: stored.appId,
    slug: stored.slug,
    privateKey: stored.privateKeyPem,
    webhookSecret: stored.webhookSecret,
    ...(stored.clientId && stored.clientSecret
      ? { clientId: stored.clientId, clientSecret: stored.clientSecret }
      : {}),
  };
}

/** The App this install uses, or null when none is configured or stored. */
export async function loadGithubApp(deps: StoreDeps): Promise<LoadedGithubApp | null> {
  if (deps.config.githubApp) return { app: deps.config.githubApp, source: 'config' };
  const [row] = await deps.db
    .select()
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, schema.INSTANCE_SETTING_GITHUB_APP));
  if (!row) return null;
  const stored = JSON.parse(
    decryptSecret(row.value, keyringFromConfig(deps.config)).toString('utf8'),
  ) as StoredGithubApp;
  return { app: fromStored(stored), source: 'instance', createdAt: stored.createdAt };
}

/** Keeps the App the manifest flow made. Refused while GITHUB_APP_* is set, which would shadow it. */
export async function saveGithubApp(deps: StoreDeps, stored: StoredGithubApp): Promise<void> {
  if (deps.config.githubApp) {
    throw new DomainError(
      409,
      'GITHUB_APP_FROM_CONFIG',
      'This install takes its GitHub App from GITHUB_APP_* in the environment',
    );
  }
  const value = encryptSecret(JSON.stringify(stored), keyringFromConfig(deps.config));
  await deps.db
    .insert(schema.instanceSettings)
    .values({ key: schema.INSTANCE_SETTING_GITHUB_APP, value })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Forgets a stored App (never the configured one). */
export async function clearGithubApp(deps: StoreDeps): Promise<void> {
  await deps.db
    .delete(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, schema.INSTANCE_SETTING_GITHUB_APP));
}
