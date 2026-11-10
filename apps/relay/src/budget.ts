// The machine's ledger (docs/plans/MOBILE_AND_VM_PLAN.md 5.8, "Each machine on its
// own"): one budget for the bytes in flight on this machine, and one ceiling
// on its sockets. Every socket gets a ticket when it is admitted, and every
// byte the relay holds for a destination is reserved on that destination's
// ticket until the destination's socket has taken it. Closing a ticket gives
// back its socket slot and every reservation it still holds, so a socket
// that goes away abnormally (terminated, reset, never finishing its write
// callbacks) still returns everything it held. Binding the ticket to the
// socket's `close` event does that without the caller remembering to.
//
// Every host also has a share of the byte budget (`hostShare`, a fraction of
// `maxBytes`): the bytes reserved for its links and its streams together. A
// host at its share is refused more even while the machine has room, so one
// host with many busy or slow phones cannot starve the others on the machine.
//
// The socket ceiling has two steps. At `maxSockets` the machine refuses
// sockets for hosts it does not serve yet (503, so the proxy picks another
// machine) but still admits links and streams of the hosts it owns, which no
// other machine can serve. At the hard ceiling, 10 percent above, it refuses
// everything.
//
// A refusal says how to answer: close the socket with 1013 (try again later)
// when it is already a WebSocket, or refuse the upgrade with 503 so Fly's
// proxy tries another machine.

/** WebSocket close code 1013, try again later: the machine is too busy for this socket. */
export const TRY_AGAIN_LATER = 1013;
/** The HTTP status for an upgrade the machine has no room for. */
export const SERVICE_UNAVAILABLE = 503;

export type SocketKind = 'host' | 'client';

export const SOCKET_KINDS: readonly SocketKind[] = ['host', 'client'];

export interface BudgetOptions {
  /** Bytes in flight on this machine, across every socket. Default 512 MiB. */
  maxBytes: number;
  /**
   * Sockets on this machine, host links and client streams together, past
   * which only hosts this machine owns are admitted. Default 20,000. The hard
   * ceiling, which refuses everything, is 10 percent above it.
   */
  maxSockets: number;
  /** The share of `maxBytes` one host's sockets may hold together, above 0 and at most 1. Default 0.125. */
  hostShare: number;
}

export const DEFAULT_BUDGET: BudgetOptions = {
  maxBytes: 512 * 1024 * 1024,
  maxSockets: 20_000,
  hostShare: 0.125,
};

/** `host`: the host's own share is full, though the machine may have room. */
export type RefusalReason = 'sockets' | 'bytes' | 'host' | 'closed';

/** Why the ledger said no, and how to say so to the peer. */
export interface Refusal {
  reason: RefusalReason;
  /** For a socket that is already a WebSocket. */
  closeCode: typeof TRY_AGAIN_LATER;
  /** For an upgrade that has not completed. */
  httpStatus: typeof SERVICE_UNAVAILABLE;
}

export type Admission = { ok: true; ticket: Ticket } | { ok: false; refusal: Refusal };

export type ReserveResult =
  { ok: true; reservation: Reservation } | { ok: false; refusal: Refusal };

export interface BudgetSnapshot {
  bytesInFlight: number;
  maxBytes: number;
  sockets: number;
  socketsByKind: Record<SocketKind, number>;
  maxSockets: number;
  /** The bytes one host may hold: `hostShare` of `maxBytes`. */
  hostMaxBytes: number;
  /** The most bytes any one host holds right now. */
  largestHostBytes: number;
  /** Refusals since the ledger was made, by reason. */
  refusals: Record<RefusalReason, number>;
}

/** What a ticket can be bound to: a `ws` WebSocket, or the raw socket of an upgrade. */
export interface Closable {
  once(event: 'close', listener: () => void): unknown;
}

function refusal(reason: RefusalReason): Refusal {
  return { reason, closeCode: TRY_AGAIN_LATER, httpStatus: SERVICE_UNAVAILABLE };
}

/** The ledger for one machine. Single threaded, so a reservation is checked and taken at once. */
export class NodeBudget {
  readonly options: BudgetOptions;
  private bytes = 0;
  private readonly kinds: Record<SocketKind, number> = { host: 0, client: 0 };
  private readonly refused: Record<RefusalReason, number> = {
    sockets: 0,
    bytes: 0,
    host: 0,
    closed: 0,
  };
  /** Bytes held per host id; a host holding none has no entry. */
  private readonly hosts = new Map<string, number>();
  /** The bytes one host may hold. */
  readonly hostMaxBytes: number;
  /** Sockets past which nothing at all is admitted. */
  readonly hardMaxSockets: number;

  constructor(options: Partial<BudgetOptions> = {}) {
    this.options = { ...DEFAULT_BUDGET, ...options };
    if (!(this.options.maxBytes > 0) || !(this.options.maxSockets > 0)) {
      throw new Error('the budget needs a positive byte budget and socket ceiling');
    }
    const { hostShare } = this.options;
    if (!(hostShare > 0 && hostShare <= 1)) {
      throw new Error('the host share must be above 0 and at most 1');
    }
    this.hostMaxBytes = Math.max(1, Math.floor(this.options.maxBytes * hostShare));
    this.hardMaxSockets = Math.ceil(this.options.maxSockets * 1.1);
  }

  /** Bytes the host's sockets hold right now. */
  hostBytes(hostId: string): number {
    return this.hosts.get(hostId) ?? 0;
  }

