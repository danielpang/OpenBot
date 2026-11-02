import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ScreenManager } from './screens.js';
import { TEST_TOKEN } from './test-utils.js';
import { attachWebSockets } from './ws.js';

// What a checkout without a C++ toolchain gets: node-pty installed, its
// native binding missing.
vi.mock('node-pty', () => {
  throw new Error('Cannot find module ../build/Release/pty.node');
});

describe('WS /pty without node-pty', () => {
  it('answers 503 instead of crashing', async () => {
    const server = createServer();
    const sockets = attachWebSockets(server, {
      token: TEST_TOKEN,
      home: '/tmp',
      screens: { get: () => undefined } as unknown as ScreenManager,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(503);
    await sockets.close();
    await new Promise((r) => server.close(r));
  });
});
