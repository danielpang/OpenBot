import {
  base64urlDecode,
  base64urlEncode,
  createTunnelClient,
  createTunnelServer,
  generateDeviceKey,
  memoryTransportPair,
  type DeviceLookup,
  type TunnelClient,
  type TunnelHandler,
} from '@openbots/tunnel';
import type { OpenTunnel } from './paired.js';

// Test helpers: an OpenBots server's end of the tunnel in memory, so pairing,
// the tunnel link and the proxy run the real handshake and frames without a
// relay. Not bundled; only tests import it.

export interface FakeServer {
  /** The server's tunnel key, base64url, as the pairing link carries it. */
  serverKey: string;
  /** Device public keys (base64url) the server knows, and their ids. */
  devices: Map<string, string>;
  open: OpenTunnel;
  /** Every tunnel opened, newest last. */
  tunnels: TunnelClient[];
}

export function fakeServer(handler: Partial<TunnelHandler>): FakeServer {
  const key = generateDeviceKey();
  const devices = new Map<string, string>();
  const tunnels: TunnelClient[] = [];
  const full: TunnelHandler = {
    fetch: handler.fetch ?? (async () => new Response('none', { status: 500 })),
    openSocket: handler.openSocket ?? (async () => new Response('none', { status: 500 })),
  };
  const server: FakeServer = {
    serverKey: base64urlEncode(key.publicKey),
    devices,
    tunnels,
    open: async (target, staticKey) => {
      const [a, b] = memoryTransportPair();
      void createTunnelServer({
        transport: b,
        staticKey: key.privateKey,
        lookupDevice: async (publicKey): Promise<DeviceLookup> => {
          const id = devices.get(base64urlEncode(publicKey));
          return id ? { known: true, id } : { known: false };
        },
        handler: full,
      }).catch(() => undefined);
      const tunnel = await createTunnelClient({
        transport: a,
        serverKey: base64urlDecode(target.serverKey),
        staticKey,
      });
      tunnels.push(tunnel);
      return tunnel;
    },
  };
  return server;
}
