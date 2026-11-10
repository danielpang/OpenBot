import {
  base64urlDecode,
  base64urlEncode,
  RelayConnectError,
  x25519PublicKey,
} from '@openbots/tunnel';
import { describe, expect, it } from 'vitest';
import { fakeServer } from './fake-tunnel.js';
import { parsePairingLink, PairingLinkError, pairingRelay } from './pair-link.js';
import {
  createTunnelLink,
  NotPairedError,
  pairWithServer,
  PairingError,
  tunnelErrorMessage,
} from './paired.js';

const HOST = 'abcdefghijklmnopqrstuvwxyz';
const KEY = base64urlEncode(new Uint8Array(32).fill(7));
const CODE = base64urlEncode(new Uint8Array(32).fill(9));
const RELAY = 'wss://openbots-relay.fly.dev';

function link(extra = '', key = KEY) {
  return `openbots://pair#v=1&host=${HOST}&key=${key}&code=${CODE}&relay=${encodeURIComponent(RELAY)}&name=${encodeURIComponent("Ada's MacBook")}${extra}`;
}

describe('parsePairingLink', () => {
  it('reads the link a server shows', () => {
    expect(parsePairingLink(`  ${link()}\n`)).toEqual({
      host: HOST,
      key: KEY,
      code: CODE,
      relay: RELAY,
      direct: [],
      name: "Ada's MacBook",
      setup: false,
    });
    const parsed = parsePairingLink(
      link(`&setup=1&direct=${encodeURIComponent('https://box.example.com')}&direct=bad%20url`),
    );
    expect(parsed).toMatchObject({ setup: true, direct: ['https://box.example.com'] });
  });

  it('reads the universal form', () => {
    const universal = link().replace('openbots://pair#', 'https://openbots.dev/pair#');
    expect(parsePairingLink(universal).host).toBe(HOST);
  });

  it.each([
    ['not a link', 'hello'],
    ['another scheme', link().replace('openbots://', 'https://')],
    ['no fragment', 'openbots://pair'],
    ['a query', link().replace('pair#', 'pair?x=1#')],
    ['a newer version', link().replace('v=1', 'v=2')],
    ['a bad host id', link().replace(HOST, 'nope')],
    ['a short key', link('', 'abc')],
    ['an insecure relay', link().replace(encodeURIComponent(RELAY), 'ws%3A%2F%2Frelay.example')],
    ['a repeated field', `${link()}&code=${CODE}`],
    ['a bad setup flag', link('&setup=yes')],
    ['a broken piece', `${link()}&oops`],
  ])('refuses %s', (_what, input) => {
    expect(() => parsePairingLink(input)).toThrow(PairingLinkError);
  });

  it('needs a relay to pair', () => {
    const without = link().replace(`&relay=${encodeURIComponent(RELAY)}`, '');
    expect(() => pairingRelay(parsePairingLink(without))).toThrow(/no relay/);
    const direct = parsePairingLink(
      `${without}&direct=${encodeURIComponent('https://box.example.com')}`,
    );
    expect(() => pairingRelay(direct)).toThrow(/self-hosted server at https:\/\/box.example.com/);
  });
});

/** A server that pairs devices the way the real route does. */
function pairingServer(answer?: (body: Record<string, unknown>) => Response) {
  const seen: Record<string, unknown>[] = [];
  const server = fakeServer({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/devices/pair' && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        seen.push(body);
        if (answer) return answer(body);
        server.devices.set(String(body.publicKey), 'device-1');
        return Response.json({
          device: { id: 'device-1', name: body.name, platform: body.platform, createdAt: '' },
          key: 'obk_secret',
          owner: { id: 'owner-1', name: 'Ada' },
          setupNeeded: false,
        });
      }
      return Response.json({ path: url.pathname, auth: request.headers.get('authorization') });
    },
  });
  return { server, seen };
}

