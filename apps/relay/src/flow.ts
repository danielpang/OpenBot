import { positiveIntFromEnv, type Reservation, type Refusal, type Ticket } from './budget.js';

// Flow control between sockets (docs/MOBILE_AND_VM_PLAN.md 5.8, "Each machine
// on its own"). Bytes from a fast sender must not pile up in memory behind a
// slow receiver, so every destination is an `Outlet` that watches its socket's
// `bufferedAmount`, and every source is a `Valve` that pauses its socket's
// reads (`ws.pause()`) while any outlet holds it.
//
// The relay has two directions, and they are not alike:
//
// - Client to host. Many client sockets write into one host link. The link's
//   outlet accounts for each source on its own: a stream with more than its
//   share outstanding in the link's buffer is paused alone, so one busy phone
//   does not stall the others, and when the link socket itself passes its
//   high-water mark every stream feeding it is paused until it drains.
// - Host to client. One link socket carries many streams, so pausing it for
//   one slow phone would stall every phone on that host. A client's outlet
//   therefore never holds the link: it accounts for its own buffer, and a
//   client that stays blocked past the delivery deadline is shed (1013). The
//   tunnel's per id credit window (RELAY_PROTOCOL.md 5.3) is what keeps the
//   host from sending a slow phone much more than it can take, and the 8 MiB
//   send buffer limit (3.4) stays the hard stop.
//
// An outlet is blocked from the moment its socket's buffer passes the
// high-water mark until it falls to the low-water mark. One that stays
// blocked for the delivery deadline is shed: `onShed` runs once and the
// caller closes that socket with 1013. A `send` that the machine's byte
// budget refuses is answered with the refusal, and the caller closes the
// source with 1013.

export interface FlowOptions {
  /** A destination whose buffer passes this pauses its sources. Default 1 MiB. */
  highWaterBytes: number;
  /** Paused sources resume once the destination's buffer is at or below this. Default 256 KiB. */
  lowWaterBytes: number;
  /** One source with more than this outstanding in a shared destination is paused alone. Default 512 KiB. */
  sourceHighWaterBytes: number;
  /** ...and resumes once it has this much or less outstanding. Default 128 KiB. */
  sourceLowWaterBytes: number;
  /** A destination blocked this long is shed with 1013. Default 30 seconds. */
  deliveryTimeoutMs: number;
  /** How often blocked destinations are checked against the deadline. Default 1 second. */
  sweepIntervalMs: number;
}

export const DEFAULT_FLOW: FlowOptions = {
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  sourceHighWaterBytes: 512 * 1024,
  sourceLowWaterBytes: 128 * 1024,
  deliveryTimeoutMs: 30_000,
  sweepIntervalMs: 1_000,
};

/** What a source must offer: `ws` WebSocket's `pause` and `resume`. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}

/** What a destination must offer: a `ws` WebSocket. */
export interface FlowSink {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Buffer | string, cb?: (err?: Error) => void): void;
}

/** `WebSocket.OPEN`, without importing ws for one number. */
const OPEN = 1;

export type SendResult =
  | { ok: true }
  /** The machine's byte budget is full: close the source with `refusal.closeCode` (1013). */
  | { ok: false; reason: 'budget'; refusal: Refusal }
  /** The destination is closed or was shed; the bytes were dropped. */
  | { ok: false; reason: 'closed' };

export interface OutletOptions {
  /** A label for logs and metrics, such as `client` or `host`. */
  kind: string;
  /** The destination stayed blocked past the deadline. Close it with 1013. Runs once. */
  onShed: (outlet: Outlet) => void;
  /** The destination's ticket: each send reserves its bytes there until the socket takes them. */
  ticket?: Ticket;
}

/**
 * The machine's flow control: it makes valves and outlets, counts the paused
 * sources and shed destinations for metrics, and sweeps blocked outlets
 * against the delivery deadline.
 */
