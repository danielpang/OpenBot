import { describe, expect, expectTypeOf, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { botsQueryOptions, type BotsResponse } from './bots';
import type { Bot } from '../screens/data';

describe('Bot query cache contract', () => {
  it('infers the API envelope for both cache readers and updater callbacks', () => {
    const cache = new QueryClient();
    const { queryKey } = botsQueryOptions(null);
    expectTypeOf(cache.getQueryData(queryKey)).toEqualTypeOf<BotsResponse | undefined>();
    expectTypeOf<Bot[]>().not.toMatchTypeOf<BotsResponse>();
    cache.setQueryData(queryKey, (current) => {
      expectTypeOf(current).toEqualTypeOf<BotsResponse | undefined>();
      return { items: [] };
    });
    expect(cache.getQueryData(queryKey)).toEqual({ items: [] });
    cache.clear();
  });
});

// Compile-only regressions: tsc must reject the original mistaken cache writes.
// If these stop producing errors, the @ts-expect-error directives fail typecheck.
function rejectArrayCacheWrites(cache: QueryClient) {
  const { queryKey } = botsQueryOptions(null);
  // @ts-expect-error The cache stores an API response, not the hook's selected array.
  cache.setQueryData(queryKey, [] as Bot[]);
  // @ts-expect-error Updaters must also preserve the response envelope.
  cache.setQueryData(queryKey, (current) => current?.items);
  cache.setQueryData(queryKey, (current) => {
    // @ts-expect-error map belongs to current.items, not the response envelope.
    current?.map((bot: Bot) => bot);
    return current;
  });
}
void rejectArrayCacheWrites;
