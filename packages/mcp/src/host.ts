import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PACKAGE_NAME } from './name.js';
import type { McpPrompt, McpResource, McpSnapshot, McpTool } from './types.js';

// One MCP session (plan 8). `McpHost` is the seam the manager talks to; the
// stdio and Streamable HTTP hosts differ only in how they build the transport,
// and the post-1.0 `openbots-mcp-runner` container will be a third host behind
// the same interface.

export type ToolCallResult = CallToolResult;

export interface McpHostOptions {
  /** Called with the fresh list after the server sends `notifications/tools/list_changed`. */
  onToolsChanged?(tools: McpTool[]): void;
  /** Called once when the session ends for any reason other than `close()`. */
  onClose?(error?: Error): void;
  /** Per-request timeout; the SDK default is 60 s. */
  requestTimeoutMs?: number;
}

export interface McpHost {
  readonly transport: 'stdio' | 'http';
  /** Connects, initializes and lists tools, resources and prompts. */
  start(): Promise<McpSnapshot>;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolCallResult>;
  /** Throws when the server does not answer. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export abstract class ClientHost implements McpHost {
  abstract readonly transport: 'stdio' | 'http';
  protected client: Client | undefined;
  private closing = false;

  constructor(protected readonly options: McpHostOptions = {}) {}

  protected abstract createTransport(): Promise<Transport> | Transport;

  async start(): Promise<McpSnapshot> {
    if (this.client) throw new Error('MCP session already started');
    const client = new Client(
      { name: PACKAGE_NAME, version: '0.0.0' },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => {
              // Paginated re-list rather than the SDK's single page.
              this.listTools().then(
                (tools) => this.options.onToolsChanged?.(tools),
                () => {},
              );
            },
          },
        },
      },
    );
    client.onclose = () => {
      const wasOpen = this.client === client && !this.closing;
      this.client = undefined;
      if (wasOpen) this.options.onClose?.();
    };
    this.client = client;
    try {
      await client.connect(await this.createTransport(), this.requestOptions());
    } catch (err) {
      this.client = undefined;
      await client.close().catch(() => {});
      throw err;
    }
    const caps = client.getServerCapabilities() ?? {};
    const server = client.getServerVersion();
    const [tools, resources, prompts] = await Promise.all([
      caps.tools ? this.listTools() : Promise.resolve([]),
      caps.resources ? this.listResources() : Promise.resolve([]),
      caps.prompts ? this.listPrompts() : Promise.resolve([]),
    ]);
    return {
      server: server ? { name: server.name, version: server.version } : null,
      tools,
      resources,
      prompts,
    };
  }

  async listTools(): Promise<McpTool[]> {
    const client = this.connected();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, this.requestOptions());
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          ...(t.title
            ? { title: t.title }
            : t.annotations?.title
              ? { title: t.annotations.title }
              : {}),
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations ? { annotations: { ...t.annotations } } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  protected async listResources(): Promise<McpResource[]> {
    const client = this.connected();
    const out: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listResources(cursor ? { cursor } : {}, this.requestOptions());
      for (const r of page.resources) {
        out.push({
          uri: r.uri,
          name: r.name,
          ...(r.title ? { title: r.title } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  protected async listPrompts(): Promise<McpPrompt[]> {
    const client = this.connected();
    const out: McpPrompt[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listPrompts(cursor ? { cursor } : {}, this.requestOptions());
      for (const p of page.prompts) {
        out.push({
          name: p.name,
          ...(p.title ? { title: p.title } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments ? { arguments: p.arguments } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolCallResult> {
    const result = await this.connected().callTool({ name, arguments: args }, undefined, {
      ...this.requestOptions(),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return result as ToolCallResult;
  }

  async ping(): Promise<void> {
    await this.connected().ping(this.requestOptions());
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.closing = true;
    try {
      await client.close();
    } finally {
      this.client = undefined;
      this.closing = false;
    }
  }

  private connected(): Client {
    if (!this.client) throw new Error('MCP session is not running');
    return this.client;
  }

  private requestOptions() {
    return this.options.requestTimeoutMs ? { timeout: this.options.requestTimeoutMs } : undefined;
  }
}
