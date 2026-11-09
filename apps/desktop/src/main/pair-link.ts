import { base64urlDecode, isHostId } from '@openbots/tunnel';
import { parseServerAddress } from '../server-url.js';
import { parseRelayUrl } from './pairing.js';

// The pairing link another OpenBots server shows (docs/RELAY_PROTOCOL.md
// 6.1): its "Pair your phone…" window, Settings > Devices in the web app, or
// `openbots pair` in the server image. This Mac reads it to pair with that
// server as a device, the way the phone does, and from then on reaches it
// through the relay the link names. Plain, so it is tested without Electron.

export interface PairingLink {
  /** The server's host id at the relay. */
  host: string;
  /** The server's tunnel key (X25519 public key), base64url. */
  key: string;
  /** The one-time pairing code, base64url. */
  code: string;
  /** The relay's wss:// URL, or null when the server has none. */
  relay: string | null;
  /** The server's own https addresses, if it listed any. */
  direct: string[];
  /** The server's own name, for the saved connections. */
  name: string;
  /** The server has no owner yet: pairing makes this Mac's owner the server's. */
  setup: boolean;
}

export class PairingLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingLinkError';
  }
}

const NOT_A_LINK =
  'Paste the pairing link from the other Mac or server: it starts with openbots://pair#.';

function key32(value: string | undefined, what: string): string {
  let bytes: Uint8Array | null = null;
  if (value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value)) {
    try {
      bytes = base64urlDecode(value);
    } catch {
      bytes = null;
    }
  }
  if (bytes?.length !== 32) throw new PairingLinkError(`The pairing link's ${what} is not valid.`);
  return value!;
}

/**
 * Reads an `openbots://pair#...` link (or the same fragment on
 * `https://openbots.dev/pair`). Throws PairingLinkError with a sentence to
 * show when it is not one this app can pair with.
 */
export function parsePairingLink(input: string): PairingLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new PairingLinkError(NOT_A_LINK);
  }
  const custom = url.protocol === 'openbots:' && url.hostname === 'pair' && url.pathname === '';
  const universal =
    url.protocol === 'https:' &&
    url.hostname === 'openbots.dev' &&
    url.pathname === '/pair' &&
    url.port === '';
  if (!(custom || universal) || url.username || url.password || url.search || url.hash === '') {
    throw new PairingLinkError(NOT_A_LINK);
  }

  const values = new Map<string, string[]>();
  for (const piece of url.hash.slice(1).split('&')) {
    const at = piece.indexOf('=');
    if (at < 1) throw new PairingLinkError('The pairing link is not complete. Copy it again.');
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(piece.slice(0, at));
      value = decodeURIComponent(piece.slice(at + 1));
    } catch {
      throw new PairingLinkError('The pairing link is not complete. Copy it again.');
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  for (const [key, list] of values) {
    if (key !== 'direct' && list.length > 1) {
      throw new PairingLinkError('The pairing link is not valid. Copy it again.');
    }
  }
  const read = (key: string) => values.get(key)?.[0];

  if (read('v') !== '1') {
    throw new PairingLinkError('This pairing link needs a newer version of OpenBots.');
  }
  const host = read('host');
  if (host === undefined || !isHostId(host)) {
    throw new PairingLinkError("The pairing link's server id is not valid.");
  }
  const direct = (values.get('direct') ?? []).slice(0, 8).flatMap((address) => {
    try {
      return [parseServerAddress(address).url];
    } catch {
      return [];
    }
  });
  const relayText = read('relay');
  const relay = relayText === undefined ? null : parseRelayUrl(relayText);
  if (relayText !== undefined && relay === null) {
    throw new PairingLinkError("The pairing link's relay address is not valid.");
  }
  const setup = read('setup');
  if (setup !== undefined && setup !== '1') {
    throw new PairingLinkError('The pairing link is not valid. Copy it again.');
  }
  return {
    host,
    key: key32(read('key'), 'server key'),
    code: key32(read('code'), 'code'),
    relay,
    direct,
    name: read('name')?.trim().slice(0, 100) || 'OpenBots',
    setup: setup === '1',
  };
}

/** The relay to pair through; a link without one gets the sentence that says what to do instead. */
export function pairingRelay(link: PairingLink): string {
  if (link.relay) return link.relay;
  const [address] = link.direct;
  throw new PairingLinkError(
    address
      ? `This server has no relay. Connect to it as a self-hosted server at ${address} instead.`
      : 'This server has no relay, so this Mac cannot reach it. Set a relay on the server, then make a new link.',
  );
}
