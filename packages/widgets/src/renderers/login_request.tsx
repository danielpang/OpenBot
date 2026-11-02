import { Button } from '@openbots/ui';
import { useState } from 'react';
import type { z } from 'zod';
import type {
  LoginRequestPropsSchema,
  LoginRequestState,
  LoginRequestStatus,
} from '../kinds/login_request.js';
import type { WidgetRendererProps } from './types.js';

// A sign-in request (K1, K8): which Bot needs which site and why, every other
// Bot waiting on it with its own reason, then Take over, Done and Can't sign
// in. Take over opens the screen of the Bot whose transcript this is, on the
// sign-in page when the Bot gave one. Done and Can't sign in answer every
// waiting Bot; once answered or expired the widget stays, disabled, saying
// how it ended.

type LoginRequestProps = z.infer<typeof LoginRequestPropsSchema>;

const CLOSED_WORDS: Record<Exclude<LoginRequestStatus, 'pending'>, string> = {
  signed_in: 'Signed in. The waiting Bots carry on with the login.',
  failed: 'Not signed in. The waiting Bots were told.',
  expired: 'Expired unanswered. The waiting Bots were told.',
};

export function LoginRequestWidget({
  props,
  state,
  onAction,
  onTakeover,
}: WidgetRendererProps<LoginRequestProps, LoginRequestState>) {
  const [local, setLocal] = useState<LoginRequestState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A closed state from the server wins over the local one.
  const current = state && state.status !== 'pending' ? state : (local ?? state);
  const status = current?.status ?? 'pending';
  const pending = status === 'pending';
  const disabled = !pending || busy || !onAction;
  const others = (current?.waiting ?? []).filter((w) => w.bot_id !== props.requester.bot_id);

  async function send(type: 'done' | 'cant') {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction({ type })) as LoginRequestState | undefined;
      setLocal(next ?? { ...current, status: type === 'done' ? 'signed_in' : 'failed' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-widget="login_request"
      className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
    >
      <p className="font-medium">
        @{props.requester.handle} needs you to sign in to {props.site}
      </p>
      <p className="whitespace-pre-wrap text-muted-foreground">{props.reason}</p>
      {others.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p>Also waiting:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {others.map((w) => (
              <li key={w.run_id} data-waiter={w.handle}>
                <span className="font-medium text-foreground">@{w.handle}</span>
                {w.reason ? <span className="whitespace-pre-wrap">: {w.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pending ? (
        <>
          <p className="text-xs text-muted-foreground">
            Take over this Bot&apos;s screen, sign in, then press Done.
          </p>
          <div className="flex flex-wrap gap-2">
            {onTakeover && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onTakeover(props.screen_bot_id, props.url)}
              >
                Take over
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void send('done')}
            >
              Done
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void send('cant')}
            >
              Can&apos;t sign in
            </Button>
          </div>
        </>
      ) : (
        <p role="status" className="text-muted-foreground">
          {CLOSED_WORDS[status]}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
