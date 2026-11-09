// @vitest-environment happy-dom
import type { WsClient } from '@openbots/api-client';
import type { WsEvent } from '@openbots/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeContext,
  RealtimeStatusContext,
  type Realtime,
  type RealtimeStatus,
} from '../transcript/realtime.js';
import {
  clockSkew,
  countdown,
  DevicesSettings,
  pairedByThis,
  RELAY_POLL_MS,
  relativeTime,
  relayQuery,
  type Device,
} from './devices.js';

// Settings > Devices against a fake server: the list, pairing with its QR
// code and countdown, revoke after the confirm, and the relay's status line,
// which follows `relay.status` and is read again when the socket reconnects.

const PHONE = '00000000-0000-4000-8000-0000000000d1';
const LINK = 'openbots://pair#v=1&host=h1&key=k&code=c';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string }[],
    devices: [] as Record<string, unknown>[],
    relay: {} as Record<string, unknown>,
    /** The pairing answer, or a problem code with 409. */
    pairing: null as Record<string, unknown> | null,
    pairingProblem: null as string | null,
    /** The pairing answer's Date header, the server's clock; none when null. */
    pairingDate: null as string | null,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    state.requests.push({ method: request.method, path });
    if (path === '/api/v1/devices' && request.method === 'GET') {
      return Response.json({ items: state.devices });
    }
    if (path === '/api/v1/devices/pairings') {
      if (state.pairingProblem) {
        return Response.json(
          { title: 'Too many', status: 409, code: state.pairingProblem },
          { status: 409 },
        );
      }
      return Response.json(state.pairing, {
        status: 201,
        headers: state.pairingDate ? { date: state.pairingDate } : {},
      });
    }
    if (path.startsWith('/api/v1/devices/') && request.method === 'DELETE') {
      state.devices = state.devices.filter((d) => !path.endsWith(String(d.id)));
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/relay') return Response.json(state.relay);
    return Response.json({});
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const device = (over: Partial<Device> = {}): Device => ({
  id: PHONE,
  name: "Ada's iPhone",
  platform: 'ios',
  createdAt: '2026-10-20T10:00:00.000Z',
  lastSeenAt: null,
  pushRegistered: false,
  ...over,
});

function fakeRealtime() {
  const handlers = new Map<string, Set<(e: WsEvent) => void>>();
  const client = {
    on(type: string, handler: (e: WsEvent) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)!.delete(handler);
    },
  } as unknown as WsClient;
  const realtime: Realtime = { client, onResync: () => () => {} };
  const emit = (type: string, payload: unknown) =>
    act(() => {
      for (const h of handlers.get(type) ?? []) h({ type, ts: 0, payload } as WsEvent);
    });
  return { realtime, emit };
}

let root: Root;
let host: HTMLElement;
let live: ReturnType<typeof fakeRealtime>;

beforeEach(() => {
  server.requests.length = 0;
  server.devices = [];
  server.relay = { hostId: 'h1', relayUrl: null, status: 'off', since: null };
  server.pairing = {
    id: '00000000-0000-4000-8000-0000000000e1',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    link: LINK,
    qr: {},
  };
  server.pairingProblem = null;
  server.pairingDate = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  live = fakeRealtime();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** Sets the realtime connection's status the page sees. */
let setSocketStatus: (status: RealtimeStatus['status']) => void = () => {};

function WithStatus({ initial }: { initial: RealtimeStatus['status'] }) {
  const [status, setStatus] = useState<RealtimeStatus>({
    status: initial,
    everOpen: initial === 'open',
  });
  setSocketStatus = (next) =>
    act(() =>
      setStatus((current) => ({ status: next, everOpen: current.everOpen || next === 'open' })),
    );
  return (
    <RealtimeStatusContext value={status}>
      <DevicesSettings />
    </RealtimeStatusContext>
  );
}

function render(socket: RealtimeStatus['status'] = 'open') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RealtimeContext value={live.realtime}>
          <WithStatus initial={socket} />
        </RealtimeContext>
      </QueryClientProvider>,
    ),
  );
}

const relayReads = () => server.requests.filter((r) => r.path === '/api/v1/relay').length;

