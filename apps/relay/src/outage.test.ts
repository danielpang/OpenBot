import { describe, expect, it } from 'vitest';
import { MemoryRegistry } from './registry.js';
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
} from './test/helpers.js';

// A relay whose registry stops answering (MOBILE_AND_VM_PLAN.md 5.8): it
// serves on, alone, and says so, rather than refuse every link or report
// itself unready.

/** A registry every call of which fails, or never answers, while set. */
class Unreachable extends MemoryRegistry {
  mode: 'ok' | 'fail' | 'hang' = 'ok';

  private gate<T>(run: () => Promise<T>): Promise<T> {
    if (this.mode === 'fail') return Promise.reject(new Error('registry unreachable'));
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return run();
  }

  override acquire(...args: Parameters<MemoryRegistry['acquire']>) {
    return this.gate(() => super.acquire(...args));
  }
  override renew(...args: Parameters<MemoryRegistry['renew']>) {
    return this.gate(() => super.renew(...args));
  }
  override owner(hostId: string) {
    return this.gate(() => super.owner(hostId));
  }
  override alive(nodeId: string) {
    return this.gate(() => super.alive(nodeId));
  }
  override heartbeat(nodeId: string, ttlMs: number) {
    return this.gate(() => super.heartbeat(nodeId, ttlMs));
  }
  override liveNodes() {
    return this.gate(() => super.liveNodes());
  }
  override take(...args: Parameters<MemoryRegistry['take']>) {
    return this.gate(() => super.take(...args));
  }
  override add(...args: Parameters<MemoryRegistry['add']>) {
    return this.gate(() => super.add(...args));
  }
  override time() {
    return this.gate(() => super.time());
  }
}

describe('a relay whose registry is away', () => {
  it('serves a new host alone, stays ready, and reports the degradation', async () => {
    const registry = new Unreachable();
    const relay = await startRelay({ registry, registryTimeoutMs: 100 });
    registry.mode = 'fail';
    const host = makeHost();
    const link = await linkHost(relay, host);
    expect(relay.ownership.serves(host.hostId)).toBe(true);
    const { client, stream } = await connectClient(relay, host, link);
    client.send(Buffer.from('still works'));
    expect(await link.binary()).toEqual(prefixed(stream, Buffer.from('still works')));

    const ready = await fetch(`${relay.url}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', degraded: ['registry_unreachable'] });
    const metrics = await relay.metrics.render();
    expect(metrics).toMatch(/openbots_relay_served_alone_total 1/);
    expect(metrics).toMatch(/openbots_relay_hosts_alone 1/);

    // Once the registry answers, the host takes its lease and nothing reconnects.
    registry.mode = 'ok';
    await relay.ownership.renewAll();
    expect(relay.ownership.owns(host.hostId)).toBe(true);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
  });

  it('closes a link 1012 whose lease is not taken in time', async () => {
    const registry = new Unreachable();
    const relay = await startRelay({
      registry,
      registryTimeoutMs: 5_000,
      timing: { claimTimeoutMs: 100 },
    });
    registry.mode = 'hang';
    const host = makeHost();
    const peer = await Peer.open(wsUrl(relay, hostPath(host)));
    peer.send(hello(host, await peer.text()));
    expect(await peer.closed).toEqual({ code: 1012, reason: 'registry slow' });
  });
});
