import { Button, Input, Spinner } from '@openbots/ui';
import { toString as qrSvg } from 'qrcode';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { PairCode, PairRelayView } from '../ipc.js';
import { AlertCircleIcon, CheckIcon } from './icons.js';
import { relayChanged, type PairFlow, type PairState } from './pair-flow.js';
import { Notice } from './parts.js';
import { useStore } from './use-store.js';

// The pairing window's view: the QR code with its countdown by the server's
// clock, then the phone that paired; and the Relay view, which warns that a
// new relay signs out the paired phones. The flow is in ./pair-flow.ts.

/** "4:59" for what is left until `expiresAt`, never below zero. */
export function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The relay as one line under the code. */
export function relayLine(relay: PairRelayView | null): string {
  if (!relay) return '';
  if (relay.current === null) {
    return 'This server has no relay, so your phone reaches it only on the same network or at its public address.';
  }
  if (relay.current === relay.sharedUrl) return 'Your phone connects through the OpenBots relay.';
  let host = relay.current;
  try {
    host = new URL(relay.current).host;
  } catch {
    // Shown as it is.
  }
  return `Your phone connects through your relay at ${host}.`;
}

export function PairWindow({ flow }: { flow: PairFlow }) {
  const state = useStore(flow.store);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') flow.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flow]);

  return (
    <main className="flex min-h-screen flex-col gap-5 bg-background px-6 pt-6 pb-6">
      {state.step === 'loading' && <Busy text="Loading…" />}
      {state.step === 'relay' && <RelayStep flow={flow} state={state} />}
      {state.step === 'confirm' && <ConfirmStep flow={flow} state={state} />}
      {state.step === 'applying' && (
        <Busy text="Restarting OpenBots on this Mac with the new relay…" />
      )}
      {state.step === 'saved' && (
        <Done
          id="saved"
          title="Relay changed"
          text={`${relayLine(state.relay)} Pair your phones again to use it.`}
        >
          <Button variant="outline" onClick={() => flow.close()}>
            Done
          </Button>
          <Button id="pair-again" onClick={() => void flow.newCode()}>
            Pair your phone
          </Button>
        </Done>
      )}
      {state.step === 'code' && <CodeStep flow={flow} state={state} />}
      {state.step === 'paired' && (
        <Done
          id="paired"
          title={`Paired ${state.paired}`}
          text="Your phone can reach your Bots now."
        >
          <Button id="done" onClick={() => flow.close()}>
            Done
          </Button>
        </Done>
      )}
    </main>
  );
}

function Done({
  id,
  title,
  text,
  children,
}: {
  id: string;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div id={id} className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckIcon className="size-5" />
      </span>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-80 text-sm text-muted-foreground">{text}</p>
      <div className="mt-2 flex gap-2">{children}</div>
    </div>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner className="motion-reduce:animate-none" aria-hidden />
      <span role="status">{text}</span>
    </div>
  );
}

function ErrorLine({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      {children}
    </p>
  );
}

function RelayStep({ flow, state }: { flow: PairFlow; state: PairState }) {
  const relay = state.relay;
  if (relay && !relay.local) {
    return (
      <div className="flex flex-col gap-4">
        <RelayHeader />
        <p id="relay-current" className="text-sm">
          {relayLine(relay)}
        </p>
        <p className="text-sm text-muted-foreground">
          This connection’s relay is set on its server, as OPENBOTS_RELAY_URL.
        </p>
        <div className="flex justify-end">
          <Button onClick={() => flow.close()}>Done</Button>
        </div>
      </div>
    );
  }
  const changed = relayChanged(state);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    flow.save();
  };
  return (
    <form id="relay-form" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <RelayHeader />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="relay-url" className="text-xs font-medium text-muted-foreground">
          Relay address
        </label>
        <Input
          id="relay-url"
          autoFocus
          value={state.url}
          onChange={(event) => flow.setUrl(event.target.value)}
          placeholder="wss://relay.example.com"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'relay-error' : 'relay-hint'}
          className="font-mono text-[13px]"
        />
        <p id="relay-hint" className="text-xs text-muted-foreground">
          {relay && state.url.trim() === relay.sharedUrl ? (
            'The OpenBots relay, which also sends notifications to your phone.'
          ) : (
            <>
              A relay you run yourself. Your phone gets notifications only while the app is open.{' '}
              <button
                id="use-shared"
                type="button"
                onClick={() => flow.useShared()}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                Use the OpenBots relay
              </button>
            </>
          )}
        </p>
      </div>
      {state.error && <ErrorLine id="relay-error">{state.error}</ErrorLine>}
      <Notice variant="warning" title="Changing the relay signs out your phones">
        Every phone paired with this Mac loses its connection and has to scan a new code. OpenBots
        also restarts on this Mac, which takes a few seconds.
      </Notice>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => flow.close()}>
          Cancel
        </Button>
        <Button id="relay-save" type="submit" disabled={!changed}>
          Save
        </Button>
      </div>
    </form>
  );
}

