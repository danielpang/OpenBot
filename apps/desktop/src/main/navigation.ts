// Where the main window may go (plan 14.4). It shows one server's web app;
// sign-in with GitHub or Google passes through the provider's authorization
// and sign-in pages and comes back to the server's better-auth callback. Only
// those pages stay in the window: any other link, GitHub and Google ones
// included, opens in the default browser, and anything that is not http or
// https goes nowhere. The same verdict applies to server-side redirects, so
// an allowed page cannot bounce the window somewhere else. A connector's OAuth
// sign-in (GitHub, Google and the rest) always opens in the default browser.

/**
 * The paths each provider's sign-in flow visits, as path prefixes (a prefix
 * matches itself and anything below it): the authorization endpoint
 * better-auth sends the window to, and the pages it hands off to when the
 * owner has to sign in, pick an account, pass two-factor or consent.
 */
export const OAUTH_PATHS: Readonly<Record<string, readonly string[]>> = {
  'github.com': [
    // /login/oauth/authorize, the sign-in form and /login/device.
    '/login',
    // The sign-in form's POST, two-factor, passkeys and device verification.
    '/session',
    '/sessions',
  ],
  'accounts.google.com': [
    // /o/oauth2/v2/auth and /o/oauth2/auth.
    '/o/oauth2',
    // Sign-in, challenges and the OAuth consent screens.
    '/signin',
    '/v3/signin',
    '/ServiceLogin',
    '/AccountChooser',
    '/CheckCookie',
    '/InteractiveLogin',
    '/SetSID',
    '/speedbump',
  ],
};

/** The authorization endpoints, whose `redirect_uri` must come back to the server. */
const AUTHORIZE_PATHS = ['/login/oauth/authorize', '/o/oauth2/v2/auth', '/o/oauth2/auth'];

/**
 * Where a connector's OAuth sign-in comes back to. That sign-in belongs in the
 * default browser (./oauth.ts), never in the window, so it is never an
 * in-window page even on GitHub or Google.
 */
export const CONNECTOR_CALLBACK_PATH = '/api/v1/connectors/oauth/callback';

export type NavigationVerdict = 'allow' | 'external' | 'deny';

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** A provider sign-in page of the better-auth flow for this server. */
export function isOAuthPage(url: URL, serverOrigin: string): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const prefixes = OAUTH_PATHS[url.hostname];
  if (!prefixes?.some((prefix) => under(url.pathname, prefix))) return false;
  if (!AUTHORIZE_PATHS.includes(url.pathname)) return true;
  // An authorization request for another app would send the window to that app's site.
  const redirect = url.searchParams.get('redirect_uri');
  if (redirect == null) return true;
  try {
    const back = new URL(redirect);
    return back.origin === serverOrigin && back.pathname !== CONNECTOR_CALLBACK_PATH;
  } catch {
    return false;
  }
}

export function navigationVerdict(target: string, serverUrl: string): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'deny';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'deny';
  const serverOrigin = new URL(serverUrl).origin;
  if (url.origin === serverOrigin) return 'allow';
  return isOAuthPage(url, serverOrigin) ? 'allow' : 'external';
}

/** The web app path a window shows, when it shows the server's web app. */
export function serverPath(pageUrl: string, serverUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    return url.origin === new URL(serverUrl).origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}
