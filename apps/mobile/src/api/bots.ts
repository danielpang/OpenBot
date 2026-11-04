import { unwrap, type Client } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';

/** Keep the API envelope in the cache; consumers can select its items for rendering.
 * queryOptions tags the key with the inferred API response type so cache writes
 * cannot accidentally substitute the selected Bot[] for the stored response.
 */
export function botsQueryOptions(api: Client | null) {
  return queryOptions({
    queryKey: ['bots'] as const,
    queryFn: () => fetchBots(api),
  });
}

async function fetchBots(api: Client | null) {
  if (!api) throw new Error('Connect to a server first');
  return unwrap(api.GET('/api/v1/bots'));
}

export type BotsResponse = Awaited<ReturnType<typeof fetchBots>>;
