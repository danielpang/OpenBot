import { createHash } from 'node:crypto';
import type { Outlet, SendResult, Valve } from './flow.js';
import { counterKey, DEFAULT_COMMAND_TIMEOUT_MS, withTimeout, type Registry } from './registry.js';

// The links of the hosts this machine serves (docs/RELAY_PROTOCOL.md 3.1, 3.4
// and 3.5). Per host id it keeps the links this process holds, the
// round-robin cursor that spreads new client streams over the links that
// serve `streams`, and the per-host limits. It knows nothing about sockets: a
// link is whatever can carry `open`, data and `close` frames to its host, and
// a stream is whatever can take the host's payloads and close.
//
// The links are sockets and stay on this machine, which owns the host
// (ownership.ts). The counters of 3.4 live in the shared registry
// (registry.ts), so they hold when a host moves to another machine: stream
// opens and pushes are counted there one by one, and stream bytes, which pass
// on every frame, are counted here and added to the registry's total every
// `bytesFlushMs`, so the minute's limit holds across machines within that lag.
//
// Nobody is authenticated at the relay: a client stream is a socket from an
// address that knows a host id. So nothing a client does may cost the host
// its link, and the limits that a client can spend are kept per client
// address as well as per host:
//
// - Open streams: 8 per host, and 4 per host from one address. These are
//   counted from the links here, which hold every stream of the host.
// - Opens: 60 a minute per host from one address, and a rate per address
//   across every host, counted in the registry. The hour's opens of the host
//   count a stream only once its first client payload has arrived (the
//   client stream asks `countOpen` then), so a socket that sends nothing
//   spends none of the host's hour. Such a socket is closed after 5 seconds
//   (client-stream.ts).
// - Bytes: client to host bytes are counted per stream and per address on
//   this machine, and only that stream is closed past either (1008). Host to
//   client bytes count against the host's minute, and past it only the
//   stream that would carry the excess is closed (1008), never the link.
//
// Every registry call has a time limit, so an open waiting on the registry
// gives back its reservation of a stream slot when the registry is slow.
//
// When the registry cannot be reached the limits do not lapse: each host also
// has local window counters with the same limits and windows, which count
// everything this machine lets through, and decide on their own until the
// registry answers again. That is more permissive across machines than the
// shared limit, but never unlimited. Bytes need no extra counter: the
// minute's check already adds what is pending here to the registry's last
// total, and bytes that could not be added stay pending.

export type Capability = 'streams' | 'push';

export const CAPABILITIES: readonly Capability[] = ['streams', 'push'];

/** The per-host and per-address limits of 3.4, and the link limits beside them. */
export interface RelayLimits {
  /** Open streams per host, across its links; the next client is closed 4429. */
  streamsPerHost: number;
  /** Open streams per host from one client address; the next is closed 4429. */
  addressStreamsPerHost: number;
  /** Stream opens per host an hour that carried a first payload; the next is closed 4429. */
  opensPerHour: number;
  /** Stream opens per host from one client address a minute; the next is closed 4429. */
  addressOpensPerHostPerMinute: number;
  /** Stream opens from one client address a minute, to any host; the next is closed 4429. */
  addressOpensPerMinute: number;
  /** A stream that carries no client payload this long after it opens is closed 4400. */
  firstPayloadMs: number;
  /** Host to client payload bytes per host a minute; the stream that passes it is closed 1008. */
  bytesPerMinute: number;
  /** Client to host payload bytes per stream a minute; past it the stream is closed 1008. */
  streamBytesPerMinute: number;
  /** Client to host payload bytes per client address a minute, on this machine; the stream that passes it is closed 1008. */
  addressBytesPerMinute: number;
  /** Push frames per host an hour; the next gets `push.result` error 429. */
  pushesPerHour: number;
  /** A socket whose send buffer passes this is closed 1008. */
  maxBufferedBytes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  streamsPerHost: 8,
  addressStreamsPerHost: 4,
  opensPerHour: 1_000,
  addressOpensPerHostPerMinute: 60,
  addressOpensPerMinute: 300,
  firstPayloadMs: 5_000,
  bytesPerMinute: 50_000_000,
  streamBytesPerMinute: 50_000_000,
  addressBytesPerMinute: 50_000_000,
  pushesPerHour: 600,
  maxBufferedBytes: 8 * 1024 * 1024,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_STREAM_ID = 0xffff_ffff;

/** The client side of one stream, as the link sees it. */
export interface StreamPeer {
  /** The client's address. */
  readonly remote: string;
  /** One payload from the host, to go to the client as one binary frame. */
  deliver(payload: Buffer): void;
  /** The stream is over: the host closed it, or its link dropped (4410). */
  end(code: number, reason: string): void;
}

/** One host link, as the registry sees it. */
export interface Link {
  readonly hostId: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** The link's open streams by id. */
  readonly streams: Map<number, StreamPeer>;
  /** Tells the host a client connected on `stream`. */
  sendOpen(stream: number, remote: string): void;
  /**
   * Sends one client payload to the host. `from` is the client socket's
   * valve, which the link's outlet pauses when that stream is past its share.
   */
  sendData(stream: number, payload: Buffer, from?: Valve): SendResult;
  /** The link socket's outlet, which a stream's valve attaches to (flow.ts). */
  readonly linkOutlet: Outlet;
  /** Tells the host the client closed `stream`. */
  sendClose(stream: number, code: number, reason: string): void;
  /** Closes the link itself, with `code` toward the host. */
  end(code?: number, reason?: string): void;
}

/** Answers whether a host is linked; the presence route asks it (ownership.ts answers from the registry). */
export interface Presence {
  linked(hostId: string): Promise<boolean>;
}

/** A fixed window counter in memory, aligned to the clock as the registry's windows are. */
export class LocalWindow {
  private window = -1;
  private count = 0;

