import { describe, expect, it, vi } from 'vitest';
import {
  connectClient,
  linkHost,
  makeHost,
  Peer,
  prefixed,
  startRelay,
  wsUrl,
} from './test/helpers.js';

describe('client stream', () => {
  it('opens a stream and relays bytes both ways, prefixed on the host side only', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const client = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await client.text()).toEqual({ type: 'open', v: 1 });
    const open = await link.text();
    expect(open).toMatchObject({ type: 'open', stream: expect.any(Number) });
    expect(open.remote).toMatch(/127\.0\.0\.1/);
    const stream = Number(open.stream);

    client.send(Buffer.from('hello host'));
    expect(await link.binary()).toEqual(prefixed(stream, Buffer.from('hello host')));

    link.send(prefixed(stream, Buffer.from('hello client')));
    expect(await client.binary()).toEqual(Buffer.from('hello client'));

    // A full 65,536 byte payload passes in both directions.
    const big = Buffer.alloc(65_536, 7);
    client.send(big);
    expect(await link.binary()).toEqual(prefixed(stream, big));
    link.send(prefixed(stream, big));
    expect(await client.binary()).toEqual(big);
  });

  it('closes the client with the code and reason of the host close', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    link.send({ type: 'close', stream, code: 4000, reason: 'done here' });
    expect(await client.closed).toEqual({ code: 4000, reason: 'done here' });
    // Data for the closed stream is dropped, and the link stays up.
    link.send(prefixed(stream, Buffer.from('late')));
    link.send({ type: 'close', stream, code: 1000, reason: '' });
    const second = await connectClient(relay, host, link);
    expect(second.stream).not.toBe(stream);
  });

  it('tells the host when the client closes', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    client.socket.close(4001, 'bye');
    expect(await link.text()).toEqual({ type: 'close', stream, code: 4001, reason: 'bye' });
  });

  it('closes a client that sends text 4400 and tells the host', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    client.send('{"type":"hello"}');
    expect((await client.closed).code).toBe(4400);
    expect(await link.text()).toMatchObject({ type: 'close', stream, code: 4400 });
  });

  it('shares streams over the links of one host in turn', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const links = [await linkHost(relay, host), await linkHost(relay, host)];
    const order: number[] = [];
    links.forEach((link, index) =>
      link.socket.on('message', (data, isBinary) => {
        if (!isBinary && JSON.parse(String(data)).type === 'open') order.push(index);
      }),
    );
    for (let i = 0; i < 4; i += 1) {
      const client = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
      await client.text();
      await vi.waitFor(() => expect(order).toHaveLength(i + 1));
    }
    expect(order).toEqual([0, 1, 0, 1]);
  });

  it('never opens a stream on a push only link', async () => {
    const relay = await startRelay();
    const host = makeHost();
    await linkHost(relay, host, ['push']);
    const client = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await client.closed).toEqual({ code: 4404, reason: 'host offline' });
  });

  it('closes clients 4410 when their link drops', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, link);
    link.socket.terminate();
    expect(await client.closed).toEqual({ code: 4410, reason: 'host gone' });
  });

  it('closes the ninth stream 4429', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    for (let i = 0; i < 8; i += 1) await connectClient(relay, host, link);
    const ninth = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect((await ninth.closed).code).toBe(4429);
  });

  it('closes 4429 past the opens of the hour', async () => {
    const relay = await startRelay({ limits: { opensPerHour: 2 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    for (let i = 0; i < 2; i += 1) {
      const { client } = await connectClient(relay, host, link);
      client.socket.close();
      await client.closed;
      await link.text();
    }
    const third = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect((await third.closed).code).toBe(4429);
  });

  it('closes 4404 when the host is not linked', async () => {
    const relay = await startRelay();
    const client = await Peer.open(wsUrl(relay, `/v1/connect/${makeHost().hostId}`));
    expect(await client.closed).toEqual({ code: 4404, reason: 'host offline' });
  });

  it('closes 4400 for a malformed host id', async () => {
    const relay = await startRelay();
    const client = await Peer.open(wsUrl(relay, '/v1/connect/NOT-A-HOST'));
    expect((await client.closed).code).toBe(4400);
  });

  it('closes 1009 for a client frame over 65,536 bytes', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    client.send(Buffer.alloc(65_537));
    expect((await client.closed).code).toBe(1009);
    expect(await link.text()).toMatchObject({ type: 'close', stream });
  });

  it('closes the link 1008 past the bytes of the minute', async () => {
    const relay = await startRelay({ limits: { bytesPerMinute: 1_000 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, link);
    client.send(Buffer.alloc(600));
    await link.binary();
    client.send(Buffer.alloc(600));
    expect((await link.closed).code).toBe(1008);
    expect((await client.closed).code).toBe(4410);
  });
});
