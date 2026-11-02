import { ApiError } from '@openbots/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopOAuth, platform } from '../../app/platform.js';
import { useRealtime } from '../transcript/realtime.js';
import { startOAuth, type Connector, type OAuthMode } from './api.js';
import { useConnectorsAdded, useTestConnector } from './hooks.js';

// One-click Connect (plan 8): the button creates the connector if needed and
// starts its OAuth sign-in at once. The authorization URL always comes from
// the server's start response. In a browser it opens in a popup sized for a
// login page, opened in the click itself so it is not blocked, falling back
// to a new tab and then to a link; in the Mac app it opens in the default
// browser, where saved passwords and passkeys work. The callback page tells
// the popup's opener (`postMessage`, our origin only, a status and nothing
// else) and the owner's sockets (`connector.updated`); either finishes the
// flow here: the list refreshes, the connector is tested for its tools, and
// the Mac app comes back to the front.

/** The `postMessage` type the callback page sends (apps/server `oauth-page.ts`). */
export const OAUTH_MESSAGE_TYPE = 'openbots:oauth';

/** How long a started sign-in is good for, as on the server. */
const FLOW_MS = 10 * 60_000;
const POPUP_NAME = 'openbots-oauth';
const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 720;

/** Where the provider's page opens, chosen in the click. */
export interface SignInWindow {
  mode: OAuthMode;
  /** Sends it to the provider; false when nothing could be opened (blocked). */
  go(url: string): Promise<boolean>;
  close(): void;
  /** The window the callback page posts from, once there is one. */
  source(): Window | null;
}

function popupFeatures(): string {
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 3));
  return `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`;
}

/**
 * Picks where the sign-in opens. Call it in the click handler: a browser only
 * lets a popup open in answer to a click, so it opens an empty one now and
 * points it at the provider once the server answers.
 */
export function openSignInWindow(options: { prefetch?: boolean } = {}): SignInWindow {
  const bridge = desktopOAuth();
  if (bridge) {
    return {
      mode: 'external',
      go: async (url) => {
        await bridge.open(url);
        return true;
      },
      close: () => {},
      source: () => null,
    };
  }
  if (platform().kind === 'desktop') {
    // An app version without the bridge sends every new window to the default browser.
    return {
      mode: 'external',
      go: async (url) => {
        window.open(url, '_blank');
        return true;
      },
      close: () => {},
      source: () => null,
    };
  }
  let popup = options.prefetch === false ? null : window.open('', POPUP_NAME, popupFeatures());
  return {
    mode: 'popup',
    go: async (url) => {
      if (popup && !popup.closed) {
        popup.location.replace(url);
        popup.focus?.();
        return true;
      }
      // Blocked: a new tab, which the callback page also closes; a link otherwise.
      popup = window.open(url, '_blank');
      return popup !== null;
    },
    close: () => popup?.close(),
    source: () => popup,
  };
}

interface Flow {
  connectorId: string;
  until: number;
  window: SignInWindow;
}

export type ConnectState =
  /** `connectedId`: the connector the last Connect added or signed in. */
  | { phase: 'idle'; error: Error | null; connectedId: string | null }
  | { phase: 'working' }
  | { phase: 'waiting'; connectorId: string; mode: OAuthMode }
  /** No window could open: the owner clicks the link. */
  | { phase: 'blocked'; connectorId: string; url: string };

const IDLE: ConnectState = { phase: 'idle', error: null, connectedId: null };

/** The server wants the owner's own OAuth client before it can sign in. */
export const needsClient = (error: unknown) =>
  error instanceof ApiError && error.code === 'OAUTH_CLIENT_REQUIRED';

export class SignInFailed extends Error {}

/**
 * Connect for one card. `connect(prepare)` runs in the click: `prepare`
 * returns the connector (creating it when needed); one without OAuth is just
 * added and tested, one with OAuth signs in.
 */
export function useOAuthConnect() {
  const queryClient = useQueryClient();
  const { client } = useRealtime();
  const onAdded = useConnectorsAdded();
  const test = useTestConnector();
  const [state, setState] = useState<ConnectState>(IDLE);
  const flow = useRef<Flow | null>(null);

  const finish = useCallback(
    (connectorId: string, status: 'connected' | 'error', reason?: string | null) => {
      const current = flow.current;
      if (!current || current.connectorId !== connectorId || Date.now() > current.until) return;
      flow.current = null;
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      if (status === 'connected') {
        setState({ phase: 'idle', error: null, connectedId: connectorId });
        // The first session after a login lists the tools.
        test.mutate(connectorId);
        if (current.window.mode === 'external') void desktopOAuth()?.finished();
      } else {
        setState({
          phase: 'idle',
          error: new SignInFailed(reason || 'The sign-in did not finish. Try again.'),
          connectedId: null,
        });
      }
    },
    [queryClient, test],
  );

  // The callback page in the popup, or the owner's sockets (any window, the Mac app's browser).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const current = flow.current;
      if (!current || event.origin !== window.location.origin) return;
      const source = current.window.source();
      if (!source || event.source !== source) return;
      const data = event.data as { type?: unknown; status?: unknown; connectorId?: unknown };
      if (data?.type !== OAUTH_MESSAGE_TYPE || typeof data.connectorId !== 'string') return;
      if (data.status === 'connected' || data.status === 'error') {
        finish(data.connectorId, data.status);
      }
    };
    window.addEventListener('message', onMessage);
    const off = client?.on('connector.updated', (event) => {
      const { connectorId, oauth, error } = event.payload;
      if (oauth) finish(connectorId, oauth, error);
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off?.();
    };
  }, [client, finish]);

  // A popup closed before it finished: stop waiting here (a late socket event still finishes).
  useEffect(() => {
    if (state.phase !== 'waiting' || state.mode !== 'popup') return;
    const timer = setInterval(() => {
      if (flow.current?.window.source()?.closed) {
        setState((s) => (s.phase === 'waiting' ? IDLE : s));
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [state]);

  const connect = useCallback(
    (prepare: () => Promise<Connector>, options: { prefetch?: boolean } = {}) => {
      const signIn = openSignInWindow(options);
      setState({ phase: 'working' });
      void (async () => {
        try {
          const connector = await prepare();
          if (!connector.oauth) {
            signIn.close();
            setState({ phase: 'idle', error: null, connectedId: connector.id });
            await onAdded([connector]);
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ['connectors'] });
          const { authorizationUrl } = await startOAuth(connector.id, signIn.mode);
          flow.current = { connectorId: connector.id, until: Date.now() + FLOW_MS, window: signIn };
          const opened = await signIn.go(authorizationUrl);
          setState(
            opened
              ? { phase: 'waiting', connectorId: connector.id, mode: signIn.mode }
              : { phase: 'blocked', connectorId: connector.id, url: authorizationUrl },
          );
        } catch (err) {
          signIn.close();
          flow.current = null;
          setState({ phase: 'idle', error: err as Error, connectedId: null });
        }
      })();
    },
    [onAdded, queryClient],
  );

  const reset = useCallback(() => setState(IDLE), []);
  return { state, connect, reset };
}

/** One line under the button while a sign-in is open. */
export function waitingText(state: ConnectState): string | null {
  if (state.phase === 'working') return 'Connecting…';
  if (state.phase === 'waiting') {
    return state.mode === 'external'
      ? 'Finish signing in in your browser.'
      : 'Finish signing in in the new window.';
  }
  return null;
}
