import { afterEach, describe, expect, it } from 'vitest';
import { HttpHost } from './http.js';
import { DEFAULT_IDLE_MS, McpManager, type ConnectorSession } from './manager.js';
import { startTestHttpServer, type TestHttpServer } from './testing.js';
import type { McpSnapshot, McpTool } from './types.js';

describe('McpManager', () => {
  let server: TestHttpServer | undefined;
  let manager: McpManager | undefined;
  afterEach(async () => {
    await manager?.close();
    await server?.close();
    manager = server = undefined;
  });

  const setup = async (extra: Partial<ConstructorParameters<typeof McpManager>[0]> = {}) => {
    server = await startTestHttpServer();
    const url = server.url;
    let version = 'v1';
    let clock = 0;
    const started: McpSnapshot[] = [];
    const resolves: string[] = [];
    manager = new McpManager({
      resolve: async (id): Promise<ConnectorSession> => {
        resolves.push(id);
        return { id, version, create: (o) => new HttpHost({ url }, o) };
      },
      onStarted: (_id, s) => void started.push(s),
      idleMs: 1000,
      now: () => clock,
      ...extra,
    });
    return {
      started,
      resolves,
      setVersion: (v: string) => (version = v),
      tick: (ms: number) => (clock += ms),
    };
  };

  it('starts lazily, reuses the session, and restarts when the connector changes', async () => {
    const t = await setup();
    expect(manager!.running('c1')).toBe(false);
    const result = await manager!.callTool('c1', 'add', { a: 1, b: 2 });
    expect(result.content).toEqual([{ type: 'text', text: '3' }]);
    expect(t.started).toHaveLength(1);
    expect(t.started[0]!.tools.map((x) => x.name)).toEqual(['add', 'delete_everything']);
    await manager!.callTool('c1', 'add', { a: 1, b: 1 });
    expect(t.started).toHaveLength(1);
    t.setVersion('v2');
    await manager!.callTool('c1', 'add', { a: 1, b: 1 });
    expect(t.started).toHaveLength(2);
  });

  it('stops idle sessions after 10 minutes unless told otherwise', () => {
    const resolve = () => Promise.reject(new Error('unused'));
    expect(DEFAULT_IDLE_MS).toBe(10 * 60_000);
    expect(new McpManager({ resolve }).idleMs).toBe(DEFAULT_IDLE_MS);
    expect(new McpManager({ resolve, idleMs: 5_000 }).idleMs).toBe(5_000);
  });

  it('shares one start between concurrent callers', async () => {
    const t = await setup();
    await Promise.all([manager!.host('c1'), manager!.host('c1'), manager!.host('c1')]);
    expect(t.started).toHaveLength(1);
  });

  it('stops idle sessions in the health loop and pings the rest', async () => {
    const t = await setup();
    await manager!.host('c1');
    t.tick(500);
    await manager!.checkHealth();
    expect(manager!.running('c1')).toBe(true);
    t.tick(600);
    await manager!.checkHealth();
    expect(manager!.running('c1')).toBe(false);
  });

  it('drops a session whose server stopped answering and reports it', async () => {
    const errors: string[] = [];
    await setup({ onError: (id) => void errors.push(id) });
    await manager!.host('c1');
    await server!.close();
    server = undefined;
    await manager!.checkHealth();
    expect(manager!.running('c1')).toBe(false);
    expect(errors).toEqual(['c1']);
  });

  it('reports start failures and refuses what resolve refuses', async () => {
    const errors: string[] = [];
    manager = new McpManager({
      resolve: async (id) => {
        if (id === 'blocked') throw new Error('Disabled by admin');
        return {
          id,
          version: '1',
          create: (o) => new HttpHost({ url: 'http://127.0.0.1:9/mcp' }, o),
        };
      },
      onError: (id) => void errors.push(id),
    });
    await expect(manager.host('blocked')).rejects.toThrow('Disabled by admin');
    await expect(manager.host('down')).rejects.toThrow();
    expect(errors).toEqual(['down']);
  });

  it('passes tools/list_changed through', async () => {
    let changed: McpTool[] | undefined;
    const got = new Promise<void>((resolve) => {
      void setup({
        onToolsChanged: (_id, tools) => {
          changed = tools;
          resolve();
        },
      }).then(async () => {
        await manager!.host('c1');
        await new Promise((r) => setTimeout(r, 100));
        server!.addTool('later');
      });
    });
    await got;
    expect(changed!.map((x) => x.name)).toContain('later');
  });
});