export class FlowControl {
  readonly options: FlowOptions;
  private readonly outlets = new Set<Outlet>();
  private paused = 0;
  private shedCount = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    options: Partial<FlowOptions> = {},
    readonly now: () => number = Date.now,
  ) {
    this.options = { ...DEFAULT_FLOW, ...options };
    const o = this.options;
    if (
      !(o.lowWaterBytes < o.highWaterBytes) ||
      !(o.sourceLowWaterBytes < o.sourceHighWaterBytes)
    ) {
      throw new Error('each low-water mark must be below its high-water mark');
    }
  }

  /** Sources paused right now. */
  get pausedSources(): number {
    return this.paused;
  }

  /** Destinations blocked right now. */
  get blockedDestinations(): number {
    let count = 0;
    for (const outlet of this.outlets) if (outlet.blocked) count += 1;
    return count;
  }

  /** Destinations shed since this was made. */
  get shed(): number {
    return this.shedCount;
  }

  valve(source: PausableSource): Valve {
    return new Valve(source, this);
  }

  outlet(sink: FlowSink, options: OutletOptions): Outlet {
    const outlet = new Outlet(sink, this, options);
    this.outlets.add(outlet);
    return outlet;
  }

  /** Starts the deadline sweep. The timer does not hold the process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.options.sweepIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Checks every outlet now: resumes the drained, sheds the overdue. */
  sweep(now: number = this.now()): void {
    for (const outlet of [...this.outlets]) outlet.check(now);
  }

  /** @internal */
  pausedChanged(delta: 1 | -1): void {
    this.paused += delta;
  }

  /** @internal */
  forget(outlet: Outlet, shed: boolean): void {
    this.outlets.delete(outlet);
    if (shed) this.shedCount += 1;
  }
}

/**
 * A source socket that one or more outlets may hold. It is paused while any
 * hold is on it and resumed when the last one comes off.
 */
export class Valve {
  private readonly holds = new Set<object>();
  private closed = false;

  constructor(
    private readonly source: PausableSource,
    private readonly flow: FlowControl,
  ) {}

  get paused(): boolean {
    return this.holds.size > 0;
  }

  hold(by: object): void {
    if (this.closed || this.holds.has(by)) return;
    this.holds.add(by);
    if (this.holds.size === 1) {
      this.flow.pausedChanged(1);
      this.source.pause();
    }
  }

  release(by: object): void {
    if (!this.holds.delete(by) || this.holds.size > 0) return;
    this.flow.pausedChanged(-1);
    if (!this.closed) this.source.resume();
  }

  /** The source socket closed: drop every hold without touching it again. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.holds.size > 0) this.flow.pausedChanged(-1);
    this.holds.clear();
  }
}

/** One source's bytes outstanding in a shared outlet, and whether that alone holds it. */
interface SourceShare {
  outstanding: number;
  held: boolean;
}

/** A destination socket and the sources that feed it. */
export class Outlet {
  private readonly attached = new Set<Valve>();
  private readonly shares = new Map<Valve, SourceShare>();
  private blockedSince: number | undefined;
  private state: 'open' | 'shed' | 'closed' = 'open';

  constructor(
    private readonly sink: FlowSink,
    private readonly flow: FlowControl,
    private readonly options: OutletOptions,
  ) {}

  get kind(): string {
    return this.options.kind;
  }

  get blocked(): boolean {
    return this.blockedSince !== undefined;
  }

  /** How long the destination has been blocked, or 0. */
  blockedForMs(now: number = this.flow.now()): number {
    return this.blockedSince === undefined ? 0 : now - this.blockedSince;
  }

  /** Bytes `source` has sent through this outlet that the socket has not taken yet. */
  outstanding(source: Valve): number {
    return this.shares.get(source)?.outstanding ?? 0;
  }

  /**
   * Lets this outlet pause `source` whenever the destination is blocked. Only
   * attach a source whose every byte goes here: never a host link to one of
   * its clients' outlets.
   */
  attach(source: Valve): void {
    if (this.state !== 'open') return;
    this.attached.add(source);
    if (this.blocked) source.hold(this);
  }

  /** The source is gone (its stream closed): take this outlet's holds off it. */
  detach(source: Valve): void {
    this.attached.delete(source);
    const share = this.shares.get(source);
    if (share) this.shares.delete(source);
    source.release(this);
    if (share) source.release(share);
  }

