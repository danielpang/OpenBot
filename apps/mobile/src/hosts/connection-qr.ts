import { parsePairingLink } from './pairing';
import { normalizeServerUrl } from '../transport';

/** QR codes select a destination; they never authenticate or connect without confirmation. */
export function parseConnectionQr(
  input: string,
): { kind: 'pairing'; link: string } | { kind: 'server'; address: string } {
  const value = input.trim();
  const url = new URL(value);
  if (
    url.protocol === 'openbots:' ||
    (url.hostname === 'openbots.dev' && url.pathname === '/pair')
  ) {
    // Never treat a malformed/expired-format pairing link as a server address.
    parsePairingLink(value);
    return { kind: 'pairing', link: value };
  }
  return { kind: 'server', address: normalizeServerUrl(value) };
}
