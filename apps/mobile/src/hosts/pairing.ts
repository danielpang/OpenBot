import { base64urlDecode, base64urlEncode, generateDeviceKey, isHostId } from '@openbots/tunnel';
import { connectHost, normalizeServerUrl, type TransportOptions } from '../transport';
import type { HostSecrets, SavedHost } from './types';

export interface PairingLink {
  v: 1;
  host: string;
  key: string;
  code: string;
  relay: string | null;
  direct: string[];
  name: string;
  setup: boolean;
}

function key32(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    base64urlDecode(value).length !== 32
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

/** Strict parsing preserves literal '+' and rejects ambiguous duplicate fields. */
export function parsePairingLink(input: string): PairingLink {
  const values: Record<string, string[]> = {};
  const url = new URL(input);
  const custom = url.protocol === 'openbots:' && url.hostname === 'pair' && url.pathname === '';
  const universal =
    url.protocol === 'https:' &&
    url.hostname === 'openbots.dev' &&
    url.pathname === '/pair' &&
    !url.port;
  if ((!custom && !universal) || url.username || url.password || url.search || !url.hash)
    throw new Error('Scan an OpenBots pairing QR code');
  for (const piece of url.hash.slice(1).split('&')) {
    const index = piece.indexOf('=');
    if (index < 1) throw new Error('Invalid pairing link');
    const key = decodeURIComponent(piece.slice(0, index));
    const value = decodeURIComponent(piece.slice(index + 1));
    (values[key] ??= []).push(value);
  }
  for (const [key, entries] of Object.entries(values)) {
    if (key !== 'direct' && entries.length !== 1)
      throw new Error(`Duplicate pairing field: ${key}`);
  }
  const read = (key: string) => values[key]?.[0];
  if (read('v') !== '1') throw new Error('This pairing link requires a newer app');
  const host = read('host');
  if (!host || !isHostId(host)) throw new Error('Invalid host ID');
  const direct = values.direct ?? [];
  if (direct.length > 8) throw new Error('Too many server addresses');
  // Parse local HTTP here; connection still needs the explicit allowInsecureLocal flag.
  for (const address of direct) normalizeServerUrl(address, true);
  const relay = read('relay') ?? null;
  if (relay) {
    const url = new URL(relay);
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid secure relay address');
  }
  if (!direct.length && !relay) throw new Error('The pairing link has no connection address');
  if (read('setup') !== undefined && read('setup') !== '1') throw new Error('Invalid setup flag');
  return {
    v: 1,
    host,
    key: key32(read('key'), 'server key'),
    code: key32(read('code'), 'pairing code'),
    direct,
    relay,
    name: read('name')?.trim() || 'OpenBots',
    setup: read('setup') === '1',
  };
}

export interface PairHostOptions extends TransportOptions {
  deviceName: string;
  ownerName?: string;
  randomBytes?: (length: number) => Uint8Array;
}

export async function pairHost(
  link: PairingLink,
  options: PairHostOptions,
): Promise<{ host: SavedHost; secrets: HostSecrets; setupNeeded: boolean }> {
  if (!options.deviceName.trim() || options.deviceName.trim().length > 100)
    throw new Error('Enter a device name (up to 100 characters)');
  const device = generateDeviceKey();
  const pushKey = options.randomBytes?.(32) ?? crypto.getRandomValues(new Uint8Array(32));
  if (pushKey.length !== 32) throw new Error('Invalid push key');
  const secrets: HostSecrets = {
    apiKey: '',
    devicePrivateKey: base64urlEncode(device.privateKey),
    pushKey: base64urlEncode(pushKey),
  };
  const host: SavedHost = {
    id: link.host,
    name: link.name,
    kind: 'paired',
    directUrls: link.direct,
    relayUrl: link.relay,
    serverPublicKey: link.key,
  };
  const transport = await connectHost(host, secrets, { ...options, pairing: true });
  try {
    const response = await transport.fetch('/api/v1/devices/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: link.code,
        name: options.deviceName.trim(),
        platform: 'ios',
        publicKey: base64urlEncode(device.publicKey),
        pushKey: secrets.pushKey,
        ...(options.ownerName?.trim() ? { ownerName: options.ownerName.trim() } : {}),
      }),
    });
    const result = (await response.json()) as {
      key?: string;
      device?: { id: string };
      owner?: { id: string };
      setupNeeded?: boolean;
      detail?: string;
    };
    if (!response.ok)
      throw new Error(
        result.detail ??
          `Pairing failed (${response.status}). Create a fresh QR code and try again.`,
      );
    if (!result.key?.startsWith('obk_') || !result.device?.id || !result.owner?.id)
      throw new Error('The server returned an invalid pairing response');
    return {
      host: {
        ...host,
        deviceId: result.device.id,
        ownerId: result.owner.id,
        lastSeenAt: new Date().toISOString(),
      },
      secrets: { ...secrets, apiKey: result.key },
      setupNeeded: result.setupNeeded === true,
    };
  } finally {
    transport.close();
  }
}
