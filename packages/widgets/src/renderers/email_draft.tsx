import { Button, Input } from '@openbots/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { EmailDraft, EmailDraftState } from '../kinds/email_draft.js';
import type { WidgetRendererProps } from './types.js';

// An email draft (W1, W2): From, To, Subject and body, all editable, and
// Send. Send posts the edited draft; the send itself goes through the Bot's
// policy, so by default an approval follows. After that the draft shows what
// was sent, or that the send failed and can be tried again.

const STATUS_TEXT: Record<EmailDraftState['status'], string> = {
  draft: '',
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Sending failed. Edit the draft and send again.',
};

/** "a@x.com, b@y.com" as a list; empty entries dropped. */
export function addressList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function EmailDraftWidget({
  props,
  state,
  onAction,
}: WidgetRendererProps<EmailDraft, EmailDraftState>) {
  const [local, setLocal] = useState<EmailDraftState | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = state?.draft ?? local?.draft;
  const start = sent ?? props;
  const [from, setFrom] = useState(start.from ?? '');
  const [to, setTo] = useState(start.to.join(', '));
  const [cc, setCc] = useState((start.cc ?? []).join(', '));
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);

  // The server's state wins once it moves past the local one.
  const current = state && state.status !== 'draft' ? state : (local ?? state);
  const status = current?.status ?? 'draft';
  const editable = (status === 'draft' || status === 'failed') && !!onAction;
  const disabled = !editable || busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!onAction) return;
    const recipients = addressList(to);
    if (!recipients.length) {
      setError('Add at least one recipient');
      return;
    }
    const copies = addressList(cc);
    const action = {
      type: 'send' as const,
      ...(from.trim() ? { from: from.trim() } : {}),
      to: recipients,
      ...(copies.length ? { cc: copies } : {}),
      subject,
      body,
    };
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction(action)) as EmailDraftState | undefined;
      const { type: _send, ...draft } = action;
      setLocal(next && next.status !== 'draft' ? next : { status: 'sending', draft });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the email');
    } finally {
      setBusy(false);
    }
  }

  const field = 'h-8 text-sm';
  return (
    <form
      className="flex max-w-xl flex-col gap-2 rounded-lg border bg-card p-3 text-sm"
      data-widget="email_draft"
      data-status={status}
      onSubmit={(e) => void submit(e)}
    >
      <Row label="From">
        <Input
          className={field}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="Default sender"
          aria-label="From"
          disabled={disabled}
        />
      </Row>
      <Row label="To">
        <Input
          className={field}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To"
          disabled={disabled}
          required
        />
      </Row>
      {(cc || editable) && (
        <Row label="Cc">
          <Input
            className={field}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            aria-label="Cc"
            disabled={disabled}
          />
        </Row>
      )}
      <Row label="Subject">
        <Input
          className={field}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Subject"
          disabled={disabled}
        />
      </Row>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Body"
        rows={8}
        disabled={disabled}
        className="w-full rounded-md border bg-transparent px-3 py-2 text-sm disabled:opacity-70"
      />
      <div className="flex items-center gap-3">
        {editable && (
          <Button type="submit" size="sm" disabled={disabled}>
            Send
          </Button>
        )}
        {STATUS_TEXT[status] && (
          <p role="status" className="text-xs text-muted-foreground">
            {STATUS_TEXT[status]}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
