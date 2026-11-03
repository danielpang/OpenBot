import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryRegistry } from './registry.js';
import { FlyProxy } from './test/fly-proxy.js';
import {
  connectClient,
  hostPath,
  linkHost,
  makeHost,
  Peer,
  prefixed,
  startRelay,
  wsUrl,
  type Frame,
} from './test/helpers.js';

// Each machine on its own, wired into the relay (MOBILE_AND_VM_PLAN.md 5.8):
// flow control and shedding between real sockets, the byte budget and the
// socket ceiling, the drain on SIGTERM inside a cluster, and the metrics
// token. The modules have their own unit tests; these check the wiring.

const CLUSTER = { leaseMs: 600, renewMs: 150, nodeTtlMs: 300, heartbeatMs: 75 };
const KiB = 1024;
const FRAME = 64 * KiB;

/** Every frame `peer` receives from now on, without consuming its queue. */
function watch(peer: Peer): Frame[] {
  const seen: Frame[] = [];
  peer.socket.on('message', (data, isBinary) => {
    const buffer = data as Buffer;
    seen.push(
      isBinary
        ? { binary: Buffer.from(buffer) }
        : { text: JSON.parse(buffer.toString('utf8')) as Record<string, unknown> },
    );
  });
  return seen;
}

async function upgradeStatus(url: string): Promise<number | undefined> {
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.on('open', () => {
      socket.terminate();
      resolve(101);
    });
    socket.on('error', () => resolve(undefined));
  });
}

