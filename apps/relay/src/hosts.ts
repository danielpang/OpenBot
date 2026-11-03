// The registry of linked hosts (docs/RELAY_PROTOCOL.md 3.1, 3.4 and 3.5). Per
// host id it keeps the links this process holds, the round-robin cursor that
// spreads new client streams over the links that serve `streams`, and the
// counters for the per-host limits. It knows nothing about sockets: a link is
// whatever can carry `open`, data and `close` frames to its host, and a stream
// is whatever can take the host's payloads and close.
//
// Everything here is in memory, for a single relay instance. The links are
// sockets and stay local to the process that holds them; what several
// instances would share through Redis is presence (which host ids are linked
// somewhere) and the counters, so `Presence` is the seam: the HTTP presence
// route asks it, and a Redis-backed one can answer for every instance.

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
  /** Sends one client payload to the host. */
  sendData(stream: number, payload: Buffer): void;
  /** Tells the host the client closed `stream`. */
  sendClose(stream: number, code: number, reason: string): void;
}

/** Answers whether a host is linked; the seam a shared presence store replaces. */
export interface Presence {
  linked(hostId: string): Promise<boolean>;
}

/**
 * A fixed window counter: at most `limit` units in each window of `windowMs`.
 * A fixed window lets a host spend up to twice its limit across a window
 * boundary, which is close enough for abuse limits and costs two numbers.
 */
export class WindowCounter {
  private start = 0;
  private count = 0;

  constructor(
    readonly windowMs: number,
    readonly limit: number,
  ) {}

  /** Counts `n` units unless they would pass the limit; answers whether they were counted. */
  take(n: number, now: number): boolean {
    if (now - this.start >= this.windowMs) {
      this.start = now;
      this.count = 0;
    }
    if (this.count + n > this.limit) return false;
    this.count += n;
    return true;
  }

  /** Whether the counter holds nothing that still matters. */
  idle(now: number): boolean {
    return this.count === 0 || now - this.start >= this.windowMs;
  }
}

interface HostEntry {
  hostId: string;
  links: Link[];
  cursor: number;
  opens: WindowCounter;
  bytes: WindowCounter;
  pushes: WindowCounter;
}

export type OpenResult =
  { ok: true; link: Link; stream: number } | { ok: false; code: number; reason: string };

export class HostRegistry implements Presence {
  private readonly hosts = new Map<string, HostEntry>();
  /** The next stream id each link hands out; ids are never reused while a link lives. */
  private readonly nextIds = new WeakMap<Link, number>();

  constructor(
    readonly limits: RelayLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  addLink(link: Link): void {
    this.entry(link.hostId).links.push(link);
    this.nextIds.set(link, 1);
  }

  /**
   * Forgets `link` and ends every stream it served with 4410. The host's
   * counters outlive its links, so a host cannot reset its limits by
   * relinking; `sweep` drops them once they no longer count.
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

  isLinked(hostId: string): boolean {
    return (this.hosts.get(hostId)?.links.length ?? 0) > 0;
  }

  linked(hostId: string): Promise<boolean> {
    return Promise.resolve(this.isLinked(hostId));
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
   */
  openStream(hostId: string, peer: StreamPeer, remote: string): OpenResult {
    const entry = this.hosts.get(hostId);
    const serving = entry?.links.filter((link) => link.capabilities.has('streams')) ?? [];
    if (!entry || serving.length === 0) return { ok: false, code: 4404, reason: 'host offline' };
    if (this.openStreams(hostId) >= this.limits.streamsPerHost) {
      return { ok: false, code: 4429, reason: 'too many streams' };
    }
    if (!entry.opens.take(1, this.now())) {
      return { ok: false, code: 4429, reason: 'too many stream opens' };
    }
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

  /** Counts stream payload bytes for a host; false means the minute's limit is passed. */
  countBytes(hostId: string, bytes: number): boolean {
    const entry = this.hosts.get(hostId);
    return entry ? entry.bytes.take(bytes, this.now()) : true;
  }

  /** Counts one push frame for a host; false means the hour's limit is passed. */
  countPush(hostId: string): boolean {
    const entry = this.hosts.get(hostId);
    return entry ? entry.pushes.take(1, this.now()) : true;
  }

  /** Drops hosts with no links whose counters have all run out. */
  sweep(): void {
    const now = this.now();
    for (const [hostId, entry] of this.hosts) {
      if (entry.links.length > 0) continue;
      if (entry.opens.idle(now) && entry.bytes.idle(now) && entry.pushes.idle(now)) {
        this.hosts.delete(hostId);
      }
    }
  }

  private entry(hostId: string): HostEntry {
    let entry = this.hosts.get(hostId);
    if (!entry) {
      entry = {
        hostId,
        links: [],
        cursor: 0,
        opens: new WindowCounter(HOUR_MS, this.limits.opensPerHour),
        bytes: new WindowCounter(MINUTE_MS, this.limits.bytesPerMinute),
        pushes: new WindowCounter(HOUR_MS, this.limits.pushesPerHour),
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
