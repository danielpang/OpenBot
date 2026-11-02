// The address the owner types to connect to a self-hosted server (plan 14.4).
// Plain, with no Node or Electron imports, so the start page shows the same
// warning the main process applies. https by default; http only for this Mac
// or an address on a private network, where a self-hosted server often has no
// certificate, and then with a warning.

export class ServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

export interface ServerAddress {
  /** The server's origin, e.g. `https://openbots.example.com`. */
  url: string;
  /** Shown before connecting over plain http; null over https. */
  warning: string | null;
}

export const HTTP_WARNING =
  'This connection is not encrypted. Use http only on a network you trust.';

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'];

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/**
 * This Mac or a private network: loopback, RFC 1918, link-local, the shared
 * range Tailscale uses, IPv6 loopback, unique local and link-local, and local
 * host names (`localhost`, `nas.local`, `box.lan`).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/**
 * Normalizes what the owner typed to the server's origin. Without a scheme it
 * is https, or http for a private address (a server on the LAN rarely has a
 * certificate). Throws ServerUrlError with a sentence to show otherwise.
 */
export function parseServerAddress(input: string): ServerAddress {
  const text = input.trim();
  if (text === '') throw new ServerUrlError('Enter the address of your OpenBots server.');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    throw new ServerUrlError('Enter a server address, like openbots.example.com.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerUrlError('A server address starts with https:// or http://.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ServerUrlError('Leave the user name and password out of the address.');
  }
  if (url.hostname === '') throw new ServerUrlError('Enter a server address.');
  const local = isPrivateHost(url.hostname);
  if (!hasScheme && local) url.protocol = 'http:';
  if (url.protocol === 'http:' && !local) {
    throw new ServerUrlError(
      'Use https for a server on the internet. http works only for this Mac or a private network.',
    );
  }
  return { url: url.origin, warning: url.protocol === 'http:' ? HTTP_WARNING : null };
}
