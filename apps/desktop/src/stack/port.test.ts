import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort, nodePortFree, PORT_SEARCH_LIMIT } from './port.js';

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('findFreePort', () => {
  it('tries 3000 first, then the next ones, skipping the ones asked to', async () => {
    const taken = new Set([3000, 3001]);
    const tried: number[] = [];
    const isFree = async (port: number) => {
      tried.push(port);
      return !taken.has(port);
    };
    expect(await findFreePort(isFree)).toBe(3002);
    expect(tried).toEqual([3000, 3001, 3002]);
    expect(await findFreePort(async () => true, [3000])).toBe(3001);
  });

  it('gives up after the search limit', async () => {
    const tried: number[] = [];
    const none = async (port: number) => {
      tried.push(port);
      return false;
    };
    expect(await findFreePort(none)).toBeNull();
    expect(tried).toHaveLength(PORT_SEARCH_LIMIT);
    expect(tried.at(-1)).toBe(3099);
  });
});

describe('nodePortFree', () => {
  it('sees a port held on localhost only, or on every address', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const { server, port } = await listen(host);
      try {
        expect(await nodePortFree(port)).toBe(false);
      } finally {
        await close(server);
      }
      expect(await nodePortFree(port)).toBe(true);
    }
  });
});
