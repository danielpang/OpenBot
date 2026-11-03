import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { PushGateway, PushRequest } from './apns.js';
import type { Relay, RelayOptions } from './relay.js';
import { MemoryRegistry, RedisRegistry, type Registry } from './registry.js';
import { FlyProxy } from './test/fly-proxy.js';
import {
  connectClient,
  hello,
  hostPath,
  linkHost,
  makeHost,
  Peer,
  prefixed,
  startRelay,
  wsUrl,
  type Closed,
  type HostIdentity,
} from './test/helpers.js';

// Several relays in one process sharing one registry, behind a stand-in for
// Fly's proxy (test/fly-proxy.ts): ownership, replays, a lost or dead owner,
// presence and the per-host limits (MOBILE_AND_VM_PLAN.md 5.8). The suite
// runs on a MemoryRegistry, and again on Redis when REDIS_URL is set.

const CLUSTER = { leaseMs: 600, renewMs: 150, nodeTtlMs: 300, heartbeatMs: 75 };

const redisUrl = process.env.REDIS_URL;
const redisRegistries: RedisRegistry[] = [];
afterAll(async () => {
  await Promise.all(redisRegistries.map((registry) => registry.close()));
});

const kinds: { name: string; make: () => Registry }[] = [
  { name: 'memory', make: () => new MemoryRegistry() },
];
if (redisUrl) {
  kinds.push({
    name: 'redis',
    make: () => {
      const registry = new RedisRegistry({ redis: redisUrl });
      redisRegistries.push(registry);
      return registry;
    },
  });
}

/** A host link through a URL that may be refused, closed or replayed: the linked peer, or why not. */
async function tryLink(
  url: string,
  host: HostIdentity,
  capabilities?: string[],
): Promise<Peer | Closed | Error> {
  let peer: Peer;
  try {
    peer = await Peer.open(url);
  } catch (error) {
    return error as Error;
  }
  const first = await Promise.race([peer.text(), peer.closed]);
  if ('code' in first) return first as Closed;
  peer.send(hello(host, first, capabilities));
  const linked = await Promise.race([peer.text(), peer.closed]);
  if ('code' in linked) return linked as Closed;
  return peer;
}

