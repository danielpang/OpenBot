import type { Outlet, SendResult, Valve } from './flow.js';
import { counterKey, type Registry } from './registry.js';

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
// When the registry cannot be reached the limits do not lapse: each host also
// has local window counters with the same limits and windows, which count
// everything this machine lets through, and decide on their own until the
// registry answers again. That is more permissive across machines than the
// shared limit, but never unlimited. Bytes need no extra counter: the
// minute's check already adds what is pending here to the registry's last
// total, and bytes that could not be added stay pending.

export type Capability = 'streams' | 'push';

export const CAPABILITIES: readonly Capability[] = ['streams', 'push'];

/** The per-host limits of 3.4, and the link limits beside them. */
export interface RelayLimits {
  /** Open streams per host, across its links; the next client is closed 4429. */
  streamsPerHost: number;
  /** Stream opens per host an hour; the next client is closed 4429. */
  opensPerHour: number;
  /** Stream payload bytes per host a minute, both directions; the link is closed 1008. */
  bytesPerMinute: number;
  /** Push frames per host an hour; the next gets `push.result` error 429. */
  pushesPerHour: number;
  /** A socket whose send buffer passes this is closed 1008. */
  maxBufferedBytes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  streamsPerHost: 8,
  opensPerHour: 1_000,
  bytesPerMinute: 50_000_000,
  pushesPerHour: 600,
  maxBufferedBytes: 8 * 1024 * 1024,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_STREAM_ID = 0xffff_ffff;

/** The client side of one stream, as the link sees it. */
export interface StreamPeer {
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
class LocalWindow {
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
  bytes: ByteWindow;
  /** The hour's opens and pushes on this machine, which decide while the registry is away. */
  opens: LocalWindow;
  pushes: LocalWindow;
}

export type OpenResult =
  { ok: true; link: Link; stream: number } | { ok: false; code: number; reason: string };

export class HostRegistry {
  private readonly hosts = new Map<string, HostEntry>();
  /** The next stream id each link hands out; ids are never reused while a link lives. */
  private readonly nextIds = new WeakMap<Link, number>();

  constructor(
    readonly limits: RelayLimits,
    private readonly counters: Registry,
    private readonly now: () => number = Date.now,
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

  /**
   * Opens a stream for a client on the host's next `streams` link in turn,
   * after the limits of 3.4, and tells the host. The caller tells the client.
   * The hour's opens are counted in the registry; if it cannot be reached
   * the host's local counter decides.
   */
  async openStream(hostId: string, peer: StreamPeer, remote: string): Promise<OpenResult> {
    const entry = this.hosts.get(hostId);
    if (!entry || !this.hasStreams(hostId))
      return { ok: false, code: 4404, reason: 'host offline' };
    if (this.openStreams(hostId) + entry.reserved >= this.limits.streamsPerHost) {
      return { ok: false, code: 4429, reason: 'too many streams' };
    }
    entry.reserved += 1;
    let counted: boolean;
    try {
      counted = await this.count(entry.opens, 'opens', hostId, this.limits.opensPerHour);
    } finally {
      entry.reserved -= 1;
    }
    if (!counted) return { ok: false, code: 4429, reason: 'too many stream opens' };
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

  /** Forgets a stream without telling either end; the caller tells whichever needs it. */
  forgetStream(link: Link, stream: number): StreamPeer | undefined {
    const peer = link.streams.get(stream);
    link.streams.delete(stream);
    return peer;
  }

  /**
   * Counts stream payload bytes for a host against the minute's total that
   * the registry last reported plus what this machine has not added yet;
   * false means the limit is passed.
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
    return this.count(entry.pushes, 'pushes', hostId, this.limits.pushesPerHour);
  }

  /** One unit of an hourly limit: the registry's count, or the local one while it is away. */
  private async count(
    local: LocalWindow,
    kind: string,
    hostId: string,
    limit: number,
  ): Promise<boolean> {
    try {
      const counted = await this.counters.take(
        counterKey(kind, hostId, HOUR_MS, this.now()),
        1,
        limit,
        HOUR_MS,
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
      if (
        entry.links.length === 0 &&
        entry.reserved === 0 &&
        entry.bytes.pending === 0 &&
        entry.opens.idle(now) &&
        entry.pushes.idle(now)
      ) {
        this.hosts.delete(hostId);
      }
    }
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
        bytes: { window: Math.floor(this.now() / MINUTE_MS), shared: 0, pending: 0, loaded: false },
        opens: new LocalWindow(HOUR_MS),
        pushes: new LocalWindow(HOUR_MS),
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