  /**
   * Sends one frame to the destination. With `from`, the bytes count against
   * that source's share, and a source over its share is paused alone; pass it
   * only for an attached source.
   */
  send(data: Buffer | string, from?: Valve): SendResult {
    if (this.state !== 'open' || this.sink.readyState !== OPEN) {
      return { ok: false, reason: 'closed' };
    }
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    let reservation: Reservation | undefined;
    if (this.options.ticket) {
      const reserved = this.options.ticket.reserve(bytes);
      if (!reserved.ok) return { ok: false, reason: 'budget', refusal: reserved.refusal };
      reservation = reserved.reservation;
    }
    const share = from ? this.share(from) : undefined;
    if (share) share.outstanding += bytes;
    let done = false;
    this.sink.send(data, () => {
      // ws calls this once the socket has taken the frame, or with an error
      // once the socket is gone; either way the bytes are no longer in flight.
      if (done) return;
      done = true;
      reservation?.release();
      if (share) share.outstanding -= bytes;
      this.check();
    });
    if (from && share) this.checkShare(from, share);
    this.check();
    return { ok: true };
  }

  /** Compares the destination's buffer with the marks and the deadline. */
  check(now: number = this.flow.now()): void {
    if (this.state !== 'open') return;
    for (const [source, share] of this.shares) this.checkShare(source, share);
    const buffered = this.sink.bufferedAmount;
    const { highWaterBytes, lowWaterBytes, deliveryTimeoutMs } = this.flow.options;
    if (this.blockedSince === undefined) {
      if (buffered > highWaterBytes) {
        this.blockedSince = now;
        for (const source of this.attached) source.hold(this);
      }
      return;
    }
    if (buffered <= lowWaterBytes) {
      this.blockedSince = undefined;
      for (const source of this.attached) source.release(this);
      return;
    }
    if (now - this.blockedSince >= deliveryTimeoutMs) this.end('shed');
  }

  /**
   * The destination socket closed: its sources resume, its reservations are
   * given back (through the ticket, which the caller closes or binds), and
   * the outlet sends nothing more.
   */
  close(): void {
    this.end('closed');
  }

  private end(state: 'shed' | 'closed') {
    if (this.state !== 'open') return;
    this.state = state;
    this.blockedSince = undefined;
    for (const source of this.attached) source.release(this);
    for (const [source, share] of this.shares) source.release(share);
    this.attached.clear();
    this.shares.clear();
    this.flow.forget(this, state === 'shed');
    if (state === 'shed') this.options.onShed(this);
  }

  private share(source: Valve): SourceShare {
    let share = this.shares.get(source);
    if (!share) {
      share = { outstanding: 0, held: false };
      this.shares.set(source, share);
    }
    return share;
  }

  private checkShare(source: Valve, share: SourceShare) {
    const { sourceHighWaterBytes, sourceLowWaterBytes } = this.flow.options;
    if (!share.held && share.outstanding > sourceHighWaterBytes) {
      share.held = true;
      source.hold(share);
    } else if (share.held && share.outstanding <= sourceLowWaterBytes) {
      share.held = false;
      source.release(share);
    }
  }
}

/**
 * `RELAY_FLOW_HIGH_WATER_BYTES`, `RELAY_FLOW_LOW_WATER_BYTES` and
 * `RELAY_DELIVERY_TIMEOUT_MS`. The per source marks follow the destination's
 * at half of each.
 */
export function flowOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FlowOptions {
  const highWaterBytes = positiveIntFromEnv(
    env,
    'RELAY_FLOW_HIGH_WATER_BYTES',
    DEFAULT_FLOW.highWaterBytes,
  );
  const lowWaterBytes = positiveIntFromEnv(
    env,
    'RELAY_FLOW_LOW_WATER_BYTES',
    DEFAULT_FLOW.lowWaterBytes,
  );
  if (lowWaterBytes >= highWaterBytes) {
    throw new Error('RELAY_FLOW_LOW_WATER_BYTES must be below RELAY_FLOW_HIGH_WATER_BYTES');
  }
  const sourceLowWaterBytes = Math.max(1, Math.floor(lowWaterBytes / 2));
  return {
    ...DEFAULT_FLOW,
    highWaterBytes,
    lowWaterBytes,
    sourceHighWaterBytes: Math.max(sourceLowWaterBytes + 1, Math.floor(highWaterBytes / 2)),
    sourceLowWaterBytes,
    deliveryTimeoutMs: positiveIntFromEnv(
      env,
      'RELAY_DELIVERY_TIMEOUT_MS',
      DEFAULT_FLOW.deliveryTimeoutMs,
    ),
  };
}
