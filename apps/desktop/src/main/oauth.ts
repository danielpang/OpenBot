// A connector's OAuth sign-in from the Mac app (plan 8, 14.4). The web app
// asks its server for the authorization URL and hands it to the bridge, which
// opens it in the owner's default browser: there the saved passwords and
// passkeys work, and providers allow the sign-in, which they refuse in an
// embedded window. When the web app hears the connector is connected, it asks
// for the window back; only a sign-in this app opened in the last 10 minutes
// may bring the window to the front, and only once.

/** As long as the server keeps a started sign-in (packages/mcp `OAUTH_PENDING_MS`). */
export const OAUTH_FOCUS_MS = 10 * 60_000;

/** The URL to open, or an error for anything but a plain http or https URL. */
export function authorizationUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The sign-in address is not a URL.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('The sign-in address must be an http or https URL.');
  }
  return url.toString();
}

export interface OAuthBrowser {
  /** Opens the provider's sign-in page in the default browser. */
  open(url: string): Promise<void>;
  /** Brings the app to the front after a sign-in it opened; false when there was none. */
  finished(): boolean;
}

export function createOAuthBrowser(options: {
  openExternal(url: string): Promise<void>;
  focus(): void;
  now?: () => number;
}): OAuthBrowser {
  const now = options.now ?? Date.now;
  let openedAt: number | null = null;
  return {
    async open(raw) {
      const url = authorizationUrl(raw);
      await options.openExternal(url);
      openedAt = now();
    },
    finished() {
      if (openedAt === null || now() - openedAt > OAUTH_FOCUS_MS) return false;
      openedAt = null;
      options.focus();
      return true;
    },
  };
}