  constructor(private readonly windowMs: number) {}

  /** Counts `n` that the registry already let through. */
  add(n: number, now: number): void {
    this.roll(now);
    this.count += n;
  }

  /** Counts `n` unless they would pass `limit`: the decision while the registry is away. */
  take(n: number, limit: number, now: number): boolean {
    this.roll(now);
    if (this.count + n > limit) return false;
    this.count += n;
    return true;
  }

  idle(now: number): boolean {
    this.roll(now);
    return this.count === 0;
  }

  private roll(now: number) {
    const window = Math.floor(now / this.windowMs);
    if (window !== this.window) {
      this.window = window;
      this.count = 0;
    }
  }
}

/** The bytes of one host's current minute: the registry's total when last asked, and what is not added yet. */
interface ByteWindow {
  window: number;
  shared: number;
  pending: number;
  /** Whether the registry's total for this window has been read at least once. */
  loaded: boolean;
}

interface HostEntry {
  hostId: string;
  links: Link[];
  cursor: number;
  /** Opens waiting on the registry, counted against the open streams. */
  reserved: number;
  /** The same, by client address. */
  reservedFrom: Map<string, number>;
  bytes: ByteWindow;
  /** The hour's opens and pushes on this machine, which decide while the registry is away. */
  opens: LocalWindow;
  pushes: LocalWindow;
  /** The minute's opens per client address (hashed), likewise. */
  addressOpens: Map<string, LocalWindow>;
}

export type OpenResult =
  { ok: true; link: Link; stream: number } | { ok: false; code: number; reason: string };

export class HostRegistry {
  private readonly hosts = new Map<string, HostEntry>();
  /** The next stream id each link hands out; ids are never reused while a link lives. */
  private readonly nextIds = new WeakMap<Link, number>();
  /** The minute's opens per client address (hashed) to any host, while the registry is away. */
  private readonly addressOpens = new Map<string, LocalWindow>();
  /** The minute's client to host bytes per client address on this machine. */
  private readonly addressBytes = new Map<string, LocalWindow>();

  constructor(
    readonly limits: RelayLimits,
    private readonly counters: Registry,
    /** The registry's clock (registry.ts `RegistryClock`), which cuts the windows. */
    private readonly now: () => number = Date.now,
    /** The time limit of one counter call. */
    private readonly callTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ) {}

  addLink(link: Link): void {
    this.entry(link.hostId).links.push(link);
    this.nextIds.set(link, 1);
  }

  /**
   * Forgets `link` and ends every stream it served with 4410. The host's
   * counters live in the registry, so a host cannot reset its limits by
   * relinking, here or on another machine.
   */
  removeLink(link: Link): void {
    const entry = this.hosts.get(link.hostId);
    if (entry) {
      const index = entry.links.indexOf(link);
      if (index !== -1) entry.links.splice(index, 1);
    }
    const streams = [...link.streams.values()];
    link.streams.clear();
    for (const stream of streams) stream.end(4410, 'host gone');
  }

  /** Whether this machine holds any link of the host. */
  hasLinks(hostId: string): boolean {
    return (this.hosts.get(hostId)?.links.length ?? 0) > 0;
  }

  /** Whether this machine holds a `streams` link of the host: what presence means. */
  hasStreams(hostId: string): boolean {
    return this.hosts.get(hostId)?.links.some((link) => link.capabilities.has('streams')) ?? false;
  }

  /**
   * Ends every stream of the host with `code` and answers its links for the
   * caller to close: what losing the host's lease does.
   */
  endStreams(hostId: string, code: number, reason: string): Link[] {
    const links = [...(this.hosts.get(hostId)?.links ?? [])];
    for (const link of links) {
      const streams = [...link.streams.values()];
      link.streams.clear();
      for (const stream of streams) stream.end(code, reason);
    }
    return links;
  }

