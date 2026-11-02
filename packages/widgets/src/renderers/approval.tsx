import { Button, cn, Input } from '@openbots/ui';
import { useState } from 'react';
import type { z } from 'zod';
import type { ApprovalPropsSchema, ApprovalState } from '../kinds/approval.js';
import type { WidgetRendererProps } from './types.js';

// An approval request (P1, T5): the tool, a one-line summary of its
// arguments, why the policy asked, then Approve and Deny with an optional
// note. Once decided it stays in the transcript, disabled, saying what was
// decided and by whom. The state arrives from the action's reply, from
// `widget.updated`, or from `approval.resolved` (which adds who and when).

type ApprovalProps = z.infer<typeof ApprovalPropsSchema>;
type TraceStep = NonNullable<ApprovalProps['trace']>[number];

/** The stored state plus what `approval.resolved` adds. */
export type ApprovalWidgetState = ApprovalState & {
  /** The user who decided; null when OpenBots closed it (expiry, a cancelled run). */
  decidedBy?: string | null;
  decidedAt?: string | null;
};

const DECISION_WORDS: Record<TraceStep['decision'], string> = {
  auto: 'run without asking',
  ask: 'ask you first',
  deny: 'refuse',
};

const RULE_WORDS: Record<string, string> = {
  default: 'By default',
  annotations: 'From the tool’s own hints',
  group: 'Your setting for the group',
  connector: 'Your setting for the connector',
  tool: 'Your setting for this tool',
  trigger: 'A stricter rule for how this run started',
};

/** A policy trace as sentences, one per rule that applied; the last one decided. */
export function traceInWords(trace: readonly TraceStep[]): string[] {
  return trace.map((step, i) => {
    const lead = RULE_WORDS[step.rule] ?? 'A rule';
    const verb = i === trace.length - 1 ? 'so the Bot will' : 'which would';
    return `${lead}: ${step.why}, ${verb} ${DECISION_WORDS[step.decision]}.`;
  });
}

/** What the closed widget says, e.g. "Approved by you". */
export function decisionText(state: ApprovalWidgetState): string {
  const when = state.decidedAt ? ` · ${new Date(state.decidedAt).toLocaleString()}` : '';
  switch (state.status) {
    case 'approved':
      return `Approved by you${when}`;
    case 'denied':
      return state.decidedBy === null
        ? `Closed when the run was stopped${when}`
        : `Denied by you${when}`;
    case 'expired':
      return 'Expired unanswered after 24 hours; the Bot was told no';
    default:
      return 'Waiting for your decision';
  }
}

export function ApprovalWidget({
  props,
  state,
  onAction,
  onReply,
}: WidgetRendererProps<ApprovalProps, ApprovalWidgetState>) {
  const [local, setLocal] = useState<ApprovalWidgetState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  // A resolved state from the server wins over the local one, which only
  // bridges the moment between the reply and the event.
  const current = state && state.status !== 'pending' ? state : (local ?? state);
  const status = current?.status ?? 'pending';
  const pending = status === 'pending';
  const disabled = !pending || busy || !onAction;

  async function decide(type: 'approve' | 'deny') {
    if (!onAction) return;
    setBusy(true);
    setError(null);
    const trimmed = note.trim();
    try {
      const next = (await onAction({ type, ...(trimmed ? { note: trimmed } : {}) })) as
        ApprovalWidgetState | undefined;
      setLocal(
        next && next.status !== 'pending'
          ? next
          : {
              status: type === 'approve' ? 'approved' : 'denied',
              ...(trimmed ? { note: trimmed } : {}),
            },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the decision');
    } finally {
      setBusy(false);
    }
  }

  const summary = props.summary ?? argsPreview(props.args);
  const steps = props.trace?.length ? traceInWords(props.trace) : [];

  return (
    <div
      className="flex max-w-lg flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
      data-widget="approval"
      data-status={status}
    >
      <p className="font-medium">
        Run <code className="rounded bg-muted px-1 py-0.5 text-xs">{props.tool_name}</code>?
      </p>
      {summary && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{summary}</p>
      )}
      {props.reason && (
        <p className="text-xs text-muted-foreground">Asked because {props.reason}.</p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Details</summary>
        {steps.length > 0 && (
          <ol className="mt-1 flex list-decimal flex-col gap-0.5 pl-4">
            {steps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        )}
        <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono">
          {JSON.stringify(props.args ?? {}, null, 2)}
        </pre>
      </details>
      {pending ? (
        <div className="flex flex-col gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            aria-label="Note"
            maxLength={2000}
            disabled={disabled}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => void decide('approve')}
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void decide('deny')}
            >
              Deny
            </Button>
            {onReply && (
              <Button type="button" size="sm" variant="ghost" onClick={onReply}>
                Reply in thread
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p
            role="status"
            className={cn(status === 'approved' ? 'text-foreground' : 'text-muted-foreground')}
          >
            {decisionText(current!)}
          </p>
          {current?.note && <p className="text-muted-foreground">“{current.note}”</p>}
          {onReply && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onReply}>
              Reply in thread
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A short line for arguments without a summary. */
function argsPreview(args: unknown): string {
  if (args === undefined || args === null) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