/** As the server's link does: dial again until linked, and say how long it took. */
async function relink(
  proxy: FlyProxy,
  host: HostIdentity,
  deadlineMs = 5_000,
): Promise<{ peer: Peer; tookMs: number }> {
  const started = Date.now();
  for (;;) {
    const result = await tryLink(wsUrl(proxy, hostPath(host)), host);
    if (result instanceof Peer) return { peer: result, tookMs: Date.now() - started };
    if (Date.now() - started > deadlineMs) throw new Error(`no link: ${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function presence(relay: Relay, host: HostIdentity): Promise<boolean> {
  const response = await fetch(`${relay.url}/v1/hosts/${host.hostId}`);
  return ((await response.json()) as { linked: boolean }).linked;
}

for (const kind of kinds) {
  describe(`relay cluster (${kind.name} registry)`, () => {
    async function cluster(size: number, extra: Partial<RelayOptions> = {}) {
      const registry = kind.make();
      const relays: Relay[] = [];
      for (let i = 0; i < size; i += 1) {
        relays.push(await startRelay({ registry, cluster: CLUSTER, ...extra }));
      }
      const proxy = await FlyProxy.start(relays);
      return { registry, relays, proxy };
    }

    it('meets a link and a phone that land on different relays on the owner', async () => {
      const { relays, proxy } = await cluster(3);
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a);
      const link = await linkHost(proxy, host);
      expect(a.ownership.owns(host.hostId)).toBe(true);

      proxy.landOn(b);
      const { client, stream } = await connectClient(proxy, host, link);
      expect(proxy.replays).toEqual([
        { from: b.nodeId, to: a.nodeId, path: `/v1/connect/${host.hostId}` },
      ]);
      client.send(Buffer.from('ping'));
      expect(await link.binary()).toEqual(prefixed(stream, Buffer.from('ping')));
      link.send(prefixed(stream, Buffer.from('pong')));
      expect(await client.binary()).toEqual(Buffer.from('pong'));
      expect(proxy.loops).toEqual([]);
    });

    it('replays a second link of the same host to the owner', async () => {
      const { relays, proxy } = await cluster(2);
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a, b);
      const first = await linkHost(proxy, host);
      const second = await linkHost(proxy, host);
      expect(proxy.replays).toEqual([{ from: b.nodeId, to: a.nodeId, path: hostPath(host) }]);
      expect(b.ownership.owns(host.hostId)).toBe(false);
      // Both links are on the owner, so streams take turns over them.
      const opened: number[] = [];
      [first, second].forEach((link, index) =>
        link.socket.on('message', (data, isBinary) => {
          if (!isBinary && JSON.parse(String(data)).type === 'open') opened.push(index);
        }),
      );
      for (let i = 0; i < 2; i += 1) {
        const client = await Peer.open(wsUrl(proxy, `/v1/connect/${host.hostId}`));
        expect(await client.text()).toEqual({ type: 'open', v: 1 });
      }
      await vi.waitFor(() => expect(opened.sort()).toEqual([0, 1]));
    });

    it('moves a host to another relay when its owner dies, within the timings', async () => {
      const { relays, proxy } = await cluster(2);
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a, a);
      const link = await linkHost(proxy, host);
      const { client } = await connectClient(proxy, host, link);

      await a.crash();
      proxy.remove(a);
      await link.closed;
      await client.closed;

      // Until A's node key runs out, B replays to A, which is gone (502);
      // then B takes the lease without waiting for it to expire.
      const { peer: again, tookMs } = await relink(proxy, host);
      expect(b.ownership.owns(host.hostId)).toBe(true);
      expect(tookMs).toBeLessThan(CLUSTER.nodeTtlMs + CLUSTER.leaseMs);
      const phone = await connectClient(proxy, host, again);
      phone.client.send(Buffer.from('back'));
      expect(await again.binary()).toEqual(prefixed(phone.stream, Buffer.from('back')));
    });

    it('closes the links and streams 1012 when a renewal finds a newer epoch', async () => {
      const { registry, relays, proxy } = await cluster(2);
      const [a] = relays as [Relay];
      const host = makeHost();
      proxy.landOn(a, a);
      const link = await linkHost(proxy, host);
      const { client } = await connectClient(proxy, host, link);

      // Another machine took the host over: the lease now has a newer epoch.
      const lease = await registry.owner(host.hostId);
      expect(lease).toMatchObject({ nodeId: a.nodeId, streams: true });
      await registry.release(host.hostId, a.nodeId, lease!.epoch);
      await registry.heartbeat('intruder', 5_000);
      const taken = await registry.acquire(host.hostId, 'intruder', 5_000, true);
      expect(taken).toEqual({ ok: true, epoch: lease!.epoch + 1 });

      await a.ownership.renewAll();
      expect(await client.closed).toEqual({ code: 1012, reason: 'lease lost' });
      expect(await link.closed).toEqual({ code: 1012, reason: 'lease lost' });
      expect(a.ownership.owns(host.hostId)).toBe(false);
      await registry.leave('intruder');
    });

    it('never replays a request that was already replayed', async () => {
      const { relays, proxy } = await cluster(2);
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a);
      const link = await linkHost(proxy, host);
      const replayed = { headers: { 'fly-replay-src': `instance=${a.nodeId};region=test;t=1` } };

      // A phone replayed to B (the owner moved meanwhile) is upgraded and told to retry.
      const phone = new Peer(new WebSocket(wsUrl(b, `/v1/connect/${host.hostId}`), replayed));
      expect(await phone.closed).toEqual({ code: 1012, reason: 'host moved' });

      // A link replayed to B cannot take the lease A holds: 1012, and the host reconnects.
      const second = new Peer(new WebSocket(wsUrl(b, hostPath(host)), replayed));
      second.send(hello(host, await second.text()));
      expect((await second.closed).code).toBe(1012);
      expect(b.ownership.owns(host.hostId)).toBe(false);

      // Without the header, B asks for a replay.
      const status = await new Promise<{ status?: number; replay?: string }>((resolve) => {
        const socket = new WebSocket(wsUrl(b, `/v1/connect/${host.hostId}`));
        socket.on('unexpected-response', (_req, res) =>
          resolve({ status: res.statusCode, replay: res.headers['fly-replay'] as string }),
        );
        socket.on('error', () => resolve({}));
      });
      expect(status).toEqual({ status: 307, replay: `instance=${a.nodeId}` });
      expect(proxy.loops).toEqual([]);
      link.socket.close();
    });

    it('answers presence from any relay', async () => {
      const { relays, proxy } = await cluster(3);
      const host = makeHost();
      for (const relay of relays) expect(await presence(relay, host)).toBe(false);
      proxy.landOn(relays[1]!);
      const link = await linkHost(proxy, host);
      for (const relay of relays) expect(await presence(relay, host)).toBe(true);
      link.socket.close();
      await link.closed;
      for (const relay of relays) {
        await vi.waitFor(async () => expect(await presence(relay, host)).toBe(false));
      }
      // A push only link holds the lease but serves no streams.
      proxy.landOn(relays[2]!);
      await linkHost(proxy, host, ['push']);
      for (const relay of relays) expect(await presence(relay, host)).toBe(false);
    });

    it('holds the per-host limits across relays', async () => {
      const pushes: PushRequest[] = [];
      const apns: PushGateway = {
        send: async (push) => {
          pushes.push(push);
          return { ok: true };
        },
        close: async () => {},
      };
      const { relays, proxy } = await cluster(2, {
        limits: { opensPerHour: 2, pushesPerHour: 1, bytesPerMinute: 1_000 },
        bytesFlushMs: 20,
        apns,
      });
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a, a, a);
      let link = await linkHost(proxy, host);
      for (let i = 0; i < 2; i += 1) {
        const { client, stream } = await connectClient(proxy, host, link);
        if (i === 0) {
          client.send(Buffer.alloc(600));
          expect(await link.binary()).toEqual(prefixed(stream, Buffer.alloc(600)));
        }
        client.socket.close();
        await link.text();
      }
      link.send({
        type: 'push',
        id: 'p1',
        platform: 'ios',
        token: 'ab',
        ciphertext: 'AA',
        priority: 5,
        expiresAt: 0,
      });
      expect(await link.text()).toEqual({ type: 'push.result', id: 'p1', ok: true });
      // Let A add its bytes to the registry, then move the host to B.
      await new Promise((resolve) => setTimeout(resolve, 60));
      link.socket.close();
      await link.closed;
      await vi.waitFor(() => expect(a.ownership.owns(host.hostId)).toBe(false));
      proxy.landOn(b);
      link = await linkHost(proxy, host);
      expect(b.ownership.owns(host.hostId)).toBe(true);

      link.send({
        type: 'push',
        id: 'p2',
        platform: 'ios',
        token: 'ab',
        ciphertext: 'AA',
        priority: 5,
        expiresAt: 0,
      });
      expect(await link.text()).toMatchObject({ id: 'p2', ok: false, status: 429 });
      expect(pushes).toHaveLength(1);
      const third = await Peer.open(wsUrl(proxy, `/v1/connect/${host.hostId}`));
      expect(await third.closed).toEqual({ code: 4429, reason: 'too many stream opens' });
    });

    it('closes a link 1008 past the bytes of the minute counted on another relay', async () => {
      const { relays, proxy } = await cluster(2, {
        limits: { bytesPerMinute: 1_000 },
        bytesFlushMs: 20,
      });
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      proxy.landOn(a, a);
      let link = await linkHost(proxy, host);
      const first = await connectClient(proxy, host, link);
      first.client.send(Buffer.alloc(600));
      await link.binary();
      await new Promise((resolve) => setTimeout(resolve, 60));
      link.socket.close();
      await link.closed;
      await vi.waitFor(() => expect(a.ownership.owns(host.hostId)).toBe(false));

      proxy.landOn(b, b);
      link = await linkHost(proxy, host);
      // B reads A's total on its first flush.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = await connectClient(proxy, host, link);
      second.client.send(Buffer.alloc(600));
      expect((await link.closed).code).toBe(1008);
    });

    it('gives the lease up when the last link goes, and on a clean close', async () => {
      const { registry, relays, proxy } = await cluster(2);
      const [a, b] = relays as [Relay, Relay];
      const host = makeHost();
      const other = makeHost();
      proxy.landOn(a, a, a);
      const one = await linkHost(proxy, host);
      const two = await linkHost(proxy, host);
      await linkHost(proxy, other);
      one.socket.close();
      await one.closed;
      await a.ownership.renewAll();
      expect((await registry.owner(host.hostId))?.nodeId).toBe(a.nodeId);
      two.socket.close();
      await two.closed;
      await vi.waitFor(async () => expect(await registry.owner(host.hostId)).toBeNull());

      await a.close();
      expect(await registry.owner(other.hostId)).toBeNull();
      expect(await registry.alive(a.nodeId)).toBe(false);
      expect(await registry.alive(b.nodeId)).toBe(true);
    });
  });
}

describe('relay cluster size', () => {
  it('takes no new lease below the minimum cluster size', async () => {
    const registry = new MemoryRegistry();
    const options = { registry, cluster: CLUSTER, minClusterSize: 2 };
    const a = await startRelay(options);
    const host = makeHost();
    const refused = await tryLink(wsUrl(a, hostPath(host)), host);
    expect(refused).toEqual({ code: 1012, reason: 'cluster below its minimum size' });
    await startRelay(options);
    // A sees the second machine on its next heartbeat.
    await vi.waitFor(async () => {
      const linked = await tryLink(wsUrl(a, hostPath(host)), host);
      expect(linked).toBeInstanceOf(Peer);
    });
  });
});
