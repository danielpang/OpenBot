import {
  base64urlDecode,
  base64urlEncode,
  connectThroughRelay,
  createTunnelClient,
  generateDeviceKey,
  RelayConnectError,
  TunnelHandshakeError,
  type BinaryWebSocketFactory,
  type TunnelClient,
} from '@openbots/tunnel';
import type { PairedServer } from '../ipc.js';
import { pairingRelay, type PairingLink } from './pair-link.js';

// This Mac as a thin client of another OpenBots server, often another Mac's
// This Mac, through that server's relay (docs/RELAY_PROTOCOL.md 6). Pairing
// runs the exchange a phone runs: a device static key made here, the Noise
// handshake pinned to the server key in the link, then `POST
// /api/v1/devices/pair` over the tunnel, which answers the device's API key.
// After that a TunnelLink keeps one tunnel open to the server, as the known
// device, and opens a new one whenever it closes (the server restarted, the
// Mac slept, the relay drained). Plain, so it is tested without Electron;
// ./tunnel-proxy.ts carries the web app over it.

/** What only this Mac may hold for a paired server; sealed in the Keychain (./device-keys.ts). */
export interface DeviceSecrets {
  /** The device's API key on the server, `obk_...`. */
  apiKey: string;
  /** The device's X25519 static key, base64url. */
  staticKey: string;
}

/** Opens a tunnel to the paired server as the device whose static key this is. */
export type OpenTunnel = (
  server: Pick<PairedServer, 'hostId' | 'relayUrl' | 'serverKey'>,
  staticKey: Uint8Array,
) => Promise<TunnelClient>;

