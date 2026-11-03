import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { NodeBudget } from './budget.js';
import {
  DEFAULT_FLOW,
  FlowControl,
  flowOptionsFromEnv,
  type FlowSink,
  type Outlet,
  type PausableSource,
} from './flow.js';

// Unit tests drive a fake sink whose buffer the test sets; the socket tests
// run real `ws` sockets on loopback with a reader that stops reading, so the
// kernel's buffers fill and the relay side's `bufferedAmount` climbs.

class FakeSink implements FlowSink {
  bufferedAmount = 0;
  readyState = 1;
  readonly pending: ((err?: Error) => void)[] = [];
  readonly sent: (Buffer | string)[] = [];

  send(data: Buffer | string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    this.bufferedAmount += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    this.pending.push(cb ?? (() => undefined));
  }

  /** The socket takes the oldest `n` frames. */
  flush(n = this.pending.length, bytesEach?: number): void {
    for (let i = 0; i < n; i++) {
      const cb = this.pending.shift();
      if (!cb) return;
      const data = this.sent[this.sent.length - this.pending.length - 1]!;
      this.bufferedAmount -=
        bytesEach ?? (typeof data === 'string' ? Buffer.byteLength(data) : data.length);
      cb();
    }
  }
}

class FakeSource implements PausableSource {
  paused = false;
  pauses = 0;
  pause() {
    this.paused = true;
    this.pauses += 1;
  }
  resume() {
    this.paused = false;
  }
}

const KiB = 1024;
const options = {
  highWaterBytes: 100 * KiB,
  lowWaterBytes: 25 * KiB,
  sourceHighWaterBytes: 60 * KiB,
  sourceLowWaterBytes: 10 * KiB,
  deliveryTimeoutMs: 1_000,
};

