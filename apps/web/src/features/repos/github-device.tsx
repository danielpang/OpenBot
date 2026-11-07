import { Button, Input } from '@openbots/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopOAuth } from '../../app/platform.js';
import { ErrorText } from '../tools/fields.js';
import { openSignInWindow, type SignInWindow } from '../tools/oauth.js';
import {
  gitConnectionsQuery,
  pollGitDevice,
  startGitDevice,
  type GitConnectionView,
  type GitDeviceInput,
  type GitDeviceStart,
} from './api.js';

/** Coding repository authorization, not an MCP connector. Only the public
 * user code crosses this API; the device_code and rotating tokens do not.
 */
export function useGitDeviceConnection(onConnected: (connection: GitConnectionView) => void) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<GitDeviceStart | null>(null);
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState<'authorization' | 'installation'>('authorization');
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const provider = useRef<SignInWindow | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const cancel = useCallback(() => {
    generation.current++;
    starting.current = false;
    provider.current?.close();
    provider.current = null;
    setFlow(null);
    setWorking(false);
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      provider.current?.close();
    },
    [],
  );

  const begin = useCallback(
    (input: GitDeviceInput = {}) => {
      if (starting.current) return;
      starting.current = true;
      const version = ++generation.current;
      provider.current?.close();
      const popup = openSignInWindow();
      provider.current = popup;
      setFlow(null);
      setWorking(true);
      setError(null);
      setStage('authorization');
      void startGitDevice(input)
        .then(async (started) => {
          if (generation.current !== version) return;
          setFlow(started);
          setWorking(false);
          void queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey });
          // Install first, then enter the code. Links stay available if a browser
          // blocks the popup; a Mac opens the user's normal browser.
          await popup.go(started.device.installationUrl).catch(() => false);
        })
        .catch((cause: unknown) => {
          if (generation.current !== version) return;
          popup.close();
          setWorking(false);
          setError(cause instanceof Error ? cause : new Error('Could not connect GitHub.'));
        })
        .finally(() => {
          if (generation.current === version) starting.current = false;
        });
    },
    [queryClient],
  );

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    const version = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      if (cancelled || generation.current !== version) return;
      setFlow(null);
      setError(new Error(message));
      provider.current?.close();
      void queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey });
    };
    const expiresAt = Date.parse(flow.device.expiresAt);
    const expiry = setTimeout(
      () => fail('The GitHub code expired. Connect again for a new code.'),
      Math.max(0, expiresAt - Date.now()),
    );
    const poll = async () => {
      if (Date.now() >= expiresAt) {
        fail('The GitHub code expired. Connect again for a new code.');
        return;
      }
      try {
        const result = await pollGitDevice(flow.connectionId);
        if (cancelled || generation.current !== version) return;
        if (result.status === 'connected') {
          setFlow(null);
          setError(null);
          provider.current?.close();
          if (provider.current?.mode === 'external')
            void desktopOAuth()
              ?.finished()
              .catch(() => {});
          void queryClient.invalidateQueries({ queryKey: gitConnectionsQuery.queryKey });
          connected.current(result.connection);
        } else if (result.status === 'error') {
          fail(result.message);
        } else {
          setStage(result.stage);
          timer = setTimeout(poll, result.interval * 1000);
        }
      } catch (cause) {
        if (!cancelled && generation.current === version)
          fail(
            cause instanceof Error
              ? cause.message
              : 'Could not check GitHub authorization. Try connecting again.',
          );
      }
    };
    timer = setTimeout(poll, flow.device.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(expiry);
    };
  }, [flow, queryClient]);

  const open = (url: string) => {
    const popup = provider.current ?? openSignInWindow({ prefetch: false });
    void popup.go(url).catch(() => false);
  };
  return { flow, working, stage, error, begin, cancel, open };
}

export function GitDeviceConnect({ state }: { state: ReturnType<typeof useGitDeviceConnection> }) {
  const [clientId, setClientId] = useState('');
  const [appSlug, setAppSlug] = useState('');
  const busy = state.working || state.flow !== null;
  return (
    <div className="flex flex-col gap-3" data-git-device-connect>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => state.begin()}>
          {state.working ? 'Connecting…' : 'Connect GitHub'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Install the App, then authorize with a device code. No public URL needed.
        </span>
      </div>
      <ErrorText error={state.error} />
      {state.flow && (
        <div
          className="flex flex-col gap-3 rounded-md border p-3"
          aria-label="Authorize GitHub repositories"
        >
          <ol className="flex list-inside list-decimal flex-col gap-2 text-sm">
            <li>
              <a
                href={state.flow.device.installationUrl}
                onClick={(event) => {
                  event.preventDefault();
                  state.open(state.flow!.device.installationUrl);
                }}
                className="font-medium underline underline-offset-2"
              >
                Install the GitHub App
              </a>{' '}
              on your personal account or organization and select repositories.
            </li>
            <li>
              <a
                href={state.flow.device.verificationUrl}
                onClick={(event) => {
                  event.preventDefault();
                  state.open(state.flow!.device.verificationUrl);
                }}
                className="font-medium underline underline-offset-2"
              >
                Authorize on GitHub
              </a>{' '}
              using this code:
              <code className="ml-2 select-all rounded border bg-muted px-2 py-1 font-mono font-semibold tracking-wider">
                {state.flow.device.userCode}
              </code>
            </li>
          </ol>
          <p role="status" className="text-xs text-muted-foreground">
            {state.stage === 'installation'
              ? 'Install the App or wait for organization approval. We’ll keep checking.'
              : 'Waiting for GitHub authorization. Keep this page open.'}
          </p>
          <div>
            <Button size="sm" variant="ghost" onClick={state.cancel}>
              Cancel authorization
            </Button>
          </div>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Use a different GitHub App</summary>
        <form
          className="mt-2 flex flex-col gap-2 rounded-md border p-3"
          aria-label="Custom GitHub App"
          onSubmit={(event) => {
            event.preventDefault();
            if (clientId.trim() && appSlug.trim())
              state.begin({ clientId: clientId.trim(), appSlug: appSlug.trim() });
          }}
        >
          <p>
            Enable Device Flow on your App. Only its public client ID and slug are needed, not a
            client secret or private key.
          </p>
          <label className="flex flex-col gap-1">
            Client ID
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="Iv23…"
            />
          </label>
          <label className="flex flex-col gap-1">
            App slug
            <Input
              value={appSlug}
              onChange={(event) => setAppSlug(event.target.value)}
              placeholder="your-app-slug"
            />
          </label>
          <div>
            <Button size="sm" type="submit" disabled={busy || !clientId.trim() || !appSlug.trim()}>
              Connect custom App
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}