  /** The most bytes any one host holds right now: the gauge of the largest share in use. */
  get largestHostBytes(): number {
    let largest = 0;
    for (const bytes of this.hosts.values()) largest = Math.max(largest, bytes);
    return largest;
  }

  get bytesInFlight(): number {
    return this.bytes;
  }

  get sockets(): number {
    return this.kinds.host + this.kinds.client;
  }

  /** At the socket ceiling: `/ready` reports it, and the next upgrade is refused. */
  get full(): boolean {
    return this.sockets >= this.options.maxSockets;
  }

  /**
   * Admits one socket of `kind`, or refuses it at the ceiling. `owned` says
   * the machine owns the socket's host: such a socket is admitted past the
   * ceiling, up to the hard ceiling. Call it before the upgrade, so a refusal
   * is a 503, and bind the ticket to the raw socket.
   */
  admit(kind: SocketKind, hostId?: string, owned = false): Admission {
    const ceiling = owned ? this.hardMaxSockets : this.options.maxSockets;
    if (this.sockets >= ceiling) return { ok: false, refusal: this.refuse('sockets') };
    this.kinds[kind] += 1;
    return { ok: true, ticket: new Ticket(this, kind, hostId) };
  }

  snapshot(): BudgetSnapshot {
    return {
      bytesInFlight: this.bytes,
      maxBytes: this.options.maxBytes,
      sockets: this.sockets,
      socketsByKind: { ...this.kinds },
      maxSockets: this.options.maxSockets,
      hostMaxBytes: this.hostMaxBytes,
      largestHostBytes: this.largestHostBytes,
      refusals: { ...this.refused },
    };
  }

  /** @internal Takes `n` bytes if they fit the machine and the host's share; answers why not. */
  take(n: number, hostId?: string): RefusalReason | null {
    if (this.bytes + n > this.options.maxBytes) return 'bytes';
    if (hostId !== undefined) {
      const held = this.hostBytes(hostId);
      if (held + n > this.hostMaxBytes) return 'host';
      this.hosts.set(hostId, held + n);
    }
    this.bytes += n;
    return null;
  }

  /** @internal */
  give(n: number, hostId?: string): void {
    this.bytes -= n;
    if (hostId === undefined) return;
    const left = this.hostBytes(hostId) - n;
    if (left > 0) this.hosts.set(hostId, left);
    else this.hosts.delete(hostId);
  }

  /** @internal */
  leave(kind: SocketKind): void {
    this.kinds[kind] -= 1;
  }

  /** @internal */
  refuse(reason: RefusalReason): Refusal {
    this.refused[reason] += 1;
    return refusal(reason);
  }
}

/**
 * One admitted socket's share of the ledger: its slot, and the bytes reserved
 * for it. `close` gives all of it back, once.
 */
export class Ticket {
  private open = true;
  private readonly held = new Set<Reservation>();
  private heldBytes = 0;

  constructor(
    private readonly budget: NodeBudget,
    readonly kind: SocketKind,
    /** The host this socket belongs to, whose share its bytes count against. */
    readonly hostId?: string,
  ) {}

  get closed(): boolean {
    return !this.open;
  }

  /** Bytes this socket holds right now. */
  get reservedBytes(): number {
    return this.heldBytes;
  }

  /**
   * Reserves `bytes` for this socket, or refuses when the machine's budget
   * or its host's share would pass its limit (the caller closes the source
   * with 1013) or the ticket is already closed.
   */
  reserve(bytes: number): ReserveResult {
    if (!this.open) return { ok: false, refusal: this.budget.refuse('closed') };
    const n = Math.max(0, Math.ceil(bytes));
    const refused = this.budget.take(n, this.hostId);
    if (refused) return { ok: false, refusal: this.budget.refuse(refused) };
    const reservation = new Reservation(this, n);
    this.held.add(reservation);
    this.heldBytes += n;
    return { ok: true, reservation };
  }

  /** Closes the ticket when `socket` closes, however it closes. */
  bind(socket: Closable): this {
    socket.once('close', () => this.close());
    return this;
  }

  /** Gives back the slot and every reservation still held. Safe to call more than once. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const reservation of [...this.held]) reservation.release();
    this.budget.leave(this.kind);
  }

  /** @internal */
  drop(reservation: Reservation): void {
    if (!this.held.delete(reservation)) return;
    this.heldBytes -= reservation.bytes;
    this.budget.give(reservation.bytes, this.hostId);
  }
}

/** Bytes held for one write. `release` is safe to call more than once, and after the ticket closed. */
export class Reservation {
  constructor(
    private readonly ticket: Ticket,
    readonly bytes: number,
  ) {}

  release(): void {
    this.ticket.drop(this);
  }
}

/**
 * A positive integer setting from the environment, or `fallback` when it is
 * unset or empty. Anything else is a configuration error.
 */
export function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * `RELAY_BUDGET_BYTES` and `RELAY_MAX_SOCKETS`. The host share
 * (`RELAY_HOST_BUDGET_SHARE`, a fraction) is validated in config.ts and
 * passed in; here it keeps its default.
 */
export function budgetOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetOptions {
  return {
    maxBytes: positiveIntFromEnv(env, 'RELAY_BUDGET_BYTES', DEFAULT_BUDGET.maxBytes),
    maxSockets: positiveIntFromEnv(env, 'RELAY_MAX_SOCKETS', DEFAULT_BUDGET.maxSockets),
    hostShare: DEFAULT_BUDGET.hostShare,
  };
}