  /** Links held in this process, for shutdown. */
  allLinks(): Link[] {
    return [...this.hosts.values()].flatMap((entry) => entry.links);
  }

  /** Open streams for a host, across its links. */
  openStreams(hostId: string): number {
    let count = 0;
    for (const link of this.hosts.get(hostId)?.links ?? []) count += link.streams.size;
    return count;
  }

  /** Open streams for a host from one client address, across its links. */
  openStreamsFrom(hostId: string, remote: string): number {
    let count = 0;
    for (const link of this.hosts.get(hostId)?.links ?? []) {
      for (const peer of link.streams.values()) if (peer.remote === remote) count += 1;
    }
    return count;
  }

  /**
   * Opens a stream for a client on the host's next `streams` link in turn,
   * after the limits of 3.4, and tells the host. The caller tells the client.
   * The address's opens are counted in the registry; if it cannot be reached
   * the local counters decide. The host's hour is not counted here but once
   * the stream's first payload arrives (`countOpen`).
   */
  async openStream(hostId: string, peer: StreamPeer, remote: string): Promise<OpenResult> {
    const entry = this.hosts.get(hostId);
    if (!entry || !this.hasStreams(hostId))
      return { ok: false, code: 4404, reason: 'host offline' };
    if (this.openStreams(hostId) + entry.reserved >= this.limits.streamsPerHost) {
      return { ok: false, code: 4429, reason: 'too many streams' };
    }
    const fromHere = entry.reservedFrom.get(remote) ?? 0;
    if (this.openStreamsFrom(hostId, remote) + fromHere >= this.limits.addressStreamsPerHost) {
      return { ok: false, code: 4429, reason: 'too many streams from this address' };
    }
    entry.reserved += 1;
    entry.reservedFrom.set(remote, fromHere + 1);
    const address = addressKey(remote);
    let counted: boolean;
    try {
      counted =
        (await this.count(
          windowFor(entry.addressOpens, address, MINUTE_MS),
          'host-address-opens',
          `${hostId}:${address}`,
          this.limits.addressOpensPerHostPerMinute,
          MINUTE_MS,
        )) &&
        (await this.count(
          windowFor(this.addressOpens, address, MINUTE_MS),
          'address-opens',
          address,
          this.limits.addressOpensPerMinute,
          MINUTE_MS,
        ));
    } finally {
      entry.reserved -= 1;
      const left = (entry.reservedFrom.get(remote) ?? 1) - 1;
      if (left > 0) entry.reservedFrom.set(remote, left);
      else entry.reservedFrom.delete(remote);
    }
    if (!counted)
      return { ok: false, code: 4429, reason: 'too many stream opens from this address' };
    // The links may have changed while the registry answered.
    const serving = entry.links.filter((link) => link.capabilities.has('streams'));
    if (serving.length === 0) return { ok: false, code: 4404, reason: 'host offline' };
    const link = serving[entry.cursor % serving.length]!;
    entry.cursor = (entry.cursor + 1) % serving.length;
    const stream = this.allocate(link);
    link.streams.set(stream, peer);
    link.sendOpen(stream, remote);
    return { ok: true, link, stream };
  }

  /**
   * Counts one stream open against the host's hour, once the stream's first
   * client payload has arrived; false means the hour is spent (the stream is
   * then closed 4429).
   */
  countOpen(hostId: string): Promise<boolean> {
    const entry = this.entry(hostId);
    return this.count(entry.opens, 'opens', hostId, this.limits.opensPerHour, HOUR_MS);
  }

  /**
   * Counts client to host payload bytes against the client address's minute
   * on this machine; false means the address is past it.
   */
  countAddressBytes(remote: string, bytes: number): boolean {
    return windowFor(this.addressBytes, remote, MINUTE_MS).take(
      bytes,
      this.limits.addressBytesPerMinute,
      this.now(),
    );
  }

  /** A fixed window per stream, on the registry's clock: the client stream's own byte counter. */
  streamWindow(): { take(bytes: number): boolean } {
    const window = new LocalWindow(MINUTE_MS);
    return {
      take: (bytes) => window.take(bytes, this.limits.streamBytesPerMinute, this.now()),
    };
  }

  /** Forgets a stream without telling either end; the caller tells whichever needs it. */
  forgetStream(link: Link, stream: number): StreamPeer | undefined {
    const peer = link.streams.get(stream);
    link.streams.delete(stream);
    return peer;
  }