describe('flow control with a fake socket', () => {
  it('has the defaults of plan 5.8', () => {
    expect(DEFAULT_FLOW.highWaterBytes).toBe(1024 * 1024);
    expect(DEFAULT_FLOW.lowWaterBytes).toBe(256 * 1024);
    expect(DEFAULT_FLOW.deliveryTimeoutMs).toBe(30_000);
  });

  it('refuses marks in the wrong order', () => {
    expect(() => new FlowControl({ highWaterBytes: 10, lowWaterBytes: 10 })).toThrow();
  });

  it('pauses an attached source above the high-water mark and resumes at the low one', () => {
    const flow = new FlowControl(options);
    const sink = new FakeSink();
    const source = new FakeSource();
    const valve = flow.valve(source);
    const outlet = flow.outlet(sink, { kind: 'client', onShed: vi.fn() });
    outlet.attach(valve);

    for (let i = 0; i < 6; i++) outlet.send(Buffer.alloc(16 * KiB));
    expect(source.paused).toBe(false);
    outlet.send(Buffer.alloc(16 * KiB)); // 112 KiB buffered
    expect(source.paused).toBe(true);
    expect(outlet.blocked).toBe(true);
    expect(flow.pausedSources).toBe(1);
    expect(flow.blockedDestinations).toBe(1);

    sink.flush(5); // 32 KiB left: still above the low mark
    expect(source.paused).toBe(true);
    sink.flush(1); // 16 KiB left
    expect(source.paused).toBe(false);
    expect(outlet.blocked).toBe(false);
    expect(flow.pausedSources).toBe(0);
  });

  it('sheds a destination blocked past the deadline, once, and resumes its sources', () => {
    let now = 0;
    const flow = new FlowControl(options, () => now);
    const sink = new FakeSink();
    const source = new FakeSource();
    const valve = flow.valve(source);
    const onShed = vi.fn();
    const outlet = flow.outlet(sink, { kind: 'client', onShed });
    outlet.attach(valve);
    outlet.send(Buffer.alloc(200 * KiB));
    expect(source.paused).toBe(true);

    now = 999;
    flow.sweep();
    expect(onShed).not.toHaveBeenCalled();
    expect(outlet.blockedForMs()).toBe(999);
    now = 1_000;
    flow.sweep();
    expect(onShed).toHaveBeenCalledTimes(1);
    expect(onShed).toHaveBeenCalledWith(outlet);
    expect(source.paused).toBe(false);
    expect(flow.shed).toBe(1);
    now = 5_000;
    flow.sweep();
    expect(onShed).toHaveBeenCalledTimes(1);
    expect(outlet.send(Buffer.alloc(1))).toEqual({ ok: false, reason: 'closed' });
  });

  it('does not shed a destination that drained in time', () => {
    let now = 0;
    const flow = new FlowControl(options, () => now);
    const sink = new FakeSink();
    const onShed = vi.fn();
    const outlet = flow.outlet(sink, { kind: 'client', onShed });
    outlet.send(Buffer.alloc(200 * KiB));
    now = 900;
    sink.flush();
    now = 2_000;
    flow.sweep();
    expect(onShed).not.toHaveBeenCalled();
  });

  it('holds a source that is attached while the destination is already blocked', () => {
    const flow = new FlowControl(options);
    const sink = new FakeSink();
    const outlet = flow.outlet(sink, { kind: 'host', onShed: vi.fn() });
    outlet.send(Buffer.alloc(200 * KiB));
    const late = new FakeSource();
    outlet.attach(flow.valve(late));
    expect(late.paused).toBe(true);
  });

  it('never pauses a source that is not attached: one link, many client outlets', () => {
    let now = 0;
    const flow = new FlowControl(options, () => now);
    const linkSocket = new FakeSource();
    const link = flow.valve(linkSocket);
    const slow = new FakeSink();
    const fast = new FakeSink();
    const shed: Outlet[] = [];
    const slowOutlet = flow.outlet(slow, { kind: 'client', onShed: (o) => shed.push(o) });
    const fastOutlet = flow.outlet(fast, { kind: 'client', onShed: (o) => shed.push(o) });
    for (let i = 0; i < 20; i++) {
      slowOutlet.send(Buffer.alloc(16 * KiB));
      fastOutlet.send(Buffer.alloc(16 * KiB));
      fast.flush();
    }
    expect(slowOutlet.blocked).toBe(true);
    expect(fastOutlet.blocked).toBe(false);
    expect(linkSocket.pauses).toBe(0);
    expect(link.paused).toBe(false);
    now = 1_000;
    flow.sweep();
    expect(shed).toEqual([slowOutlet]);
    expect(linkSocket.pauses).toBe(0);
  });

  it('pauses only the busy stream into a shared link while the link has room', () => {
    const flow = new FlowControl(options);
    const link = new FakeSink();
    const linkOutlet = flow.outlet(link, { kind: 'host', onShed: vi.fn() });
    const busy = new FakeSource();
    const quiet = new FakeSource();
    const busyValve = flow.valve(busy);
    const quietValve = flow.valve(quiet);
    linkOutlet.attach(busyValve);
    linkOutlet.attach(quietValve);

    for (let i = 0; i < 4; i++) linkOutlet.send(Buffer.alloc(16 * KiB), busyValve);
    expect(linkOutlet.outstanding(busyValve)).toBe(64 * KiB);
    expect(busy.paused).toBe(true); // over its 60 KiB share
    expect(quiet.paused).toBe(false);
    expect(linkOutlet.blocked).toBe(false);

    linkOutlet.send(Buffer.alloc(16 * KiB), quietValve);
    expect(quiet.paused).toBe(false);

    link.flush(4); // the busy stream's frames
    expect(linkOutlet.outstanding(busyValve)).toBe(0);
    expect(busy.paused).toBe(false);
  });

  it('pauses every stream into a link that is itself above its mark', () => {
    const flow = new FlowControl(options);
    const link = new FakeSink();
    const linkOutlet = flow.outlet(link, { kind: 'host', onShed: vi.fn() });
    const sources = [new FakeSource(), new FakeSource(), new FakeSource()];
    const valves = sources.map((source) => {
      const valve = flow.valve(source);
      linkOutlet.attach(valve);
      return valve;
    });
    // 3 x 48 KiB: no source past its share, the link past its mark.
    for (const valve of valves)
      for (let i = 0; i < 3; i++) linkOutlet.send(Buffer.alloc(16 * KiB), valve);
    expect(linkOutlet.blocked).toBe(true);
    expect(sources.every((s) => s.paused)).toBe(true);
    expect(flow.pausedSources).toBe(3);
    link.flush();
    expect(sources.every((s) => !s.paused)).toBe(true);
    expect(flow.pausedSources).toBe(0);
  });

  it('takes the holds off a detached stream', () => {
    const flow = new FlowControl(options);
    const link = new FakeSink();
    const linkOutlet = flow.outlet(link, { kind: 'host', onShed: vi.fn() });
    const source = new FakeSource();
    const valve = flow.valve(source);
    linkOutlet.attach(valve);
    linkOutlet.send(Buffer.alloc(200 * KiB), valve);
    expect(source.paused).toBe(true);
    linkOutlet.detach(valve);
    expect(source.paused).toBe(false);
    expect(flow.pausedSources).toBe(0);
  });

  it('forgets holds on a closed source without resuming it', () => {
    const flow = new FlowControl(options);
    const sink = new FakeSink();
    const outlet = flow.outlet(sink, { kind: 'client', onShed: vi.fn() });
    const source = new FakeSource();
    const resume = vi.spyOn(source, 'resume');
    const valve = flow.valve(source);
    outlet.attach(valve);
    outlet.send(Buffer.alloc(200 * KiB));
    valve.close();
    expect(flow.pausedSources).toBe(0);
    sink.flush();
    expect(resume).not.toHaveBeenCalled();
  });

  it('reserves each frame on the ticket of the destination until the socket takes it', () => {
    const budget = new NodeBudget({ maxBytes: 50 * KiB });
    const admission = budget.admit('client');
    if (!admission.ok) throw new Error('expected an admission');
    const flow = new FlowControl(options);
    const sink = new FakeSink();
    const outlet = flow.outlet(sink, {
      kind: 'client',
      onShed: vi.fn(),
      ticket: admission.ticket,
    });
    expect(outlet.send(Buffer.alloc(30 * KiB)).ok).toBe(true);
    expect(budget.bytesInFlight).toBe(30 * KiB);
    const refused = outlet.send(Buffer.alloc(30 * KiB));
    expect(refused).toMatchObject({ ok: false, reason: 'budget', refusal: { closeCode: 1013 } });
    expect(sink.sent).toHaveLength(1);
    sink.flush();
    expect(budget.bytesInFlight).toBe(0);
    expect(outlet.send(Buffer.alloc(30 * KiB)).ok).toBe(true);
    // The destination goes away with a frame still unwritten: its ticket gives it back.
    outlet.close();
    admission.ticket.close();
    expect(budget.bytesInFlight).toBe(0);
    sink.flush();
    expect(budget.bytesInFlight).toBe(0);
  });

  it('refuses to send on a socket that is not open', () => {
    const flow = new FlowControl(options);
    const sink = new FakeSink();
    sink.readyState = 2;
    const outlet = flow.outlet(sink, { kind: 'client', onShed: vi.fn() });
    expect(outlet.send('x')).toEqual({ ok: false, reason: 'closed' });
  });

  it('sweeps on its own timer once started', () => {
    vi.useFakeTimers();
    try {
      const flow = new FlowControl({ ...options, sweepIntervalMs: 100 });
      const sink = new FakeSink();
      const onShed = vi.fn();
      flow.outlet(sink, { kind: 'client', onShed }).send(Buffer.alloc(200 * KiB));
      flow.start();
      vi.advanceTimersByTime(1_100);
      expect(onShed).toHaveBeenCalledTimes(1);
      flow.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads its settings from the environment', () => {
    expect(flowOptionsFromEnv({})).toMatchObject({
      highWaterBytes: DEFAULT_FLOW.highWaterBytes,
      lowWaterBytes: DEFAULT_FLOW.lowWaterBytes,
      sourceHighWaterBytes: 512 * KiB,
      sourceLowWaterBytes: 128 * KiB,
      deliveryTimeoutMs: 30_000,
    });
    expect(
      flowOptionsFromEnv({
        RELAY_FLOW_HIGH_WATER_BYTES: '4096',
        RELAY_FLOW_LOW_WATER_BYTES: '1024',
        RELAY_DELIVERY_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({ highWaterBytes: 4096, lowWaterBytes: 1024, deliveryTimeoutMs: 5000 });
    expect(() =>
      flowOptionsFromEnv({ RELAY_FLOW_HIGH_WATER_BYTES: '10', RELAY_FLOW_LOW_WATER_BYTES: '10' }),
    ).toThrow();
  });
});

// --- real sockets ----------------------------------------------------------

const FRAME = 64 * KiB;

interface Rig {
  url: string;
  /** Server side sockets, in the order their clients connected. */
  accepted(): Promise<WebSocket>;
}

const servers: Server[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function rig(): Promise<Rig> {
  const server = createServer();
  servers.push(server);
  const wss = new WebSocketServer({ server });
  const queue: WebSocket[] = [];
  const waiters: ((ws: WebSocket) => void)[] = [];
  wss.on('connection', (ws) => {
    ws.on('error', () => undefined);
    const waiter = waiters.shift();
    if (waiter) waiter(ws);
    else queue.push(ws);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    accepted: () => {
      const ws = queue.shift();
      return ws ? Promise.resolve(ws) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function connect(r: Rig): Promise<{ client: WebSocket; server: WebSocket }> {
  const client = new WebSocket(r.url);
  clients.push(client);
  client.on('error', () => undefined);
  const server = r.accepted();
  await new Promise((resolve) => client.once('open', resolve));
  return { client, server: await server };
}

function frame(index: number, tag = 0, size = FRAME): Buffer {
  const buffer = Buffer.alloc(size, tag);
  buffer.writeUInt32BE(index, 0);
  return buffer;
}

/** Sends `count` frames as fast as the socket will queue them. */
function flood(ws: WebSocket, count: number, make: (i: number) => Buffer) {
  for (let i = 0; i < count; i++) ws.send(make(i));
}

function collect(ws: WebSocket) {
  const received: Buffer[] = [];
  ws.on('message', (data: RawData) => received.push(Buffer.from(data as Buffer)));
  return received;
}

function bytes(frames: Buffer[]): number {
  return frames.reduce((sum, b) => sum + b.length, 0);
}

describe('flow control over real sockets', () => {
  it('pauses a fast source behind a slow reader, bounds the buffer, and delivers everything in order', async () => {
    const r = await rig();
    const a = await connect(r); // the source
    const b = await connect(r); // the destination
    const flow = new FlowControl({ ...DEFAULT_FLOW, deliveryTimeoutMs: 60_000 });
    const valve = flow.valve(a.server);
    const outlet = flow.outlet(b.server, { kind: 'client', onShed: vi.fn() });
    outlet.attach(valve);
    let peak = 0;
    a.server.on('message', (data: RawData) => {
      outlet.send(data as Buffer);
      peak = Math.max(peak, b.server.bufferedAmount);
    });

    b.client.pause(); // the reader stops reading
    const received = collect(b.client);
    const total = 512; // 32 MiB
    flood(a.client, total, (i) => frame(i));

    await expect.poll(() => a.server.isPaused, { timeout: 10_000 }).toBe(true);
    expect(flow.pausedSources).toBe(1);
    expect(outlet.blocked).toBe(true);
    // Settle: nothing more may pile up on the relay side while the source is paused.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const held = b.server.bufferedAmount;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(b.server.bufferedAmount).toBe(held);
    expect(peak).toBeLessThan(DEFAULT_FLOW.highWaterBytes + 1024 * KiB);

    b.client.resume();
    await expect.poll(() => received.length, { timeout: 20_000 }).toBe(total);
    expect(received.map((f) => f.readUInt32BE(0))).toEqual(
      Array.from({ length: total }, (_, i) => i),
    );
    expect(a.server.isPaused).toBe(false);
    expect(flow.pausedSources).toBe(0);
    expect(outlet.blocked).toBe(false);
  }, 30_000);

  it('sheds a destination that stays blocked past the deadline with 1013', async () => {
    const r = await rig();
    const a = await connect(r);
    const b = await connect(r);
    const flow = new FlowControl({ ...DEFAULT_FLOW, deliveryTimeoutMs: 300 });
    flow.start();
    const valve = flow.valve(a.server);
    const onShed = vi.fn((shed: Outlet) => {
      expect(shed.kind).toBe('client');
      b.server.close(1013, 'too slow');
    });
    const outlet = flow.outlet(b.server, { kind: 'client', onShed });
    outlet.attach(valve);
    a.server.on('message', (data: RawData) => outlet.send(data as Buffer));
    b.server.on('close', () => valve.close());

    b.client.pause();
    const closed = new Promise<number>((resolve) => b.client.once('close', resolve));
    flood(a.client, 256, (i) => frame(i));
    await expect.poll(() => onShed.mock.calls.length, { timeout: 10_000 }).toBe(1);
    expect(flow.shed).toBe(1);
    // The source is no longer held by the shed destination.
    expect(a.server.isPaused).toBe(false);

    // The phone reads again: it gets what was queued, then the close.
    b.client.resume();
    expect(await closed).toBe(1013);
    flow.stop();
  }, 30_000);

  it('host to clients: a slow phone never pauses the shared link or the other phone', async () => {
    const r = await rig();
    const host = await connect(r);
    const slow = await connect(r);
    const fast = await connect(r);
    let now = 0;
    const flow = new FlowControl(DEFAULT_FLOW, () => now);
    const link = flow.valve(host.server);
    const shedSlow = vi.fn();
    const shedFast = vi.fn();
    const outlets = new Map([
      [1, flow.outlet(slow.server, { kind: 'client', onShed: shedSlow })],
      [2, flow.outlet(fast.server, { kind: 'client', onShed: shedFast })],
    ]);
    // Neither client outlet is given the link to hold.
    host.server.on('message', (data: RawData) => {
      const buffer = data as Buffer;
      outlets.get(buffer.readUInt32BE(0))?.send(buffer.subarray(4));
    });
    const pause = vi.spyOn(host.server, 'pause');

    slow.client.pause();
    const fastReceived = collect(fast.client);
    const slowReceived = collect(slow.client);
    const perStream = 160; // 10 MiB each
    for (let i = 0; i < perStream; i++) {
      for (const stream of [1, 2]) {
        const payload = frame(i, stream, FRAME - 4);
        const prefixed = Buffer.allocUnsafe(FRAME);
        prefixed.writeUInt32BE(stream, 0);
        payload.copy(prefixed, 4);
        host.client.send(prefixed);
      }
    }

    await expect.poll(() => fastReceived.length, { timeout: 20_000 }).toBe(perStream);
    expect(bytes(fastReceived)).toBe(perStream * (FRAME - 4));
    expect(outlets.get(1)!.blocked).toBe(true);
    expect(outlets.get(2)!.blocked).toBe(false);
    expect(link.paused).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    expect(host.server.isPaused).toBe(false);

    // Past the deadline, only the slow phone is due to be shed.
    now += DEFAULT_FLOW.deliveryTimeoutMs;
    flow.sweep(now);
    expect(shedSlow).toHaveBeenCalledTimes(1);
    expect(shedFast).not.toHaveBeenCalled();
    expect(outlets.get(1)!.send(Buffer.alloc(1))).toEqual({ ok: false, reason: 'closed' });
    expect(outlets.get(2)!.send(Buffer.alloc(1)).ok).toBe(true);
    expect(slowReceived.length).toBeLessThan(perStream);
    expect(pause).not.toHaveBeenCalled();
  }, 30_000);

  it('clients to host: a link that is behind pauses every stream feeding it, then resumes them', async () => {
    const r = await rig();
    const host = await connect(r);
    const one = await connect(r);
    const two = await connect(r);
    const flow = new FlowControl({ ...DEFAULT_FLOW, deliveryTimeoutMs: 60_000 });
    const linkOutlet = flow.outlet(host.server, { kind: 'host', onShed: vi.fn() });
    const streams = [
      { id: 1, socket: one, valve: flow.valve(one.server) },
      { id: 2, socket: two, valve: flow.valve(two.server) },
    ];
    for (const { id, socket, valve } of streams) {
      linkOutlet.attach(valve);
      socket.server.on('message', (data: RawData) => {
        const payload = data as Buffer;
        const prefixed = Buffer.allocUnsafe(4 + payload.length);
        prefixed.writeUInt32BE(id, 0);
        payload.copy(prefixed, 4);
        linkOutlet.send(prefixed, valve);
      });
    }

    host.client.pause();
    const received = collect(host.client);
    const perStream = 256; // 16 MiB each
    flood(one.client, perStream, (i) => frame(i, 1, FRAME - 4));
    flood(two.client, perStream, (i) => frame(i, 2, FRAME - 4));

    await expect
      .poll(() => one.server.isPaused && two.server.isPaused, { timeout: 10_000 })
      .toBe(true);
    expect(linkOutlet.blocked).toBe(true);
    expect(flow.pausedSources).toBe(2);

    host.client.resume();
    await expect.poll(() => received.length, { timeout: 20_000 }).toBe(perStream * 2);
    for (const id of [1, 2]) {
      const mine = received.filter((f) => f.readUInt32BE(0) === id);
      expect(mine.map((f) => f.readUInt32BE(4))).toEqual(
        Array.from({ length: perStream }, (_, i) => i),
      );
    }
    expect(one.server.isPaused).toBe(false);
    expect(two.server.isPaused).toBe(false);
    expect(flow.pausedSources).toBe(0);
  }, 30_000);
});