function RelayHeader() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-lg font-semibold">Relay</h1>
      <p className="text-sm text-muted-foreground">
        Away from home, your phone reaches this Mac through a relay. Everything it sends is end to
        end encrypted, so the relay never sees your chats or keys.
      </p>
    </header>
  );
}

function ConfirmStep({ flow, state }: { flow: PairFlow; state: PairState }) {
  return (
    <div id="relay-confirm" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Change the relay?</h1>
        <p className="text-sm text-muted-foreground">
          Your phones will be signed out of this Mac. Pair each one again with a new code once
          OpenBots restarts.
        </p>
      </header>
      <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] break-all">
        {state.url.trim()}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => flow.back()}>
          Back
        </Button>
        <Button id="relay-apply" variant="destructive" onClick={() => void flow.apply()}>
          Change relay and sign out phones
        </Button>
      </div>
    </div>
  );
}

function CodeStep({ flow, state }: { flow: PairFlow; state: PairState }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <header className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-lg font-semibold">Pair your phone</h1>
        <p className="text-sm text-muted-foreground">
          Scan this code with the OpenBots app on your iPhone.
        </p>
      </header>
      {state.code && state.link === 'failed' ? (
        <LinkFailed flow={flow} state={state} />
      ) : state.code && state.link === 'waiting' ? (
        <div className="flex h-56 items-center">
          <Busy text="Connecting your server to the relay…" />
        </div>
      ) : state.code ? (
        <Code code={state.code} onRenew={() => void flow.newCode()} />
      ) : state.making ? (
        <div className="flex h-56 items-center">
          <Busy text="Making a code…" />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-6">
          {state.error && <ErrorLine id="code-error">{state.error}</ErrorLine>}
          <Button onClick={() => void flow.newCode()}>Try again</Button>
        </div>
      )}
      <p id="relay-line" className="text-center text-xs text-muted-foreground">
        {relayLine(state.relay)}{' '}
        {state.relay?.local && (
          <button
            id="change-relay"
            type="button"
            onClick={() => flow.changeRelay()}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Change relay
          </button>
        )}
      </p>
    </div>
  );
}

function LinkFailed({ flow, state }: { flow: PairFlow; state: PairState }) {
  return (
    <div
      id="link-failed"
      className="flex min-h-56 max-w-80 flex-col items-center justify-center gap-3 text-center"
    >
      <ErrorLine id="link-error">{state.linkError}</ErrorLine>
      <p className="text-xs text-muted-foreground">
        Your phone cannot reach this Mac through the relay until the server connects to it. Check
        the relay address, then try again.
      </p>
      <div className="flex gap-2">
        {state.relay?.local && (
          <Button
            id="link-change-relay"
            variant="outline"
            size="sm"
            onClick={() => flow.changeRelay()}
          >
            Change relay
          </Button>
        )}
        <Button id="link-retry" size="sm" onClick={() => void flow.newCode()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function Code({ code, onRenew }: { code: PairCode; onRenew(): void }) {
  // The server's clock, as near as its Date header tells.
  const serverNow = () => Date.now() + code.skewMs;
  const [now, setNow] = useState(serverNow);
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const expired = new Date(code.expiresAt).getTime() <= now;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + code.skewMs), 1000);
    return () => clearInterval(timer);
  }, [code.skewMs]);

  useEffect(() => {
    let current = true;
    setCopied(false);
    void qrSvg(code.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (text) => current && setSvg(text),
      () => current && setSvg(null),
    );
    return () => {
      current = false;
    };
  }, [code.link]);

  if (expired) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-3">
        <p className="text-sm">This code expired.</p>
        <Button id="new-code" onClick={onRenew}>
          New code
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {svg && (
        <img
          id="qr"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt="QR code for pairing your phone with this server"
          className="size-56 rounded-md bg-white p-2"
        />
      )}
      <p className="text-sm font-medium tabular-nums" role="timer">
        Expires in {countdown(code.expiresAt, now)}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(code.link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <p className="max-w-80 text-center text-xs text-muted-foreground">
        The code works once and expires in 5 minutes. Copy the link to send it to your phone by
        AirDrop or Messages.
      </p>
    </div>
  );
}
