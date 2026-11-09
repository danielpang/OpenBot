import { CODER_AGENT_LABELS, type CoderAgent } from '@openbots/shared';
import { Button, Input } from '@openbots/ui';
import { useState, type FormEvent } from 'react';
import type { CoderLoginProps, CoderLoginWidgetState } from '../kinds/coder_login.js';
import { QrCode } from './qr-code.js';
import type { WidgetRendererProps } from './types.js';

// A coding agent sign-in (CA3): the agent's own login printed a link (and
// for Codex a device code); the owner opens it on any device, signs in to
// the vendor and pastes the code it shows back here. Use an API key and
// Can't sign in answer the request instead. Once answered it stays,
// disabled, saying how it ended. Show QR draws the link as a QR code, so a
// phone can open it. `CoderSignInSteps` is the link, code and paste field on
// their own, which Settings > Coding agents shows too.

/** The sign-in statuses that still take a code: the CLI asks for it right after printing the link. */
export const CODER_LOGIN_OPEN: readonly CoderLoginWidgetState['status'][] = [
  'pending',
  'awaiting_code',
];

const DEFAULT_INSTRUCTIONS: Record<CoderAgent, string> = {
  claude: 'Open this link on any device, sign in to Claude, then paste the code it gives you.',
  codex: 'Open this link on any device, sign in to ChatGPT and enter the code below.',
  pi: 'Open this link on any device, sign in, then paste the code it gives you.',
};

/** Under a device code: the code goes to the vendor's page, and nothing comes back here. */
export const DEVICE_CODE_NOTE: Record<CoderAgent, string> = {
  claude: 'Enter this code on the Claude page; nothing to paste back here.',
  codex: 'Enter this code on the OpenAI page; nothing to paste back here.',
  pi: 'Enter this code on the sign-in page; nothing to paste back here.',
};

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}
    >
      {label}
    </Button>
  );
}

export interface CoderSignInStepsProps {
  agent: CoderAgent;
  instructions?: string;
  url?: string | null;
  deviceCode?: string | null;
  /** Sends the pasted code; absent where there is nothing to paste back. */
  onCode?: (code: string) => Promise<void> | void;
  disabled?: boolean;
  /** Offers Show QR next to the link. */
  qr?: boolean;
}

/**
 * The link with Copy and Open link, then either the device code shown large
 * (Codex: the code goes to the vendor's page) or the paste field with Done
 * (Claude Code: the vendor's page gives a code to bring back).
 */
export function CoderSignInSteps({
  agent,
  instructions,
  url,
  deviceCode,
  onCode,
  disabled,
  qr,
}: CoderSignInStepsProps) {
  const [code, setCode] = useState('');
  const [showQr, setShowQr] = useState(false);
  const trimmed = code.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length < 4 || !onCode) return;
    void onCode(trimmed);
  }

  return (
    <div className="flex flex-col gap-2" data-sign-in-steps={agent}>
      <p className="text-muted-foreground">{instructions ?? DEFAULT_INSTRUCTIONS[agent]}</p>
      {url ? (
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs"
            title={url}
            data-sign-in-url
          >
            {url}
          </code>
          <CopyButton text={url} />
          {qr && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={showQr}
              onClick={() => setShowQr((shown) => !shown)}
            >
              {showQr ? 'Hide QR' : 'Show QR'}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          Waiting for {CODER_AGENT_LABELS[agent]} to show its sign-in link…
        </p>
      )}
      {qr && showQr && url && (
        <QrCode
          value={url}
          alt={`QR code for signing in to ${CODER_AGENT_LABELS[agent]}`}
          className="size-48"
        />
      )}
      {deviceCode && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Code</span>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="rounded-md bg-muted px-3 py-2 font-mono text-2xl font-semibold tracking-widest text-foreground"
              data-device-code
            >
              {deviceCode}
            </code>
            <CopyButton text={deviceCode} label="Copy code" />
          </div>
          <p className="text-xs text-muted-foreground" data-device-note>
            {DEVICE_CODE_NOTE[agent]}
          </p>
        </div>
      )}
      {url && (
        <div>
          <Button asChild size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              Open link
            </a>
          </Button>
        </div>
      )}
      {onCode && !deviceCode && (
        <form className="flex items-center gap-2" onSubmit={submit}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code here"
            aria-label="Code"
            autoComplete="off"
            maxLength={200}
            disabled={disabled}
          />
          <Button type="submit" size="sm" disabled={disabled || trimmed.length < 4}>
            Done
          </Button>
        </form>
      )}
    </div>
  );
}

