import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { linkHost, makeHost, Peer, startRelay, wsUrl } from './test/helpers.js';

describe('relay', () => {
  it('answers /healthz with 200', async () => {
    const relay = await startRelay();
    const response = await fetch(`${relay.url}/healthz`);
    expect(response.status).toBe(200);
  });

  it('says whether a host is linked', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const presence = async () =>
      (await fetch(`${relay.url}/v1/hosts/${host.hostId}`)).json() as Promise<unknown>;
    expect(await presence()).toEqual({ hostId: host.hostId, linked: false });
    const link = await linkHost(relay, host);
    expect(await presence()).toEqual({ hostId: host.hostId, linked: true });
    link.socket.close();
    await link.closed;
    await vi.waitFor(async () =>
      expect(await presence()).toEqual({ hostId: host.hostId, linked: false }),
    );
  });

  it('asks for the presence token when one is set', async () => {
    const token = 'a-long-enough-presence-token';
    const relay = await startRelay({ presenceToken: token });
    const host = makeHost();
    const url = `${relay.url}/v1/hosts/${host.hostId}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const answered = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ hostId: host.hostId, linked: false });
  });

  it('answers 404 for a malformed host id', async () => {
    const relay = await startRelay();
    expect((await fetch(`${relay.url}/v1/hosts/nope`)).status).toBe(404);
  });

  it('refuses an upgrade on any other path', async () => {
    const relay = await startRelay();
    const socket = new WebSocket(wsUrl(relay, '/v1/elsewhere'));
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      socket.on('error', () => resolve(undefined));
    });
    expect(status).toBe(404);
  });

  it('takes the remote address from the last forwarded hop when it trusts the proxy', async () => {
    const relay = await startRelay({ trustProxy: true });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const client = new Peer(
      new WebSocket(wsUrl(relay, `/v1/connect/${host.hostId}`), {
        headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' },
      }),
    );
    await client.text();
    expect(await link.text()).toMatchObject({ type: 'open', remote: '203.0.113.7' });
  });

  it('closes its links and streams 1001 when it closes', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const link = await linkHost(relay, host);
    const client = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    await client.text();
    await relay.close();
    expect((await client.closed).code).toBe(1001);
    expect((await link.closed).code).toBe(1001);
  });
});