/** The tunnel through the relay, with `ws` sockets in the app. */
export function relayTunnel(
  createSocket: BinaryWebSocketFactory,
  options: { timeoutMs?: number } = {},
): OpenTunnel {
  return async (server, staticKey) => {
    const transport = await connectThroughRelay({
      relayUrl: server.relayUrl,
      hostId: server.hostId,
      createSocket,
      timeoutMs: options.timeoutMs,
    });
    try {
      return await createTunnelClient({
        transport,
        serverKey: base64urlDecode(server.serverKey),
        staticKey,
      });
    } catch (error) {
      transport.close();
      throw error;
    }
  };
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

/** The server no longer knows this Mac: it was signed out from there, or the server was reset. */
export class NotPairedError extends Error {
  constructor(name: string) {
    super(
      `This Mac is no longer paired with ${name}. Remove it from your saved connections, then pair again with a new link.`,
    );
    this.name = 'NotPairedError';
  }
}

/** A sentence for why the tunnel to a paired server did not open. */
export function tunnelErrorMessage(error: unknown, name: string): string {
  if (error instanceof NotPairedError) return error.message;
  if (error instanceof RelayConnectError) {
    if (error.unreachable) {
      return `Could not reach the relay. Check this Mac's internet connection. (${error.message})`;
    }
    if (error.hostOffline) {
      return `${name} is not connected to its relay. Check that it is on and awake, and that OpenBots is running there.`;
    }
    if (error.code === 4429) return `${name} has too many connections right now. Try again soon.`;
    return `The relay closed the connection to ${name} (${error.code}).`;
  }
  if (error instanceof TunnelHandshakeError) {
    return `${name} did not answer with the key this Mac paired with. If it was reinstalled, pair again with a new link.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface PairOptions {
  open: OpenTunnel;
  /** This Mac's name on the server's Devices list. */
  deviceName: string;
  /** The owner's name, for a server with no owner yet (the link said `setup=1`). */
  ownerName?: string | null;
  randomBytes?: (length: number) => Uint8Array;
}

export interface PairResult {
  paired: PairedServer;
  secrets: DeviceSecrets;
  /** The owner has no model provider or Bot yet. */
  setupNeeded: boolean;
}

interface PairAnswer {
  key?: unknown;
  device?: { id?: unknown };
  setupNeeded?: unknown;
  detail?: unknown;
  title?: unknown;
  code?: unknown;
}

const PAIR_MESSAGES: Record<string, string> = {
  PAIRING_INVALID:
    'The link was already used or has expired. Make a new one on the other Mac or server, then paste it here.',
  DEVICE_ALREADY_PAIRED: 'This Mac is already paired with that server.',
};

/** Pairs this Mac with the server of `link` over its relay; the tunnel closes once it answers. */
export async function pairWithServer(link: PairingLink, options: PairOptions): Promise<PairResult> {
  const relayUrl = pairingRelay(link);
  const deviceName = options.deviceName.trim().slice(0, 100) || 'Mac';
  const random = options.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const device = generateDeviceKey();
  const server = { hostId: link.host, relayUrl, serverKey: link.key };

  let tunnel: TunnelClient;
  try {
    tunnel = await options.open(server, device.privateKey);
  } catch (error) {
    throw new PairingError(tunnelErrorMessage(error, link.name));
  }
  try {
    let response: Response;
    try {
      response = await tunnel.fetch('/api/v1/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: link.code,
          name: deviceName,
          platform: 'desktop',
          publicKey: base64urlEncode(device.publicKey),
          // No notifications reach this Mac by push; the server wants a key all the same.
          pushKey: base64urlEncode(random(32)),
          ...(link.setup && options.ownerName?.trim()
            ? { ownerName: options.ownerName.trim().slice(0, 100) }
            : {}),
        }),
      });
    } catch (error) {
      throw new PairingError(
        `${link.name} closed the connection while pairing. Try again with a new link. (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const answer = (await response.json().catch(() => ({}))) as PairAnswer;
    if (!response.ok) {
      const code = typeof answer.code === 'string' ? answer.code : '';
      const detail = typeof answer.detail === 'string' ? answer.detail : null;
      throw new PairingError(
        PAIR_MESSAGES[code] ??
          (response.status === 429
            ? 'Too many tries. Wait a while, then make a new link.'
            : (detail ?? `Pairing failed (${response.status}). Make a new link and try again.`)),
      );
    }
    const deviceId = answer.device?.id;
    if (typeof answer.key !== 'string' || !answer.key.startsWith('obk_')) {
      throw new PairingError('The server answered the pairing in a way this app does not know.');
    }
    if (typeof deviceId !== 'string' || deviceId === '') {
      throw new PairingError('The server answered the pairing in a way this app does not know.');
    }
    return {
      paired: { ...server, deviceId },
      secrets: { apiKey: answer.key, staticKey: base64urlEncode(device.privateKey) },
      setupNeeded: answer.setupNeeded === true,
    };
  } finally {
    // The server closes a pairing stream itself once it answers (5.1).
    tunnel.close();
  }
}

export interface TunnelLink {
  /** The open tunnel, as the known device; opens a new one when there is none. */
  get(): Promise<TunnelClient>;
  /** Whether a tunnel is open right now. */
  readonly open: boolean;
  close(): void;
}

export interface TunnelLinkOptions {
  server: PairedServer;
  /** The server's name, for the errors. */
  name: string;
  staticKey: Uint8Array;
  open: OpenTunnel;
  /** After a failed attempt, later ones fail at once with its error for this long. */
  retryAfterMs?: number;
  now?: () => number;
}

/** One tunnel to a paired server at a time, opened on demand and again after it closes. */
export function createTunnelLink(options: TunnelLinkOptions): TunnelLink {
  const now = options.now ?? Date.now;
  const retryAfterMs = options.retryAfterMs ?? 2000;
  let current: TunnelClient | null = null;
  let opening: Promise<TunnelClient> | null = null;
  let failed: { error: unknown; at: number } | null = null;
  let closed = false;

  async function connect(): Promise<TunnelClient> {
    const tunnel = await options.open(options.server, options.staticKey);
    if (tunnel.device !== 'known') {
      // A revoked device's key is forgotten: the server takes it for a stranger.
      tunnel.close();
      throw new NotPairedError(options.name);
    }
    if (closed) {
      tunnel.close();
      throw new Error('The connection was closed.');
    }
    tunnel.onClose(() => {
      if (current === tunnel) current = null;
    });
    current = tunnel;
    return tunnel;
  }

  return {
    get open() {
      return current != null && !current.closed;
    },

    get() {
      if (closed) return Promise.reject(new Error('The connection was closed.'));
      if (current && !current.closed) return Promise.resolve(current);
      if (opening) return opening;
      if (failed && now() - failed.at < retryAfterMs) return Promise.reject(failed.error);
      opening = connect().then(
        (tunnel) => {
          failed = null;
          return tunnel;
        },
        (error: unknown) => {
          failed = { error, at: now() };
          throw error;
        },
      );
      void opening.then(
        () => (opening = null),
        () => (opening = null),
      );
      return opening;
    },

    close() {
      closed = true;
      current?.close(1000, 'closed');
      current = null;
    },
  };
}