function closedWords(state: CoderLoginWidgetState, agent: CoderAgent): string {
  const label = CODER_AGENT_LABELS[agent];
  switch (state.status) {
    case 'signed_in':
      return state.account_label
        ? `Signed in to ${label} as ${state.account_label}.`
        : `Signed in to ${label}.`;
    case 'failed':
      return `Not signed in to ${label}. The Bot was told.`;
    case 'expired':
      return 'This sign-in expired before it was finished. The Bot was told.';
    case 'cancelled':
      return state.wants_api_key
        ? 'You chose an API key instead. Add it in Settings > Coding agents.'
        : 'This sign-in was cancelled.';
    default:
      return '';
  }
}

export function CoderLoginWidget({
  props,
  state,
  onAction,
  onNavigate,
}: WidgetRendererProps<CoderLoginProps, CoderLoginWidgetState>) {
  // The reply to an action bridges the moment until `widget.updated`; a new
  // state from the server replaces it.
  const [local, setLocal] = useState<{
    base: CoderLoginWidgetState | undefined;
    next: CoderLoginWidgetState;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the owner sends a code; "Checking the code" shows until the status moves on.
  const [submitted, setSubmitted] = useState<{ status: string; error: string | null } | null>(null);

  const current: CoderLoginWidgetState = (local && local.base === state ? local.next : state) ?? {
    status: 'pending',
  };
  const status = current.status;
  const open = CODER_LOGIN_OPEN.includes(status);
  const checking =
    open &&
    !!submitted &&
    submitted.status === status &&
    submitted.error === (current.error ?? null);
  const disabled = busy || !onAction;
  const label = CODER_AGENT_LABELS[props.agent];
  const waiting = props.waiting ?? [];

  async function send(action: { type: 'code'; code: string } | { type: 'cant' | 'api_key' }) {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction(action)) as CoderLoginWidgetState | undefined;
      const fallback: CoderLoginWidgetState =
        action.type === 'code'
          ? { ...current, status: 'awaiting_code', code_submitted: true }
          : action.type === 'cant'
            ? { ...current, status: 'failed' }
            : { ...current, status: 'cancelled', wants_api_key: true };
      const settled = next ?? fallback;
      setLocal({ base: state, next: settled });
      if (action.type === 'code') {
        setSubmitted({ status: settled.status, error: settled.error ?? null });
      }
      if (action.type === 'api_key') onNavigate?.('/settings/coding-agents');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-widget="coder_login"
      data-status={status}
      className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <p>
        <span className="font-medium">Sign in to {label}</span>
      </p>
      {waiting.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Waiting: {waiting.map((w) => `@${w.handle}`).join(', ')}
        </p>
      )}
      {checking ? (
        <p role="status" className="text-muted-foreground">
          Checking the code with {label}…
        </p>
      ) : open ? (
        <>
          <CoderSignInSteps
            agent={props.agent}
            instructions={props.instructions}
            url={current.url ?? props.url}
            deviceCode={current.device_code ?? props.device_code}
            onCode={(code) => send({ type: 'code', code })}
            disabled={disabled}
            qr
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void send({ type: 'api_key' })}
            >
              Use an API key
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void send({ type: 'cant' })}
            >
              Can&apos;t sign in
            </Button>
          </div>
        </>
      ) : (
        <p
          role="status"
          className={status === 'signed_in' ? 'text-foreground' : 'text-muted-foreground'}
        >
          {closedWords(current, props.agent)}
        </p>
      )}
      {current.error && !checking && <p className="text-xs text-destructive">{current.error}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
