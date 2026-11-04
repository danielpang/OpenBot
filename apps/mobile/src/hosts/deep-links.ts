import { parsePairingLink } from './pairing';
/** Rewrites OS universal/custom-scheme links into local Router destinations.
 * Never log a pairing URL: its fragment is a one-use owner credential. */
export function nativeIntent(path: string): string {
  try {
    if (path.startsWith('openbots://pair#') || path.startsWith('https://openbots.dev/pair#')) {
      parsePairingLink(path);
      return `/(onboarding)/pair?link=${encodeURIComponent(path)}`;
    }
    const url = new URL(path, 'openbots://app');
    if (url.protocol === 'openbots:' && url.host === 'dev' && url.pathname === '/transcript-spike')
      return '/dev/transcript-spike';
    const route =
      url.protocol === 'openbots:' && url.host !== 'app'
        ? `/${url.host}${url.pathname}`
        : url.pathname;
    if (/^\/(?:bot|chat)\/[0-9a-f-]{36}(?:\/details|\/preview)?$/i.test(route))
      return route + url.search;
  } catch {
    /* Untrusted links go to welcome without including their contents. */
  }
  return '/';
}
