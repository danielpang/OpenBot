import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalogQuery, connectorsQuery, isMcp, testConnector, type Connector } from './api.js';

// A connector has no tool list until a session has started (2.1), so the page
// runs Test after add, import and a successful OAuth return.

export function useTestConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: testConnector,
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
