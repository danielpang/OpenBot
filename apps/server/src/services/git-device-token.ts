import { needsRefresh } from '@openbots/mcp';
import { and, eq } from 'drizzle-orm';
import { netFetch } from '../builtins/net.js';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { openConnectionSecrets, sealConnectionSecrets } from './git-connection-secrets.js';
import { refreshGitHubDevice } from './github-device.js';
import type { ConnectionRow } from './git-connections.js';

type Deps = Pick<AppDeps, 'db' | 'config'> & Partial<Pick<AppDeps, 'net'>>;
const reconnect = () =>
  new DomainError(
    409,
    'GITHUB_DEVICE_REAUTHORIZE',
    'Reconnect this GitHub App connection to renew its authorization.',
  );

/** A rotating refresh token is single-use. Serialize against refresh, sync,
 * reconnect and disconnect across processes, not only inside this server.
 * Reload the row rather than using the caller's (possibly stale) token.
 * The caller must still enforce repo access and the push-approval boundary.
 */
export async function deviceAuthorization(deps: Deps, connection: ConnectionRow) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.gitConnections)
      .where(
        and(
          eq(schema.gitConnections.id, connection.id),
          eq(schema.gitConnections.ownerId, connection.ownerId),
          eq(schema.gitConnections.workspaceId, connection.workspaceId),
        ),
      )
      .for('update');
    if (!row) throw notFound('Git connection not found');
    const secrets = openConnectionSecrets(deps, row);
    const auth = secrets.githubDevice;
    if (row.kind !== 'device' || !auth?.tokens || !auth.userId) throw reconnect();
    if (needsRefresh(auth.tokens)) {
      try {
        auth.tokens = await refreshGitHubDevice(auth.clientId, auth.tokens, netFetch(deps.net));
      } catch {
        // Never echo a provider exception/body: it can include a token.
        throw reconnect();
      }
      row.secrets = sealConnectionSecrets(deps, secrets);
      await tx
        .update(schema.gitConnections)
        .set({ secrets: row.secrets, updatedAt: new Date() })
        .where(eq(schema.gitConnections.id, row.id));
    }
    return { row, token: auth.tokens.access_token, appSlug: auth.appSlug };
  });
}
