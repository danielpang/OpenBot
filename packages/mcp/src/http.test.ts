import { afterEach, describe, expect, it } from 'vitest';
import { HttpHost } from './http.js';
import { startTestHttpServer, type TestHttpServer } from './testing.js';
import type { McpTool } from './types.js';

describe('HttpHost', () => {
  let server: TestHttpServer | undefined;
  let host: HttpHost | undefined;
  afterEach(async () => {
    await host?.close();
    await server?.close();
    host = server = undefined;
  });

  it('connects over Streamable HTTP with a bearer token, lists and calls tools', async () => {
    server = await startTestHttpServer({ authorize: (a) => a === 'Bearer tok_1' });
    host = new HttpHost({ url: server.url, token: () => 'tok_1', headers: { 'x-extra': 'yes' } });
    const snapshot = await host.start();
    expect(snapshot.tools.map((t) => t.name)).toEqual(['add', 'delete_everything']);
    expect(snapshot.tools[1]!.annotations).toMatchObject({ destructiveHint: true });
    const result = await host.callTool('add', { a: 2, b: 3 });
    expect(result.content).toEqual([{ type: 'text', text: '5' }]);
    expect(server.requests.every((r) => r.authorization === 'Bearer tok_1')).toBe(true);
  });

  it('reads the token before every request, so a refreshed token is used at once', async () => {
    let token = 'old';
    const allowed = new Set(['old']);
    server = await startTestHttpServer({ authorize: (a) => allowed.has(a?.slice(7) ?? '') });
    host = new HttpHost({ url: server.url, token: () => token });
    await host.start();
    allowed.clear();
    allowed.add('new');
    token = 'new';
    await expect(host.listTools()).resolves.toHaveLength(2);
  });

  it('rejects when the server refuses the token', async () => {
    server = await startTestHttpServer({ authorize: () => false });
    host = new HttpHost({ url: server.url, token: () => 'wrong' });
    await expect(host.start()).rejects.toThrow();
  });

  it('refreshes the tool list on tools/list_changed', async () => {
    server = await startTestHttpServer();
    let changed: McpTool[] | undefined;
    const got = new Promise<void>((resolve) => {
      host = new HttpHost(
        { url: server!.url },
        {
          onToolsChanged: (tools) => {
            changed = tools;
            resolve();
          },
        },
      );
    });
    await host!.start();
    // Opens the standalone SSE stream the notification arrives on.
    await new Promise((r) => setTimeout(r, 100));
    server.addTool('fresh');
    await got;
    expect(changed!.map((t) => t.name)).toContain('fresh');
  });
});
