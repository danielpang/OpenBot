import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DevToolsBridge } from './devtools.js';

let bridges: DevToolsBridge[] = [];
afterEach(async () => {
  for (const b of bridges) await b.close();
  bridges = [];
});

async function bridge() {
  const fd3 = new PassThrough();
  const fd4 = new PassThrough();
  const b = await DevToolsBridge.listen(fd3, fd4);
  bridges.push(b);
  const commands: string[] = [];
  fd3.on('data', (d: Buffer) => commands.push(d.toString()));
  return { b, fd3, fd4, commands };
}

describe('DevToolsBridge (S-7)', () => {
  it('waits for Chromium to answer its probe and keeps the answer to itself', async () => {
    const { b, fd4, commands } = await bridge();
    const ready = b.ready(2000);
    await new Promise((r) => setImmediate(r));
    expect(commands).toEqual([`{"id":${2 ** 31 - 1},"method":"Browser.getVersion"}\0`]);

    const { url, headers } = b.endpoint();
    const ws = new WebSocket(url, { headers });
    await new Promise((r) => ws.once('open', r));
    const received: string[] = [];
    ws.on('message', (d) => received.push(String(d)));
    // Two messages in one write, the probe's answer first.
    fd4.write(`{"id":${2 ** 31 - 1},"result":{"product":"Chrome"}}\0{"method":"Target.x"}\0`);
    await ready;
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(['{"method":"Target.x"}']);
    ws.close();
  });

  it('times out when Chromium does not answer', async () => {
    const { b } = await bridge();
    await expect(b.ready(50)).rejects.toThrow('Timed out waiting for Chromium');
  });

  it('listens on a loopback port the kernel picked, behind the secret', async () => {
    const { b } = await bridge();
    const { url, headers } = b.endpoint();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser$/);
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(401);
    expect(headers.authorization).toMatch(/^Bearer [\w-]{43}$/);
  });

  it('closes when Chromium goes away, and stops listening', async () => {
    const { b, fd4 } = await bridge();
    const { url, headers } = b.endpoint();
    const ws = new WebSocket(url, { headers });
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    fd4.destroy();
    expect(await closed).toBe(1001);
    await new Promise((r) => setTimeout(r, 20));
    await expect(fetch(url.replace('ws:', 'http:'))).rejects.toThrow();
  });
});