describe('flow control in the relay', () => {
  it('sheds a slow phone with 1013 after the deadline without pausing the link for others', async () => {
    const relay = await startRelay({
      flow: {
        highWaterBytes: 128 * KiB,
        lowWaterBytes: 32 * KiB,
        sourceHighWaterBytes: 64 * KiB,
        sourceLowWaterBytes: 16 * KiB,
        deliveryTimeoutMs: 300,
        sweepIntervalMs: 25,
      },
      limits: { maxBufferedBytes: 256 * 1024 * 1024, bytesPerMinute: 1_000_000_000 },
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const slow = await connectClient(relay, host, link);
    const fast = await connectClient(relay, host, link);
    const toHost = watch(link);

    slow.client.socket.pause();
    // Far more than the loopback buffers take, so the relay holds the rest.
    for (let i = 0; i < 400; i += 1) link.send(prefixed(slow.stream, Buffer.alloc(FRAME, i)));
    await vi.waitFor(() => expect(relay.flow.blockedDestinations).toBeGreaterThan(0), {
      timeout: 5_000,
    });

    // The link is not paused for one slow phone: the other phone still gets its bytes.
    link.send(prefixed(fast.stream, Buffer.from('still here')));
    expect(await fast.client.binary()).toEqual(Buffer.from('still here'));

    await vi.waitFor(
      () =>
        expect(toHost).toContainEqual({
          text: { type: 'close', stream: slow.stream, code: 1013, reason: 'too slow' },
        }),
      { timeout: 5_000 },
    );
    expect(relay.flow.shed).toBe(1);
    slow.client.socket.resume();
    expect((await slow.client.closed).code).toBe(1013);
    expect(await relay.metrics.render()).toMatch(
      /openbots_relay_shed_peers_total\{kind="client"\} 1/,
    );
  }, 15_000);

  it('pauses a phone that sends faster than its host link reads', async () => {
    const relay = await startRelay({
      flow: {
        highWaterBytes: 128 * KiB,
        lowWaterBytes: 32 * KiB,
        sourceHighWaterBytes: 64 * KiB,
        sourceLowWaterBytes: 16 * KiB,
        deliveryTimeoutMs: 60_000,
      },
      limits: { maxBufferedBytes: 256 * 1024 * 1024, bytesPerMinute: 1_000_000_000 },
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    const received = watch(link);

    link.socket.pause();
    const total = 400;
    for (let i = 0; i < total; i += 1) client.send(Buffer.alloc(FRAME, i % 256));
    await vi.waitFor(() => expect(relay.flow.pausedSources).toBe(1), { timeout: 5_000 });

    // Once the host reads again, the phone resumes and every byte arrives.
    link.socket.resume();
    await vi.waitFor(
      () => expect(received.filter((frame) => 'binary' in frame)).toHaveLength(total),
      { timeout: 10_000 },
    );
    const first = received.find((frame) => 'binary' in frame) as { binary: Buffer };
    expect(first.binary.readUInt32BE(0)).toBe(stream);
    expect(relay.flow.pausedSources).toBe(0);
  }, 20_000);
});

describe('the machine budget in the relay', () => {
  it('past the socket ceiling refuses new hosts with 503 but admits owned ones up to the hard ceiling', async () => {
    // A ceiling of 10 has a hard ceiling of 11.
    const relay = await startRelay({ budget: { maxSockets: 10 } });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const other = makeHost();
    const otherLink = await linkHost(relay, other);
    for (let i = 0; i < 4; i += 1) await connectClient(relay, host, link);
    for (let i = 0; i < 4; i += 1) await connectClient(relay, other, otherLink);
    expect(relay.budget.full).toBe(true);
    expect((await fetch(`${relay.url}/ready`)).status).toBe(503);
    // A host this machine does not serve goes elsewhere.
    expect(await upgradeStatus(wsUrl(relay, hostPath(makeHost())))).toBe(503);
    expect(await upgradeStatus(wsUrl(relay, `/v1/connect/${makeHost().hostId}`))).toBe(503);
    // An owned host still gets its link and its phone, which no other machine can serve.
    const third = await linkHost(relay, host);
    expect(relay.budget.sockets).toBe(11);
    // At the hard ceiling nothing is admitted.
    expect(await upgradeStatus(wsUrl(relay, `/v1/connect/${host.hostId}`))).toBe(503);
    third.socket.close();
    await third.closed;
    await vi.waitFor(() => expect(relay.budget.sockets).toBe(10));
    expect(await upgradeStatus(wsUrl(relay, `/v1/connect/${host.hostId}`))).toBe(101);
    expect(await relay.metrics.render()).toMatch(
      /openbots_relay_rejections_total\{reason="sockets"\} 3/,
    );
  });

  it('closes a stream that would pass the byte budget with 1013, and keeps the link', async () => {
    const relay = await startRelay({
      // The whole budget for one host here; the host share has its own test.
      budget: { maxBytes: 1024 * KiB, hostShare: 1 },
      // Flow control would pause the phone long before; here it must not.
      flow: {
        highWaterBytes: 512 * 1024 * 1024,
        lowWaterBytes: 1024,
        sourceHighWaterBytes: 512 * 1024 * 1024,
        sourceLowWaterBytes: 1024,
      },
      limits: { maxBufferedBytes: 512 * 1024 * 1024, bytesPerMinute: 1_000_000_000 },
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, link);
    const toHost = watch(link);

    link.socket.pause();
    for (let i = 0; i < 400; i += 1) client.send(Buffer.alloc(FRAME, 1));
    expect(await client.closed).toEqual({ code: 1013, reason: 'relay busy' });
    link.socket.resume();
    await vi.waitFor(
      () =>
        expect(toHost).toContainEqual({
          text: { type: 'close', stream, code: 1013, reason: 'relay busy' },
        }),
      { timeout: 10_000 },
    );
    // The shared link stays up and serves the next phone.
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(relay.budget.bytesInFlight).toBe(0));
    const next = await Peer.open(wsUrl(relay, `/v1/connect/${host.hostId}`));
    expect(await next.text()).toEqual({ type: 'open', v: 1 });
    expect(await relay.metrics.render()).toMatch(
      /openbots_relay_rejections_total\{reason="bytes"\} 1/,
    );
  }, 20_000);
});

describe('the host share of the budget in the relay', () => {
  it('refuses one host at its share while another host gets its full share and serves', async () => {
    const relay = await startRelay({
      budget: { maxBytes: 4 * 1024 * KiB, hostShare: 0.125 },
      flow: {
        highWaterBytes: 512 * 1024 * 1024,
        lowWaterBytes: 1024,
        sourceHighWaterBytes: 512 * 1024 * 1024,
        sourceLowWaterBytes: 1024,
      },
      limits: { maxBufferedBytes: 512 * 1024 * 1024, bytesPerMinute: 1_000_000_000 },
    });
    const share = relay.budget.hostMaxBytes;
    expect(share).toBe(512 * KiB);
    const [a, b] = [makeHost(), makeHost()];
    const linkA = await linkHost(relay, a);
    const linkB = await linkHost(relay, b);
    const phoneA = await connectClient(relay, a, linkA);
    const phoneB = await connectClient(relay, b, linkB);
    const toB = watch(linkB);

    // Host a's server stops reading; its phone floods: a is held to its share.
    linkA.socket.pause();
    for (let i = 0; i < 200; i += 1) phoneA.client.send(Buffer.alloc(FRAME, 1));
    expect(await phoneA.client.closed).toEqual({ code: 1013, reason: 'relay busy' });
    expect(relay.budget.hostBytes(a.hostId)).toBeLessThanOrEqual(share);
    expect(relay.budget.bytesInFlight).toBeLessThan(relay.budget.options.maxBytes);

    // Host b, on the same machine, still gets all of its own share.
    linkB.socket.pause();
    for (let i = 0; i < 200; i += 1) phoneB.client.send(Buffer.alloc(FRAME, 2));
    expect((await phoneB.client.closed).code).toBe(1013);
    expect(relay.budget.hostBytes(b.hostId)).toBeGreaterThan(share - FRAME - 64);
    expect(relay.budget.hostBytes(a.hostId)).toBeGreaterThan(0);
    expect(await relay.metrics.render()).toMatch(
      /openbots_relay_rejections_total\{reason="host_share"\} 2/,
    );
    expect(await relay.metrics.render()).toMatch(/openbots_relay_budget_host_bytes_max \d+/);

    // Once b's server reads again its share comes back, and b serves traffic.
    linkB.socket.resume();
    await vi.waitFor(() => expect(relay.budget.hostBytes(b.hostId)).toBe(0), { timeout: 10_000 });
    const next = await Peer.open(wsUrl(relay, `/v1/connect/${b.hostId}`));
    expect(await next.text()).toEqual({ type: 'open', v: 1 });
    next.send(Buffer.from('b again'));
    await vi.waitFor(() =>
      expect(
        toB.some(
          (frame) => 'binary' in frame && frame.binary.subarray(4).equals(Buffer.from('b again')),
        ),
      ).toBe(true),
    );
    linkA.socket.resume();
    await vi.waitFor(() => expect(relay.budget.hostBytes(a.hostId)).toBe(0), { timeout: 10_000 });
  }, 30_000);
});

describe('drain in a cluster', () => {
  it('on SIGTERM reports not ready, gives the host to another relay, and closes with 1012', async () => {
    const registry = new MemoryRegistry();
    const options = {
      registry,
      cluster: CLUSTER,
      replay: 'fly' as const,
      drain: { graceMs: 400, idlePollMs: 20 },
    };
    const a = await startRelay(options);
    const b = await startRelay(options);
    const proxy = await FlyProxy.start([a, b]);
    const host = makeHost();
    proxy.landOn(a, a);
    const link = await linkHost(proxy, host);
    const { client } = await connectClient(proxy, host, link);
    expect((await fetch(`${a.url}/ready`)).status).toBe(200);

    const signals = new EventEmitter();
    a.drain.listen(signals);
    signals.emit('SIGTERM');

    const ready = await fetch(`${a.url}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unready', reasons: ['draining'] });
    await vi.waitFor(async () => expect(await registry.owner(host.hostId)).toBeNull());
    // A takes nothing new itself.
    expect(await upgradeStatus(wsUrl(a, hostPath(host)))).toBe(503);

    // Right after the leases go, A closes the link 1012, its stream with it,
    // so the server relinks at once rather than after the grace.
    expect(await client.closed).toEqual({ code: 1012, reason: 'relay restarting, reconnect' });
    expect((await link.closed).code).toBe(1012);

    // The server's next link lands on B, which takes the lease.
    proxy.landOn(b);
    const moved = await linkHost(proxy, host);
    expect(b.ownership.owns(host.hostId)).toBe(true);
    await a.drain.start();
    expect(a.drain.phase).toBe('drained');

    // A phone that lands on the draining A is still replayed to the owner.
    proxy.landOn(a);
    const phone = await connectClient(proxy, host, moved);
    expect(proxy.replays.at(-1)).toMatchObject({ from: a.nodeId, to: b.nodeId });
    phone.client.send(Buffer.from('on b'));
    expect(await moved.binary()).toEqual(prefixed(phone.stream, Buffer.from('on b')));
  });
});

describe('pushes during a drain', () => {
  it('answers the pushes in flight before the link closes, and refuses new ones', async () => {
    let answer: (() => void) | undefined;
    const apns = {
      send: () =>
        new Promise<{ ok: true }>((resolve) => {
          answer = () => resolve({ ok: true });
        }),
      close: async () => {},
    };
    const relay = await startRelay({ apns, drain: { graceMs: 2_000, idlePollMs: 20 } });
    const link = await linkHost(relay, makeHost());
    const push = (id: string) => ({
      type: 'push',
      id,
      platform: 'ios',
      token: 'ab',
      ciphertext: 'AA',
      priority: 5,
      expiresAt: 0,
    });
    link.send(push('p1'));
    await vi.waitFor(() => expect(answer).toBeDefined());
    const drained = relay.drain.start();
    link.send(push('p2'));
    expect(await link.text()).toEqual({
      type: 'push.result',
      id: 'p2',
      ok: false,
      reason: 'error',
      status: 503,
    });
    // The link waits for p1's answer, then closes 1012.
    answer!();
    expect(await link.text()).toEqual({ type: 'push.result', id: 'p1', ok: true });
    expect((await link.closed).code).toBe(1012);
    await drained;
  });
});

describe('the keepalive and flow control', () => {
  it('does not drop a phone for a missed pong while flow control has paused it', async () => {
    const relay = await startRelay({
      timing: { pingIntervalMs: 40 },
      flow: {
        highWaterBytes: 128 * KiB,
        lowWaterBytes: 32 * KiB,
        sourceHighWaterBytes: 64 * KiB,
        sourceLowWaterBytes: 16 * KiB,
        deliveryTimeoutMs: 60_000,
      },
      limits: { maxBufferedBytes: 256 * 1024 * 1024 },
    });
    const host = makeHost();
    const link = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, link);
    const received = watch(link);

    link.socket.pause();
    const total = 200;
    for (let i = 0; i < total; i += 1) client.send(Buffer.alloc(FRAME, i % 256));
    await vi.waitFor(() => expect(relay.flow.pausedSources).toBe(1), { timeout: 5_000 });
    // Many keepalive ticks pass while the relay reads nothing from the phone, pongs included.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    link.socket.resume();
    await vi.waitFor(
      () => expect(received.filter((frame) => 'binary' in frame)).toHaveLength(total),
      { timeout: 10_000 },
    );
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  }, 20_000);
});

describe('metrics in the relay', () => {
  it('serves /metrics only with the token', async () => {
    const token = 'metrics-token-for-tests';
    const relay = await startRelay({ metricsToken: token });
    await linkHost(relay, makeHost());
    expect((await fetch(`${relay.url}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${relay.url}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    const response = await fetch(`${relay.url}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/openbots_relay_hosts_owned 1/);
    expect(text).toMatch(/openbots_relay_sockets\{kind="host"\} 1/);
  });

  it('answers 404 on /metrics without a token configured', async () => {
    const relay = await startRelay();
    expect((await fetch(`${relay.url}/metrics`)).status).toBe(404);
  });
});
