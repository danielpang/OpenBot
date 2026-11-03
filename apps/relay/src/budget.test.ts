import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  budgetOptionsFromEnv,
  DEFAULT_BUDGET,
  NodeBudget,
  positiveIntFromEnv,
  SERVICE_UNAVAILABLE,
  TRY_AGAIN_LATER,
  type Ticket,
} from './budget.js';

function admitted(budget: NodeBudget, kind: 'host' | 'client' = 'client'): Ticket {
  const admission = budget.admit(kind);
  if (!admission.ok) throw new Error('expected an admission');
  return admission.ticket;
}

describe('NodeBudget', () => {
  it('has the defaults of plan 5.8', () => {
    expect(DEFAULT_BUDGET).toEqual({ maxBytes: 512 * 1024 * 1024, maxSockets: 20_000 });
    expect(new NodeBudget().options).toEqual(DEFAULT_BUDGET);
  });

  it('refuses a zero or negative limit', () => {
    expect(() => new NodeBudget({ maxBytes: 0 })).toThrow();
    expect(() => new NodeBudget({ maxSockets: -1 })).toThrow();
  });

  it('admits sockets up to the ceiling and refuses the next with 1013 and 503', () => {
    const budget = new NodeBudget({ maxSockets: 2 });
    admitted(budget, 'host');
    expect(budget.full).toBe(false);
    admitted(budget, 'client');
    expect(budget.full).toBe(true);
    const third = budget.admit('client');
    expect(third).toEqual({
      ok: false,
      refusal: { reason: 'sockets', closeCode: TRY_AGAIN_LATER, httpStatus: SERVICE_UNAVAILABLE },
    });
    expect(TRY_AGAIN_LATER).toBe(1013);
    expect(SERVICE_UNAVAILABLE).toBe(503);
    expect(budget.snapshot()).toMatchObject({
      sockets: 2,
      socketsByKind: { host: 1, client: 1 },
      refusals: { sockets: 1, bytes: 0, closed: 0 },
    });
  });

  it('frees a slot when a ticket closes, once however often it is closed', () => {
    const budget = new NodeBudget({ maxSockets: 1 });
    const ticket = admitted(budget);
    ticket.close();
    ticket.close();
    expect(budget.sockets).toBe(0);
    expect(budget.admit('host').ok).toBe(true);
    expect(budget.sockets).toBe(1);
  });

  it('reserves bytes up to the budget and refuses what would pass it', () => {
    const budget = new NodeBudget({ maxBytes: 100 });
    const a = admitted(budget);
    const b = admitted(budget);
    const first = a.reserve(60);
    expect(first.ok).toBe(true);
    expect(b.reserve(40).ok).toBe(true);
    expect(budget.bytesInFlight).toBe(100);
    const over = b.reserve(1);
    expect(over).toEqual({
      ok: false,
      refusal: { reason: 'bytes', closeCode: 1013, httpStatus: 503 },
    });
    if (first.ok) first.reservation.release();
    expect(budget.bytesInFlight).toBe(40);
    expect(b.reserve(60).ok).toBe(true);
    expect(budget.bytesInFlight).toBe(100);
  });

  it('refuses one reservation larger than the whole budget', () => {
    const budget = new NodeBudget({ maxBytes: 10 });
    expect(admitted(budget).reserve(11).ok).toBe(false);
    expect(budget.bytesInFlight).toBe(0);
  });

  it('releases a reservation once, even when released again or after the ticket closed', () => {
    const budget = new NodeBudget({ maxBytes: 100 });
    const ticket = admitted(budget);
    const reserved = ticket.reserve(30);
    if (!reserved.ok) throw new Error('expected a reservation');
    reserved.reservation.release();
    reserved.reservation.release();
    expect(budget.bytesInFlight).toBe(0);
    const again = ticket.reserve(30);
    if (!again.ok) throw new Error('expected a reservation');
    ticket.close();
    expect(budget.bytesInFlight).toBe(0);
    // A write callback that arrives after the socket closed changes nothing.
    again.reservation.release();
    expect(budget.bytesInFlight).toBe(0);
  });

  it('gives back every reservation a ticket holds when it closes', () => {
    const budget = new NodeBudget({ maxBytes: 1_000 });
    const keep = admitted(budget);
    const gone = admitted(budget);
    keep.reserve(100);
    for (let i = 0; i < 5; i++) gone.reserve(50);
    expect(gone.reservedBytes).toBe(250);
    expect(budget.bytesInFlight).toBe(350);
    gone.close();
    expect(budget.bytesInFlight).toBe(100);
    expect(keep.reservedBytes).toBe(100);
  });

  it('refuses a reservation on a closed ticket', () => {
    const budget = new NodeBudget();
    const ticket = admitted(budget);
    ticket.close();
    const result = ticket.reserve(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe('closed');
  });

  it('never passes the budget with many reservers interleaved, and ends at zero', async () => {
    const budget = new NodeBudget({ maxBytes: 10_000, maxSockets: 50 });
    let peak = 0;
    let refused = 0;
    const reserver = async (seed: number) => {
      const ticket = admitted(budget);
      for (let i = 0; i < 200; i++) {
        const bytes = ((seed * 7919 + i * 104_729) % 900) + 1;
        const result = ticket.reserve(bytes);
        if (!result.ok) {
          refused += 1;
        } else {
          peak = Math.max(peak, budget.bytesInFlight);
          // Writes complete in any order, a few turns of the event loop later.
          const turns = (seed + i) % 4;
          void (async () => {
            for (let t = 0; t < turns; t++) await Promise.resolve();
            result.reservation.release();
          })();
        }
        if (i % 3 === seed % 3) await Promise.resolve();
      }
      // Half the reservers go away holding whatever is still unreleased.
      if (seed % 2 === 0) ticket.close();
      for (let t = 0; t < 5; t++) await Promise.resolve();
      ticket.close();
    };
    await Promise.all(Array.from({ length: 40 }, (_, seed) => reserver(seed)));
    for (let t = 0; t < 10; t++) await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(10_000);
    expect(refused).toBeGreaterThan(0);
    expect(budget.bytesInFlight).toBe(0);
    expect(budget.sockets).toBe(0);
  });

  it('closes a bound ticket on any emitter close', () => {
    const budget = new NodeBudget();
    const socket = new EventEmitter();
    const ticket = admitted(budget).bind(socket);
    ticket.reserve(500);
    socket.emit('close');
    expect(ticket.closed).toBe(true);
    expect(budget.snapshot()).toMatchObject({ bytesInFlight: 0, sockets: 0 });
  });
});

describe('a ticket bound to a real socket', () => {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;

  afterEach(async () => {
    wss?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    wss = undefined;
  });

  it('gives everything back when the peer drops without a close frame', async () => {
    const budget = new NodeBudget({ maxBytes: 10_000 });
    server = createServer();
    wss = new WebSocketServer({ noServer: true });
    const bound = new Promise<Ticket>((resolve) => {
      server!.on('upgrade', (req, socket, head) => {
        const admission = budget.admit('client');
        if (!admission.ok) throw new Error('expected an admission');
        // Bound to the raw socket at upgrade time: it closes whatever happens next.
        admission.ticket.bind(socket);
        wss!.handleUpgrade(req, socket, head, () => resolve(admission.ticket));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => client.once('open', resolve));
    const ticket = await bound;
    ticket.reserve(4_000);
    ticket.reserve(4_000);
    expect(budget.snapshot()).toMatchObject({ bytesInFlight: 8_000, sockets: 1 });

    client.terminate();
    await expect.poll(() => budget.sockets).toBe(0);
    expect(budget.bytesInFlight).toBe(0);
    expect(ticket.closed).toBe(true);
  });
});

describe('settings', () => {
  it('reads the budget from the environment', () => {
    expect(budgetOptionsFromEnv({})).toEqual(DEFAULT_BUDGET);
    expect(budgetOptionsFromEnv({ RELAY_BUDGET_BYTES: '1024', RELAY_MAX_SOCKETS: '' })).toEqual({
      maxBytes: 1024,
      maxSockets: 20_000,
    });
    expect(() => budgetOptionsFromEnv({ RELAY_MAX_SOCKETS: 'lots' })).toThrow(/RELAY_MAX_SOCKETS/);
  });

  it('wants a positive integer', () => {
    expect(positiveIntFromEnv({ X: ' 7 ' }, 'X', 1)).toBe(7);
    expect(() => positiveIntFromEnv({ X: '0' }, 'X', 1)).toThrow();
    expect(() => positiveIntFromEnv({ X: '1.5' }, 'X', 1)).toThrow();
  });
});
