import type { SearchFilters, SearchFreshness, SearchResult } from '@openbots/agent';

// web_search and news_search backends (plan 5.4, T2). The Web search
// connector holds up to three keys and the first one set is used: Brave
// Search, then Tavily, then Exa. With none, both tools answer that search is
// not configured. Every provider is a fixed public API host, so nothing here
// goes near the owner's network. The base URLs are options so tests can point
// them at a local fake.

export interface SearchOptions {
  braveUrl?: string;
  braveNewsUrl?: string;
  tavilyUrl?: string;
  exaUrl?: string;
  /** The clock Exa's date window is measured from; tests fix it. */
  now?: () => Date;
}

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_NEWS_URL = 'https://api.search.brave.com/res/v1/news/search';
export const TAVILY_URL = 'https://api.tavily.com/search';
export const EXA_URL = 'https://api.exa.ai/search';

export type SearchBackend = (
  query: string,
  limit: number,
  filters?: SearchFilters,
) => Promise<SearchResult[]>;

/** The web and news searches of one provider. */
export interface SearchBackends {
  provider: 'brave' | 'tavily' | 'exa';
  web: SearchBackend;
  news: SearchBackend;
}

const TIMEOUT_MS = 20_000;

async function json(res: Response, service: string) {
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${service} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Whether `url` is on one of `domains` or a subdomain of one. */
export function onDomains(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/**
 * The results a provider returned, held to the domains asked for (a
 * provider's own filter is a hint for some, so it is checked here as well)
 * and cut to the limit. Empty fields are dropped.
 */
function finish(results: SearchResult[], limit: number, filters: SearchFilters = {}) {
  const domains = filters.domains?.length ? filters.domains : null;
  return results
    .filter((r) => r.url && (!domains || onDomains(r.url, domains)))
    .slice(0, limit)
    .map((r) => {
      const out: SearchResult = { title: r.title, url: r.url, snippet: r.snippet };
      if (r.published) out.published = r.published;
      if (r.source) out.source = r.source;
      return out;
    });
}

const stripTags = (text: string) => text.replace(/<\/?strong>/g, '');

// Brave Search: GET with the key in `x-subscription-token`. `freshness` takes
// pd, pw, pm or py; domains go into the query as `site:` operators.
const BRAVE_FRESHNESS: Record<SearchFreshness, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

function braveQuery(query: string, domains?: string[]) {
  if (!domains?.length) return query;
  return `${query} ${domains.map((d) => `site:${d}`).join(' OR ')}`;
}

function brave(key: string, url: string, kind: 'web' | 'news'): SearchBackend {
  return async (query, limit, filters = {}) => {
    const target = new URL(url);
    target.searchParams.set('q', braveQuery(query, filters.domains));
    target.searchParams.set('count', String(limit));
    if (filters.freshness) target.searchParams.set('freshness', BRAVE_FRESHNESS[filters.freshness]);
    const body = await json(
      await fetch(target, {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'Brave Search',
    );
    // The web endpoint nests its results under `web`; the news endpoint does not.
    const list = (
      kind === 'web' ? (body.web as { results?: unknown[] } | undefined)?.results : body.results
    ) as Record<string, unknown>[] | undefined;
    const results = (list ?? []).map((r) => {
      const link = str(r.url) ?? '';
      const meta = r.meta_url as { hostname?: unknown } | undefined;
      return {
        title: stripTags(str(r.title) ?? ''),
        url: link,
        snippet: stripTags(str(r.description) ?? ''),
        published: str(r.page_age) ?? str(r.age),
        source: kind === 'news' ? (str(meta?.hostname) ?? hostOf(link)) : undefined,
      };
    });
    return finish(results, limit, filters);
  };
}

export function braveSearch(key: string, url = BRAVE_URL): SearchBackend {
  return brave(key, url, 'web');
}

export function braveNews(key: string, url = BRAVE_NEWS_URL): SearchBackend {
  return brave(key, url, 'news');
}

// Tavily: POST with a bearer key. `time_range` takes day, week, month or
// year, `include_domains` a list, and `topic: "news"` searches news sources
// and adds each article's `published_date`.
function tavily(key: string, url: string, kind: 'web' | 'news'): SearchBackend {
  return async (query, limit, filters = {}) => {
    const body = await json(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query,
          max_results: limit,
          ...(kind === 'news' ? { topic: 'news' } : {}),
          ...(filters.freshness ? { time_range: filters.freshness } : {}),
          ...(filters.domains?.length ? { include_domains: filters.domains } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'Tavily',
    );
    const results = ((body.results ?? []) as Record<string, unknown>[]).map((r) => {
      const link = str(r.url) ?? '';
      return {
        title: str(r.title) ?? '',
        url: link,
        snippet: str(r.content) ?? '',
        published: str(r.published_date),
        source: kind === 'news' ? hostOf(link) : undefined,
      };
    });
    return finish(results, limit, filters);
  };
}

export function tavilySearch(key: string, url = TAVILY_URL): SearchBackend {
  return tavily(key, url, 'web');
}

export function tavilyNews(key: string, url = TAVILY_URL): SearchBackend {
  return tavily(key, url, 'news');
}

// Exa: POST with the key in `x-api-key`. Freshness becomes a
// `startPublishedDate`; `category: "news"` steers a news search; highlights
// are the snippets.
const FRESHNESS_DAYS: Record<SearchFreshness, number> = { day: 1, week: 7, month: 31, year: 366 };

function exa(key: string, url: string, kind: 'web' | 'news', now: () => Date): SearchBackend {
  return async (query, limit, filters = {}) => {
    const since = filters.freshness
      ? new Date(now().getTime() - FRESHNESS_DAYS[filters.freshness] * 86_400_000).toISOString()
      : undefined;
    const body = await json(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          query,
          numResults: limit,
          contents: { highlights: true },
          ...(kind === 'news' ? { category: 'news' } : {}),
          ...(since ? { startPublishedDate: since } : {}),
          ...(filters.domains?.length ? { includeDomains: filters.domains } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'Exa',
    );
    const results = ((body.results ?? []) as Record<string, unknown>[]).map((r) => {
      const link = str(r.url) ?? '';
      const highlights = Array.isArray(r.highlights)
        ? r.highlights.filter((h): h is string => typeof h === 'string')
        : [];
      return {
        title: str(r.title) ?? '',
        url: link,
        snippet: highlights.length ? highlights.join(' … ') : (str(r.text) ?? '').slice(0, 400),
        published: str(r.publishedDate),
        source: kind === 'news' ? hostOf(link) : undefined,
      };
    });
    return finish(results, limit, filters);
  };
}

export function exaSearch(key: string, url = EXA_URL, now = () => new Date()): SearchBackend {
  return exa(key, url, 'web', now);
}

export function exaNews(key: string, url = EXA_URL, now = () => new Date()): SearchBackend {
  return exa(key, url, 'news', now);
}

/** The searches for the connector's keys (Brave, then Tavily, then Exa), or null with none. */
export function searchBackends(
  keys: Record<string, string>,
  options: SearchOptions = {},
): SearchBackends | null {
  if (keys.BRAVE_API_KEY) {
    return {
      provider: 'brave',
      web: braveSearch(keys.BRAVE_API_KEY, options.braveUrl),
      news: braveNews(keys.BRAVE_API_KEY, options.braveNewsUrl),
    };
  }
  if (keys.TAVILY_API_KEY) {
    return {
      provider: 'tavily',
      web: tavilySearch(keys.TAVILY_API_KEY, options.tavilyUrl),
      news: tavilyNews(keys.TAVILY_API_KEY, options.tavilyUrl),
    };
  }
  if (keys.EXA_API_KEY) {
    return {
      provider: 'exa',
      web: exaSearch(keys.EXA_API_KEY, options.exaUrl, options.now),
      news: exaNews(keys.EXA_API_KEY, options.exaUrl, options.now),
    };
  }
  return null;
}

/** The web search for the connector's keys, or null when none is set. */
export function searchBackend(
  keys: Record<string, string>,
  options: SearchOptions = {},
): SearchBackend | null {
  return searchBackends(keys, options)?.web ?? null;
}