// Dialogs render in a portal on the body.
const page = () => document.body.textContent ?? '';

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${page()}`);
}

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
const dialog = () => document.body.querySelector('[role="dialog"]');

describe('Settings > Devices', () => {
  it('lists the devices with platform, dates, last seen and push', async () => {
    server.devices = [
      device({ lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), pushRegistered: true }),
      device({
        id: '00000000-0000-4000-8000-0000000000d2',
        name: 'Pixel',
        platform: 'android',
      }),
    ];
    render();
    await until(() => page().includes('Pixel'), 'the list');
    const [iphone, pixel] = [...host.querySelectorAll('li[data-device]')].map(
      (li) => li.textContent,
    );
    expect(iphone).toContain("Ada's iPhone");
    expect(iphone).toContain('iPhone');
    expect(iphone).toContain(
      `Paired on ${new Date('2026-10-20T10:00:00.000Z').toLocaleDateString()}`,
    );
    expect(iphone).toContain('Last seen: 5 minutes ago');
    expect(iphone).toContain('Push registered.');
    expect(pixel).toContain('Android');
    expect(pixel).toContain('Last seen: Never');
    expect(pixel).toContain('Push not registered.');
    expect(page()).not.toContain('No devices paired yet.');
  });

  it('says when no device is paired', async () => {
    render();
    await until(() => page().includes('No devices paired yet.'), 'the empty state');
  });

  it('refreshes the list on device.paired, device.updated and device.revoked', async () => {
    render();
    await until(() => page().includes('No devices paired yet.'), 'the empty state');
    server.devices = [device()];
    live.emit('device.paired', { device: device() });
    await until(() => page().includes("Ada's iPhone"), 'the paired device');
    server.devices = [device({ pushRegistered: true })];
    live.emit('device.updated', { device: { ...device(), pushRegistered: true } });
    await until(() => page().includes('Push registered.'), 'the push token');
    server.devices = [];
    live.emit('device.revoked', { device: device() });
    await until(() => page().includes('No devices paired yet.'), 'the revoked device gone');
  });

  it('pairs a phone: one code with its QR, a countdown and Copy link', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render();
    act(() => button('Pair a phone')!.click());
    await until(() => !!dialog()?.querySelector('img'), 'the QR code');
    const img = dialog()!.querySelector('img')!;
    expect(img.getAttribute('alt')).toMatch(/QR code/);
    const svg = decodeURIComponent(img.getAttribute('src')!.split(',')[1]!);
    expect(svg).toContain('<svg');
    expect(page()).toMatch(/Expires in 4:5\d|Expires in 5:00/);
    expect(page()).toContain('The code works once and expires in 5 minutes.');
    expect(server.requests.filter((r) => r.path === '/api/v1/devices/pairings')).toHaveLength(1);

    act(() => button('Copy link')!.click());
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(button('Copied')).toBeUndefined();

    // A device of an older pairing (another tab's) is no news here.
    live.emit('device.paired', { device: device({ name: 'Old phone' }) });
    expect(dialog()!.textContent).not.toContain('Paired');
    // The phone pairs while the dialog is open.
    live.emit('device.paired', { device: device({ createdAt: new Date().toISOString() }) });
    expect(dialog()!.textContent).toContain("Paired Ada's iPhone");
    act(() => button('Done')!.click());
    await until(() => !dialog(), 'the dialog closed');
    // A used pairing is not cancelled.
    expect(server.requests.some((r) => r.path.startsWith('/api/v1/devices/pairings/'))).toBe(false);
  });

  it('cancels its pairing when the dialog closes unused', async () => {
    render();
    act(() => button('Pair a phone')!.click());
    await until(() => page().includes('Expires in'), 'the code');
    act(() => button('Close')!.click());
    await until(() => !dialog(), 'the dialog closed');
    await until(() => server.requests.some((r) => r.method === 'DELETE'), 'the pairing cancelled');
    expect(server.requests.find((r) => r.method === 'DELETE')).toEqual({
      method: 'DELETE',
      path: '/api/v1/devices/pairings/00000000-0000-4000-8000-0000000000e1',
    });
  });

  it("counts down by the server's clock, from its Date header", async () => {
    // The server's clock is ten minutes ahead of this browser's.
    const serverNow = Date.now() + 10 * 60_000;
    server.pairingDate = new Date(serverNow).toUTCString();
    server.pairing = {
      ...server.pairing!,
      expiresAt: new Date(serverNow + 5 * 60_000).toISOString(),
    };
    render();
    act(() => button('Pair a phone')!.click());
    await until(() => page().includes('Expires in'), 'the countdown');
    // The header has whole seconds, so a second either way; never 14 minutes.
    expect(page()).toMatch(/Expires in (4:5\d|5:0[01])/);
  });

  it('offers a new code once the code expires', async () => {
    server.pairing = { ...server.pairing!, expiresAt: new Date(Date.now() + 1500).toISOString() };
    render();
    act(() => button('Pair a phone')!.click());
    await until(() => page().includes('Expires in'), 'the countdown');
    await until(() => page().includes('This code expired.'), 'the expiry');
    expect(dialog()!.querySelector('img')).toBeNull();
    server.pairing = {
      ...server.pairing,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    act(() => button('New code')!.click());
    await until(() => page().includes('Expires in'), 'the new code');
    expect(server.requests.filter((r) => r.path === '/api/v1/devices/pairings')).toHaveLength(2);
  });

  it('says so plainly when too many codes are open', async () => {
    server.pairingProblem = 'TOO_MANY_PAIRINGS';
    render();
    act(() => button('Pair a phone')!.click());
    await until(() => page().includes('Too many pairing codes are open.'), 'the 409 message');
  });

  it('revokes a device only after the confirm', async () => {
    server.devices = [device()];
    render();
    await until(() => page().includes("Ada's iPhone"), 'the list');
    act(() => button('Revoke')!.click());
    await until(() => !!dialog(), 'the confirm');
    expect(dialog()!.textContent).toContain('Revoke this device?');
    expect(dialog()!.textContent).toContain(
      'Its key stops working at once and it gets no more notifications.',
    );
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Revoke',
    )!;
    act(() => confirm.click());
    await until(() => page().includes('No devices paired yet.'), 'the device gone');
    expect(server.requests.find((r) => r.method === 'DELETE')).toEqual({
      method: 'DELETE',
      path: `/api/v1/devices/${PHONE}`,
    });
  });

  it('shows the relay status with the host id', async () => {
    render();
    await until(() => page().includes('Relay: off'), 'off');
    expect(page()).toContain('OPENBOTS_RELAY_URL');
    expect(host.querySelector('.font-mono')?.textContent).toBe('h1');
  });

  it.each([
    ['connecting', null, 'Relay: connecting…'],
    [
      'linked',
      '2026-11-01T09:00:00.000Z',
      `Relay: linked since ${new Date('2026-11-01T09:00:00.000Z').toLocaleString()}`,
    ],
  ])('shows the relay %s', async (status, since, text) => {
    server.relay = { hostId: 'h1', relayUrl: 'wss://relay.example.com', status, since };
    render();
    await until(() => page().includes(text), status);
    expect(page()).not.toContain('OPENBOTS_RELAY_URL');
  });

  it('says the relay connects once a phone is paired when it is set but off', async () => {
    server.relay = {
      hostId: 'h1',
      relayUrl: 'wss://relay.example.com',
      status: 'off',
      since: null,
    };
    render();
    await until(() => page().includes('Relay: off'), 'off');
    expect(page()).toContain('The relay connects once a phone is paired.');
    expect(page()).not.toContain('OPENBOTS_RELAY_URL');
  });
});

describe('the relay status', () => {
  it('follows relay.status from the socket without asking the server again', async () => {
    render();
    await until(() => page().includes('Relay: off'), 'off');
    const reads = relayReads();
    live.emit('relay.status', {
      hostId: 'h1',
      relayUrl: 'wss://relay.example.com',
      status: 'connecting',
      since: '2026-11-01T09:00:00.000Z',
    });
    await until(() => page().includes('Relay: connecting…'), 'connecting');
    live.emit('relay.status', {
      hostId: 'h1',
      relayUrl: 'wss://relay.example.com',
      status: 'linked',
      since: '2026-11-01T09:00:01.000Z',
    });
    await until(
      () =>
        page().includes(
          `Relay: linked since ${new Date('2026-11-01T09:00:01.000Z').toLocaleString()}`,
        ),
      'linked',
    );
    expect(relayReads()).toBe(reads);
  });

  it('reads the status again each time the socket reconnects', async () => {
    render('connecting');
    await until(() => page().includes('Relay: off'), 'off');
    expect(relayReads()).toBe(1);
    // Linked while the socket was down: no event reached the page.
    server.relay = {
      hostId: 'h1',
      relayUrl: 'wss://relay.example.com',
      status: 'linked',
      since: null,
    };
    setSocketStatus('open');
    await until(() => page().includes('Relay: linked'), 'linked after the reconnect');
    expect(relayReads()).toBe(2);
    setSocketStatus('closed');
    server.relay = {
      hostId: 'h1',
      relayUrl: 'wss://relay.example.com',
      status: 'off',
      since: null,
    };
    setSocketStatus('open');
    await until(() => page().includes('Relay: off'), 'off after the second reconnect');
    expect(relayReads()).toBe(3);
  });

  it('keeps a slow poll as a fallback', () => {
    expect(RELAY_POLL_MS).toBe(60_000);
    expect(relayQuery.refetchInterval).toBe(60_000);
  });
});

describe('device formatting', () => {
  it('counts down in minutes and seconds', () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(countdown('2026-11-02T10:05:00.000Z', now)).toBe('5:00');
    expect(countdown('2026-11-02T10:04:59.000Z', now)).toBe('4:59');
    expect(countdown('2026-11-02T10:00:09.000Z', now)).toBe('0:09');
    expect(countdown('2026-11-02T09:59:00.000Z', now)).toBe('0:00');
  });

  it("reads the server's clock from a Date header, and knows a device of this pairing", () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(clockSkew('Mon, 02 Nov 2026 10:02:00 GMT', now)).toBe(120_000);
    expect(clockSkew(null, now)).toBe(0);
    expect(clockSkew('not a date', now)).toBe(0);
    const pairing = { expiresAt: '2026-11-02T10:05:00.000Z' };
    expect(pairedByThis('2026-11-02T10:00:30.000Z', pairing)).toBe(true);
    expect(pairedByThis('2026-11-02T09:59:00.000Z', pairing)).toBe(false);
  });

  it('says how long ago a device was seen', () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(relativeTime('2026-11-02T09:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-02T07:00:00.000Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-11-01T10:00:00.000Z', now)).toBe('yesterday');
  });
});
