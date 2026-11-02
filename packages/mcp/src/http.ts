import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ClientHost, type McpHostOptions } from './host.js';

// The Streamable HTTP host (plan 8). Authentication is a bearer token read
// fresh for every request from `token()`, which is either a stored personal
// token or an OAuth access token the manager refreshes before it expires, so
// a long-lived session keeps working across refreshes.

export interface HttpSpec {
  url: string;
  /** Non-secret headers from the connector config. */
  headers?: Record<string, string>;
  /** The bearer token to send, if any; called before every request. */
  token?: () => Promise<string | undefined> | string | undefined;
  /** Test seam. */
  fetch?: FetchLike;
}

export class HttpHost extends ClientHost {
  readonly transport = 'http' as const;

  constructor(
    private readonly spec: HttpSpec,
    options?: McpHostOptions,
  ) {
    super(options);
  }

  protected createTransport(): Transport {
    const base = this.spec.fetch ?? fetch;
    const authed: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(this.spec.headers ?? {})) {
        if (!headers.has(name)) headers.set(name, value);
      }
      const token = await this.spec.token?.();
      if (token) headers.set('authorization', `Bearer ${token}`);
      return base(url, { ...init, headers });
    };
    return new StreamableHTTPClientTransport(new URL(this.spec.url), { fetch: authed });
  }
}
