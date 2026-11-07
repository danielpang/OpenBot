import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { catalogQuery, connectorsQuery, isMcp, testConnector, type Connector } from './api.js';

// A connector has no tool list until a session has started (2.1), so the page
// runs Test after add, import and a successful OAuth return.

export function useTestConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => testConnector(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['connectors'] }),
  });
}

/** Refreshes the lists after connectors were added, and tests the ones that can be tested now. */
export function useConnectorsAdded() {
  const queryClient = useQueryClient();
  return async (added: readonly Connector[]) => {
    await queryClient.invalidateQueries({ queryKey: ['connectors'] });
    // An OAuth connector cannot answer before its login; Log in tests it on return.
    const testable = added.filter((c) => isMcp(c) && !(c.oauth && !c.oauth.connected));
    await Promise.allSettled(testable.map((c) => testConnector(c.id)));
    if (testable.length) await queryClient.invalidateQueries({ queryKey: ['connectors'] });
  };
}

const bootChecks = new WeakMap<QueryClient, Set<string>>();

/** Refresh stale status when settings opens in a new app/browser session too:
 * the Docker server may have kept running while the Mac app was closed.
 * One attempt per connector per QueryClient, never a refetch/re-render loop.
 */
export function useBootConnectorChecks(items: readonly Connector[] | undefined) {
  const client = useQueryClient();
  const initialClient = useRef<QueryClient | null>(null);
  useEffect(() => {
    if (!items || initialClient.current === client) return;
    initialClient.current = client;
    // New additions/sign-ins already have their own test path. Do not race
    // those with another boot check when the connector list refetches.
    let attempted = bootChecks.get(client);
    if (!attempted) {
      attempted = new Set();
      bootChecks.set(client, attempted);
    }
    const queue = items.filter((connector) => {
      if (attempted.has(connector.id)) return false;
      attempted.add(connector.id);
      return (
        isMcp(connector) &&
        !connector.disabledByAdmin &&
        !(connector.oauth && !connector.oauth.connected) &&
        !connector.secrets.some((secret) => secret.required && !secret.set) &&
        !(connector.auth === 'bearer' && !connector.secrets.some((secret) => secret.set))
      );
    });
    if (!queue.length) return;
    void Promise.allSettled(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let connector = queue.shift(); connector; connector = queue.shift()) {
          try {
            await testConnector(connector.id, true);
          } catch {
            /* The server retains the real failure; do not relabel as connected. */
          }
        }
      }),
    ).then(() => client.invalidateQueries({ queryKey: connectorsQuery.queryKey }));
  }, [items, client]);
}

/** A connector's catalog icon name, for rows that show a connector without its catalog entry. */
export function useCatalogIcon(): (connector: Pick<Connector, 'catalogId'>) => string | undefined {
  // The catalog changes only with a deploy; a row mounting need not refetch it.
  const { data } = useQuery({ ...catalogQuery, staleTime: 5 * 60_000 });
  const icons = new Map(data?.items.map((e) => [e.id, e.icon]));
  return ({ catalogId }) => (catalogId ? icons.get(catalogId) : undefined);
}

/**
 * The owner's connector behind a tool name (`<slug>__<tool>`, plan 5.4) with
 * its catalog icon, for the transcript's activity line; null for other tools.
 */
export function useToolConnector(
  tool: string | undefined,
): { name: string; icon: string | undefined } | null {
  const { data } = useQuery({ ...connectorsQuery, staleTime: 60_000 });
  const iconOf = useCatalogIcon();
  const at = tool?.indexOf('__') ?? -1;
  if (!tool || at <= 0) return null;
  const slug = tool.slice(0, at);
  const connector = data?.items.find((c) => c.slug === slug);
  return connector ? { name: connector.name, icon: iconOf(connector) } : null;
}