describe('pairWithServer', () => {
  it('pairs as a desktop device and keeps what the server answered', async () => {
    const { server, seen } = pairingServer();
    const parsed = parsePairingLink(link('&setup=1', server.serverKey));
    const result = await pairWithServer(parsed, {
      open: server.open,
      deviceName: '  Grace’s Mac  ',
      ownerName: 'Grace',
      randomBytes: (n) => new Uint8Array(n).fill(1),
    });
    expect(seen[0]).toMatchObject({
      code: CODE,
      name: 'Grace’s Mac',
      platform: 'desktop',
      pushKey: base64urlEncode(new Uint8Array(32).fill(1)),
      ownerName: 'Grace',
    });
    const publicKey = x25519PublicKey(base64urlDecode(result.secrets.staticKey));
    expect(seen[0]!.publicKey).toBe(base64urlEncode(publicKey));
    expect(result).toEqual({
      paired: { hostId: HOST, relayUrl: RELAY, serverKey: server.serverKey, deviceId: 'device-1' },
      secrets: { apiKey: 'obk_secret', staticKey: result.secrets.staticKey },
      setupNeeded: false,
    });
    expect(server.tunnels[0]!.closed).toBe(true);
  });

  it('sends the owner name only to a server with no owner', async () => {
    const { server, seen } = pairingServer();
    await pairWithServer(parsePairingLink(link('', server.serverKey)), {
      open: server.open,
      deviceName: 'Mac',
      ownerName: 'Grace',
    });
    expect(seen[0]).not.toHaveProperty('ownerName');
  });

  it('says why a used code fails', async () => {
    const { server } = pairingServer(() =>
      Response.json({ code: 'PAIRING_INVALID', status: 401 }, { status: 401 }),
    );
    const attempt = pairWithServer(parsePairingLink(link('', server.serverKey)), {
      open: server.open,
      deviceName: 'Mac',
    });
    await expect(attempt).rejects.toThrow(PairingError);
    await expect(attempt).rejects.toThrow(/already used or has expired/);
  });

  it('refuses an answer without a device key', async () => {
    const { server } = pairingServer(() => Response.json({ device: { id: 'x' }, key: 'nope' }));
    await expect(
      pairWithServer(parsePairingLink(link('', server.serverKey)), {
        open: server.open,
        deviceName: 'Mac',
      }),
    ).rejects.toThrow(/does not know/);
  });

  it('says when the other Mac is offline', async () => {
    await expect(
      pairWithServer(parsePairingLink(link()), {
        open: async () => {
          throw new RelayConnectError(4404, 'host offline');
        },
        deviceName: 'Mac',
      }),
    ).rejects.toThrow("Ada's MacBook is not connected to its relay");
  });
});

describe('createTunnelLink', () => {
  async function paired() {
    const { server } = pairingServer();
    const result = await pairWithServer(parsePairingLink(link('', server.serverKey)), {
      open: server.open,
      deviceName: 'Mac',
    });
    return { server, ...result };
  }

  it('opens one tunnel as the known device and opens again after it closes', async () => {
    const { server, paired: target, secrets } = await paired();
    const tunnels = createTunnelLink({
      server: target,
      name: 'Ada',
      staticKey: base64urlDecode(secrets.staticKey),
      open: server.open,
    });
    const [first, again] = await Promise.all([tunnels.get(), tunnels.get()]);
    expect(first).toBe(again);
    expect(first.device).toBe('known');
    expect(tunnels.open).toBe(true);
    const response = await first.fetch('/api/v1/me', {
      headers: { authorization: 'Bearer obk_secret' },
    });
    expect(await response.json()).toEqual({ path: '/api/v1/me', auth: 'Bearer obk_secret' });

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tunnels.open).toBe(false);
    const second = await tunnels.get();
    expect(second).not.toBe(first);
    tunnels.close();
    expect(second.closed).toBe(true);
    await expect(tunnels.get()).rejects.toThrow(/closed/);
  });

  it('says this Mac is no longer paired when the server forgot its key', async () => {
    const { server, paired: target, secrets } = await paired();
    server.devices.clear();
    let now = 0;
    const tunnels = createTunnelLink({
      server: target,
      name: 'Ada',
      staticKey: base64urlDecode(secrets.staticKey),
      open: server.open,
      now: () => now,
    });
    await expect(tunnels.get()).rejects.toThrow(NotPairedError);
    expect(server.tunnels.at(-1)!.closed).toBe(true);
    // A failure is remembered briefly, so a page's requests do not each dial the relay.
    const count = server.tunnels.length;
    await expect(tunnels.get()).rejects.toThrow(NotPairedError);
    expect(server.tunnels.length).toBe(count);
    now = 5000;
    await expect(tunnels.get()).rejects.toThrow(NotPairedError);
    expect(server.tunnels.length).toBe(count + 1);
  });
});

describe('tunnelErrorMessage', () => {
  it('names what went wrong', () => {
    expect(tunnelErrorMessage(new RelayConnectError(4404, ''), 'Box')).toMatch(/Box is not/);
    expect(tunnelErrorMessage(new RelayConnectError(4429, ''), 'Box')).toMatch(/too many/);
    expect(
      tunnelErrorMessage(new RelayConnectError(1006, '', 'down', { unreachable: true }), 'Box'),
    ).toMatch(/Could not reach the relay/);
    expect(tunnelErrorMessage(new NotPairedError('Box'), 'Box')).toMatch(/no longer paired/);
  });
});
