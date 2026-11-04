import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
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
    const relay = await startRelay({ limits: { addressStreamsPerHost: 8 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    for (let i = 0; i < 8; i += 1) await connectClient(relay, host, link);
    const ninth = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect((await ninth.closed).code).toBe(4429);
  });

  it('closes 4429 past the opens of the hour, counting only streams that carried a payload', async () => {
    const relay = await startRelay({ limits: { opensPerHour: 2 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    // A stream that sends nothing spends none of the host's hour.
    for (let i = 0; i < 3; i += 1) {
      const { client } = await connectClient(relay, host, link);
      client.socket.close();
      await client.closed;
      await link.text();
    }
    for (let i = 0; i < 2; i += 1) {
      const { client, stream } = await connectClient(relay, host, link);
      client.send(Buffer.from('hello'));
      expect(await link.binary()).toEqual(prefixed(stream, Buffer.from('hello')));
      client.socket.close();
      await client.closed;
      await link.text();
    }
    const { client, stream } = await connectClient(relay, host, link);
    client.send(Buffer.from('one too many'));
    expect(await client.closed).toEqual({ code: 4429, reason: 'too many stream opens' });
    // The host hears the close, never the payload.
    expect(await link.text()).toMatchObject({ type: 'close', stream, code: 4429 });
  });

  it('closes a stream that carries no payload in time 4400', async () => {
    const relay = await startRelay({ limits: { firstPayloadMs: 100 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    expect(await client.closed).toEqual({ code: 4400, reason: 'no data in time' });
    expect(await link.text()).toMatchObject({ type: 'close', stream, code: 4400 });
    // One that sends in time stays.
    const second = await connectClient(relay, host, link);
    second.client.send(Buffer.from('x'));
    await link.binary();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(second.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('holds one address to 4 streams of a host and 60 opens a minute', async () => {
    const relay = await startRelay({ limits: { addressOpensPerHostPerMinute: 6 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const open = [];
    for (let i = 0; i < 4; i += 1) open.push(await connectClient(relay, host, link));
    const fifth = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await fifth.closed).toEqual({
      code: 4429,
      reason: 'too many streams from this address',
    });
    // Another host is not affected by this one's slots.
    const other = makeHost();
    const otherLink = await linkHost(relay, other);
    await connectClient(relay, other, otherLink);
    for (const { client } of open.splice(0, 3)) {
      client.socket.close();
      await client.closed;
      await link.text();
    }
    // The refusal at the slots counted nothing: 4 opens so far, 2 more this minute, then 4429.
    for (let i = 0; i < 2; i += 1) await connectClient(relay, host, link);
    const late = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await late.closed).toEqual({
      code: 4429,
      reason: 'too many stream opens from this address',
    });
  });

  it('holds one address to its opens a minute across hosts', async () => {
    const relay = await startRelay({ limits: { addressOpensPerMinute: 2 } });
    const hosts = [makeHost(), makeHost(), makeHost()];
    const links = [];
    for (const host of hosts) links.push(await linkHost(relay, host));
    await connectClient(relay, hosts[0]!, links[0]!);
    await connectClient(relay, hosts[1]!, links[1]!);
    const third = await Peer.open(wsUrl(relay, `/v1/connect/${hosts[2]!.hostId}`));
    expect(await third.closed).toEqual({
      code: 4429,
      reason: 'too many stream opens from this address',
    });
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

  it('closes only the stream, never the link, past the client bytes of the minute', async () => {
    const relay = await startRelay({ limits: { streamBytesPerMinute: 1_000 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    client.send(Buffer.alloc(600));
    await link.binary();
    client.send(Buffer.alloc(600));
    expect(await client.closed).toEqual({ code: 1008, reason: 'byte rate exceeded' });
    expect(await link.text()).toMatchObject({ type: 'close', stream, code: 1008 });
    // The link stays and serves the next phone.
    const next = await connectClient(relay, host, link);
    next.client.send(Buffer.alloc(600));
    expect(await link.binary()).toEqual(prefixed(next.stream, Buffer.alloc(600)));
  });

  it('counts client bytes per address across its streams', async () => {
    const relay = await startRelay({ limits: { addressBytesPerMinute: 1_000 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const one = await connectClient(relay, host, link);
    const two = await connectClient(relay, host, link);
    one.client.send(Buffer.alloc(600));
    await link.binary();
    two.client.send(Buffer.alloc(600));
    expect(await two.client.closed).toEqual({ code: 1008, reason: 'byte rate exceeded' });
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes the stream that carries host bytes past the host minute, and keeps the link', async () => {
    const relay = await startRelay({ limits: { bytesPerMinute: 1_000 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    link.send(prefixed(stream, Buffer.alloc(600)));
    expect(await client.binary()).toEqual(Buffer.alloc(600));
    link.send(prefixed(stream, Buffer.alloc(600)));
    expect(await client.closed).toEqual({ code: 1008, reason: 'byte rate exceeded' });
    expect(await link.text()).toMatchObject({ type: 'close', stream, code: 1008 });
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
  });
});