  /**
   * Counts host to client payload bytes for a host against the minute's
   * total that the registry last reported plus what this machine has not
   * added yet; false means the limit is passed.
   */
  countBytes(hostId: string, bytes: number): boolean {
    const entry = this.hosts.get(hostId);
    if (!entry) return true;
    const window = this.byteWindow(entry);
    if (window.shared + window.pending + bytes > this.limits.bytesPerMinute) return false;
    window.pending += bytes;
    return true;
  }

  /** Adds the bytes counted here to the registry's totals and reads them back. */
  async flushBytes(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const entry of this.hosts.values()) {
      const window = this.byteWindow(entry);
      if (window.pending === 0 && (window.loaded || entry.links.length === 0)) continue;
      const pending = window.pending;
      window.pending = 0;
      const key = counterKey('bytes', entry.hostId, MINUTE_MS, window.window * MINUTE_MS);
      flushes.push(
        this.counters.add(key, pending, MINUTE_MS).then(
          (total) => {
            if (entry.bytes !== window) return;
            // Bytes counted while the registry answered are still pending.
            window.shared = total;
            window.loaded = true;
          },
          () => {
            // Added again on the next flush.
            if (entry.bytes === window) window.pending += pending;
          },
        ),
      );
    }
    await Promise.all(flushes);
  }

  /**
   * Counts one push frame for a host; false means the hour's limit is passed,
   * by the registry or, while it cannot be reached, by the local counter.
   */
  countPush(hostId: string): Promise<boolean> {
    const entry = this.entry(hostId);
    return this.count(entry.pushes, 'pushes', hostId, this.limits.pushesPerHour, HOUR_MS);
  }

  /**
   * One unit of a fixed window limit: the registry's count, or the local one
   * while it is away or slower than the time limit.
   */
  private async count(
    local: LocalWindow,
    kind: string,
    subject: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    try {
      const counted = await withTimeout(
        this.counters.take(counterKey(kind, subject, windowMs, this.now()), 1, limit, windowMs),
        this.callTimeoutMs,
      );
      if (counted) local.add(1, this.now());
      return counted;
    } catch {
      return local.take(1, limit, this.now());
    }
  }

  /** Drops hosts with no links, no bytes left to add and nothing in their local counters. */
  sweep(): void {
    const now = this.now();
    for (const [hostId, entry] of this.hosts) {
      sweepWindows(entry.addressOpens, now);
      if (
        entry.links.length === 0 &&
        entry.reserved === 0 &&
        entry.bytes.pending === 0 &&
        entry.opens.idle(now) &&
        entry.pushes.idle(now) &&
        entry.addressOpens.size === 0
      ) {
        this.hosts.delete(hostId);
      }
    }
    sweepWindows(this.addressOpens, now);
    sweepWindows(this.addressBytes, now);
  }

  private byteWindow(entry: HostEntry): ByteWindow {
    const window = Math.floor(this.now() / MINUTE_MS);
    if (entry.bytes.window !== window) {
      // A new minute: bytes still pending belong to the old one and no longer count.
      entry.bytes = { window, shared: 0, pending: 0, loaded: false };
    }
    return entry.bytes;
  }

  private entry(hostId: string): HostEntry {
    let entry = this.hosts.get(hostId);
    if (!entry) {
      entry = {
        hostId,
        links: [],
        cursor: 0,
        reserved: 0,
        reservedFrom: new Map(),
        bytes: { window: Math.floor(this.now() / MINUTE_MS), shared: 0, pending: 0, loaded: false },
        opens: new LocalWindow(HOUR_MS),
        pushes: new LocalWindow(HOUR_MS),
        addressOpens: new Map(),
      };
      this.hosts.set(hostId, entry);
    }
    return entry;
  }

  /**
   * The next unused id on `link`, counting up from 1. Ids are not reused
   * while the link lives; after 2^32 - 1 opens the counter wraps and skips
   * ids still open, which only a link alive for years would ever reach.
   */
  private allocate(link: Link): number {
    let id = this.nextIds.get(link) ?? 1;
    while (link.streams.has(id)) id = id >= MAX_STREAM_ID ? 1 : id + 1;
    this.nextIds.set(link, id >= MAX_STREAM_ID ? 1 : id + 1);
    return id;
  }
}

/**
 * A client address as the registry keys it: a hash, so the registry holds no
 * addresses, only counters that cannot be read back into one.
 */
export function addressKey(remote: string): string {
  return createHash('sha256').update(remote).digest('base64url').slice(0, 22);
}

function windowFor(windows: Map<string, LocalWindow>, key: string, windowMs: number): LocalWindow {
  let window = windows.get(key);
  if (!window) {
    window = new LocalWindow(windowMs);
    windows.set(key, window);
  }
  return window;
}

function sweepWindows(windows: Map<string, LocalWindow>, now: number): void {
  for (const [key, window] of windows) if (window.idle(now)) windows.delete(key);
}
