import type { SearchResult } from '@openbots/agent';

// web_search backends (plan 5.4, T2): Brave Search when the Web search
// connector has a Brave key, else Tavily when it has a Tavily key, else none
// (the tool then answers that search is not configured). The base URLs are
// options so tests can point them at a local fake.

export interface SearchOptions {
  braveUrl?: string;
  tavilyUrl?: string;
}

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const TAVILY_URL = 'https://api.tavily.com/search';

export type SearchBackend = (query: string, limit: number) => Promise<SearchResult[]>;

async function json(res: Response, service: string) {
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${service} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export function braveSearch(key: string, url = BRAVE_URL): SearchBackend {
  return async (query, limit) => {
    const target = new URL(url);
    target.searchParams.set('q', query);
    target.searchParams.set('count', String(limit));
    const body = await json(
      await fetch(target, {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal: AbortSignal.timeout(20_000),
      }),
      'Brave Search',
    );
    const results = ((body.web as { results?: unknown[] } | undefined)?.results ?? []) as {
      title?: string;
      url?: string;
      description?: string;
    }[];
    return results.slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.description ?? '').replace(/<\/?strong>/g, ''),
    }));
  };
}

export function tavilySearch(key: string, url = TAVILY_URL): SearchBackend {
  return async (query, limit) => {
    const body = await json(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: limit }),
        signal: AbortSignal.timeout(20_000),
      }),
      'Tavily',
    );
    const results = (body.results ?? []) as { title?: string; url?: string; content?: string }[];
    return results.slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  };
}

/** The backend for the connector's keys, or null when neither is set. */
export function searchBackend(
  keys: Record<string, string>,
  options: SearchOptions = {},
): SearchBackend | null {
  if (keys.BRAVE_API_KEY) return braveSearch(keys.BRAVE_API_KEY, options.braveUrl);
  if (keys.TAVILY_API_KEY) return tavilySearch(keys.TAVILY_API_KEY, options.tavilyUrl);
  return null;
}
