import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, helloMessage, hostIdFor, toBase64Url } from './identity.js';
import { hello, linkHost, makeHost, Peer, startRelay, wsUrl } from './test/helpers.js';

describe('host link', () => {
  it('challenges on open and links a host whose hello verifies', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    const challenge = await peer.text();
    expect(challenge).toMatchObject({ type: 'challenge', v: 1 });
    expect(fromBase64Url(String(challenge.nonce))).toHaveLength(32);
    peer.send(hello(host, challenge));
    expect(await peer.text()).toEqual({ type: 'linked', v: 1, hostId: host.hostId });
  });

  it('closes 4401 for a signature that does not verify', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    const challenge = await peer.text();
    // A signature over some other nonce.
    const sig = ed25519.sign(helloMessage(new Uint8Array(32)), host.secretKey);
    peer.send({ ...hello(host, challenge), sig: toBase64Url(sig) });
    expect(await peer.text()).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect((await peer.closed).code).toBe(4401);
  });

  it('closes 4401 for a host id that is not the hash of the key', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const other = makeHost();
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    const challenge = await peer.text();
    peer.send({ ...hello(host, challenge), hostId: other.hostId });
    expect(other.hostId).not.toBe(hostIdFor(host.publicKey));
    expect((await peer.closed).code).toBe(4401);
  });

  it('closes 4400 when no hello comes in time', async () => {
    const relay = await startRelay({ timing: { helloTimeoutMs: 50 } });
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    await peer.text();
    expect(await peer.text()).toMatchObject({ type: 'error', code: 'protocol' });
    expect((await peer.closed).code).toBe(4400);
  });

  it('closes 4400 for a binary frame before linked', async () => {
    const relay = await startRelay();
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    await peer.text();
    peer.send(Buffer.from([0, 0, 0, 1, 42]));
    expect((await peer.closed).code).toBe(4400);
  });

  it('closes 4400 for a malformed hello', async () => {
    const relay = await startRelay();
    const host = makeHost();
    const peer = await Peer.open(wsUrl(relay, '/v1/host'));
    const challenge = await peer.text();
    peer.send({ ...hello(host, challenge), publicKey: 'not base64url!' });
    expect((await peer.closed).code).toBe(4400);
  });

  it('closes 4400 for an unknown frame type once linked', async () => {
    const relay = await startRelay();
    const peer = await linkHost(relay, makeHost());
    peer.send({ type: 'subscribe' });
    expect(await peer.text()).toMatchObject({ type: 'error', code: 'protocol' });
    expect((await peer.closed).code).toBe(4400);
  });

  it('closes 1009 for a binary frame over 65,540 bytes', async () => {
    const relay = await startRelay();
    const peer = await linkHost(relay, makeHost());
    peer.send(Buffer.alloc(65_541));
    expect((await peer.closed).code).toBe(1009);
  });

  it('closes 1009 for a text frame over 64 KiB', async () => {
    const relay = await startRelay();
    const peer = await linkHost(relay, makeHost());
    peer.send(JSON.stringify({ type: 'close', pad: 'x'.repeat(65_536) }));
    expect((await peer.closed).code).toBe(1009);
  });

  it('pings the link and closes 1001 when the pongs stop', async () => {
    const relay = await startRelay({ timing: { pingIntervalMs: 20, pongTimeoutMs: 60 } });
    const peer = await linkHost(relay, makeHost());
    let pings = 0;
    peer.socket.on('ping', () => (pings += 1));
    // ws answers pings by itself; pausing the socket stops it reading them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pings).toBeGreaterThan(0);
    peer.socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 150));
    peer.socket.resume();
    expect((await peer.closed).code).toBe(1001);
  });
});
