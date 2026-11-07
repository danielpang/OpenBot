import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { listConnectors, testConnector } from './connectors.js';

/** Run in one organization's RLS scope. Never launch authorization, test a
 * blocked connector, start a stopped computer, or execute for suspended users.
 * Checks are background work, bounded to three at a time and once per boot.
 */
export async function recheckConnectorsOnBoot(
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<number> {
  const owners = await deps.db
    .selectDistinct({
      id: schema.connectors.ownerId,
      workspaceId: schema.connectors.workspaceId,
    })
    .from(schema.connectors)
    .innerJoin(
      schema.workspaceMembers,
      and(
        eq(schema.workspaceMembers.userId, schema.connectors.ownerId),
        eq(schema.workspaceMembers.workspaceId, schema.connectors.workspaceId),
      ),
    )
    .where(
      and(
        inArray(schema.connectors.kind, ['mcp_http', 'mcp_stdio']),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    );
  let checked = 0;
  for (const owner of owners) {
    if (signal?.aborted) break;
    try {
      const rows = await listConnectors(deps, owner);
      const [computer] =
        deps.config.stdioRunner === 'computer'
          ? await deps.db
              .select({ status: schema.computers.status })
              .from(schema.computers)
              .where(
                and(
                  eq(schema.computers.ownerId, owner.id),
                  eq(schema.computers.workspaceId, owner.workspaceId),
                ),
              )
              .limit(1)
          : [];
      const queue = rows.filter((record) => {
        if (
          record.row.kind === 'builtin' ||
          record.disabledByAdmin ||
          (record.oauth && !record.oauth.connected) ||
          record.secrets.some((secret) => secret.required && !secret.set)
        )
          return false;
        if (
          record.row.kind === 'mcp_stdio' &&
          deps.config.stdioRunner === 'computer' &&
          computer?.status !== 'running'
        )
          return false;
        const config = record.config;
        if (
          config.transport === 'http' &&
          config.auth === 'bearer' &&
          config.bearerSecret &&
          !record.secrets.some((secret) => secret.name === config.bearerSecret && secret.set)
        )
          return false;
        return true;
      });
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (!signal?.aborted) {
            const record = queue.shift();
            if (!record) return;
            try {
              await testConnector(deps, owner, record.row.id);
              checked++;
            } catch {
              deps.logger.warn(
                { connectorId: record.row.id },
                'connector startup check did not complete',
              );
            }
          }
        }),
      );
    } catch {
      deps.logger.warn('connector startup checks skipped an unavailable owner');
    }
  }
  return checked;
}
