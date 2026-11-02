import { unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// Connectors (T1 to T3): the catalog, the owner's connectors, their tools,
// the admin block and allow lists, trusted hints, the local mark and the per-Bot permissions. Secrets are write-only
// (P3): responses say which are set and never carry a value.

export type CatalogEntry = components['schemas']['ConnectorCatalogEntry'];
export type Connector = components['schemas']['Connector'];
export type ConnectorTool = components['schemas']['ConnectorTool'];
export type CreateConnector = components['schemas']['CreateConnector'];
export type UpdateConnector = components['schemas']['UpdateConnector'];
export type ConnectorPolicy = components['schemas']['ConnectorPolicy'];
export type ConnectorPolicyInput = components['schemas']['ConnectorPolicyInput'];
export type BotConnector = components['schemas']['BotConnector'];
export type BotConnectorPermission = components['schemas']['BotConnectorPermission'];
export type BotTool = components['schemas']['BotTool'];

export const catalogQuery = queryOptions({
  queryKey: ['connectors', 'catalog'],
  queryFn: () => unwrap(api.GET('/api/v1/connectors/catalog')),
});

export const connectorsQuery = queryOptions({
  queryKey: ['connectors', 'list'],
  queryFn: () => unwrap(api.GET('/api/v1/connectors')),
});

export const connectorToolsQuery = (id: string) =>
  queryOptions({
    queryKey: ['connectors', 'tools', id],
    queryFn: () => unwrap(api.GET('/api/v1/connectors/{id}/tools', { params: { path: { id } } })),
  });

export const connectorPolicyQuery = queryOptions({
  queryKey: ['connector-policy'],
  queryFn: () => unwrap(api.GET('/api/v1/connector-policy')),
});

export const botConnectorsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['bot-connectors', botId],
    queryFn: () =>
      unwrap(api.GET('/api/v1/bots/{id}/connectors', { params: { path: { id: botId } } })),
  });

/** Every tool the Bot can have, with the policy engine's default for each (T5). */
export const botToolsQuery = (botId: string) =>
  queryOptions({
    // Under `connectors`, so a connector's new tool list refreshes it too.
    queryKey: ['connectors', 'bot-tools', botId],
    queryFn: () => unwrap(api.GET('/api/v1/bots/{id}/tools', { params: { path: { id: botId } } })),
  });

export const createConnector = (body: CreateConnector) =>
  unwrap(api.POST('/api/v1/connectors', { body }));

export const importConnectors = (mcpServers: Record<string, unknown>) =>
  unwrap(api.POST('/api/v1/connectors/import', { body: { mcpServers } }));

export const updateConnector = (id: string, body: UpdateConnector) =>
  unwrap(api.PATCH('/api/v1/connectors/{id}', { params: { path: { id } }, body }));

export const deleteConnector = (id: string) =>
  unwrap(api.DELETE('/api/v1/connectors/{id}', { params: { path: { id } } }));

export const testConnector = (id: string) =>
  unwrap(api.POST('/api/v1/connectors/{id}/test', { params: { path: { id } } }));

/** Where the sign-in page opens: a popup of this page, or the Mac app's default browser. */
export type OAuthMode = 'popup' | 'external';

export const startOAuth = (id: string, mode: OAuthMode) =>
  unwrap(
    api.GET('/api/v1/connectors/{id}/oauth/start', {
      params: { path: { id }, query: { mode } },
    }),
  );

export type ConnectorDiscovery = components['schemas']['ConnectorDiscovery'];

/** How a pasted URL signs in, before anything is added. */
export const discoverConnector = (url: string) =>
  unwrap(api.POST('/api/v1/connectors/discover', { body: { url } }));

export const discoverQuery = (url: string) =>
  queryOptions({
    queryKey: ['connector-discover', url],
    queryFn: () => discoverConnector(url),
    staleTime: 60_000,
    retry: false,
  });

export const setConnectorTrusted = (id: string, trusted: boolean) =>
  unwrap(
    api.PUT('/api/v1/connectors/{id}/trusted', { params: { path: { id } }, body: { trusted } }),
  );

export const setConnectorLocal = (id: string, local: boolean) =>
  unwrap(api.PUT('/api/v1/connectors/{id}/local', { params: { path: { id } }, body: { local } }));

export const putConnectorPolicy = (body: ConnectorPolicyInput) =>
  unwrap(api.PUT('/api/v1/connector-policy', { body }));

export const putBotConnectors = (botId: string, items: BotConnectorPermission[]) =>
  unwrap(
    api.PUT('/api/v1/bots/{id}/connectors', { params: { path: { id: botId } }, body: { items } }),
  );

/** Built-ins have no MCP session to test; everything else does. */
export const isMcp = (connector: Pick<Connector, 'kind'>) => connector.kind !== 'builtin';
