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
      const queue = rows;
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (!signal?.aborted) {
            const record = queue.shift();
            if (!record) return;
            try {
              const result = await testConnector(deps, owner, record.row.id, { automatic: true });
              if (result.checked) checked++;
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
