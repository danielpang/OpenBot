import type { OAuthTokenSet, SealedSecrets } from '@openbots/mcp';
import type { AppDeps } from '../context.js';
import { decryptSecretString, encryptSecret, keyringFromConfig } from '../secrets.js';
import type { beginGitHubDevice } from './github-device.js';

export type GitHubDeviceState = NonNullable<NonNullable<SealedSecrets['oauth']>['device']>;

/** Both device codes and rotating tokens stay in git_connections.secrets (I17).
 * The existing key-rotation job re-seals this column without interpreting it.
 */
export interface ConnectionSecrets {
  token?: string;
  githubDevice?: {
    clientId: string;
    appSlug: string;
    userId?: string;
    tokens?: OAuthTokenSet;
    /** Reauthorizing must not discard a working connection before success. */
    pending?: {
      device: GitHubDeviceState;
      /** Public instructions are sealed too, so concurrent starts can return the same code. */
      instructions?: Awaited<ReturnType<typeof beginGitHubDevice>>['public'];
      tokens?: OAuthTokenSet;
    };
  };
}

type Deps = Pick<AppDeps, 'config'>;
export function openConnectionSecrets(
  deps: Deps,
  row: { secrets: Uint8Array | null },
): ConnectionSecrets {
  if (!row.secrets) return {};
  return JSON.parse(
    decryptSecretString(row.secrets, keyringFromConfig(deps.config)),
  ) as ConnectionSecrets;
}
export function sealConnectionSecrets(deps: Deps, secrets: ConnectionSecrets): Buffer {
  return encryptSecret(JSON.stringify(secrets), keyringFromConfig(deps.config));
}
