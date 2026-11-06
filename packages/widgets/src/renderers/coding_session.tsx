import {
  CODER_AGENT_LABELS,
  CODING_SESSION_ENDED,
  type CoderActionClass,
  type CodingSessionStatus,
} from '@openbots/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@openbots/ui';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { CodingSessionProps, CodingSessionState } from '../kinds/coding_session.js';
import {
  approvalStatusWords,
  sessionErrorWords,
  sessionStatusWords,
  usageWords,
} from '../kinds/coder-words.js';
import type { WidgetRendererProps } from './types.js';

// A coding session (CA5 to CA8): which agent works on which repository and
// branch, for how long, a live feed of what it does, the approvals it asks
// for inline, and when it ends the summary, changed files, commits, PR and
// cost. Stop, Continue and Discard branch are the widget's own actions;
// approvals, Open terminal and View log go through the app (`coder`), and
// View diff opens the Artifact the diff was saved as in the app's viewer.

const STATUS_DOT: Record<CodingSessionStatus, string> = {
  queued: 'bg-muted-foreground/50',
  starting: 'bg-emerald-500/60',
  running: 'bg-emerald-500 animate-pulse',
  waiting: 'bg-amber-500',
  settled: 'bg-muted-foreground',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground',
};

export const CODER_ACTION_WORDS: Record<CoderActionClass, string> = {
  push: 'Push',
  pr: 'Pull request',
  outside_worktree: 'Outside the worktree',
  install: 'Install',
  destructive: 'Destructive',
  other: 'Other',
};

/** 4:12, or 1:04:12 past an hour: the running clock. */
export function sessionClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 45s, 6 min, 1 h 5 min: how long an ended session took. */
export function sessionDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

/** The repository's own name, without its owner, as the header chip shows it. */
const repoName = (fullName: string) => fullName.split('/').at(-1) ?? fullName;

function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export function CodingSessionWidget({
  props,
  state,
  onAction,
  coder,
  renderMarkdown,
  onOpenArtifact,
}: WidgetRendererProps<CodingSessionProps, CodingSessionState>) {
  const [local, setLocal] = useState<{
    base: CodingSessionState | undefined;
    next: CodingSessionState;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, 'approved' | 'denied'>>({});
  const [continuing, setContinuing] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [log, setLog] = useState<{ open: boolean; text: string | null; error: string | null }>({
    open: false,
    text: null,
    error: null,
  });

  const current: CodingSessionState = (local && local.base === state ? local.next : state) ?? {
    status: 'queued',
    feed: [],
    approvals: [],
  };
  const status = current.status;
  const ended = CODING_SESSION_ENDED.includes(status);
  const live = status === 'running' || status === 'waiting' || status === 'starting';
  const now = useNow(live && !!current.started_at);
  const result = current.result;
  const diffArtifactId = diffArtifact(result);

  const started = current.started_at ? new Date(current.started_at).getTime() : null;
  const time = ended
    ? result?.duration_ms !== undefined
      ? sessionDuration(result.duration_ms)
      : started && current.finished_at
        ? sessionDuration(new Date(current.finished_at).getTime() - started)
        : null
    : started
      ? sessionClock(now - started)
      : null;

  async function run(
    action: { type: 'stop' | 'discard' } | { type: 'continue'; prompt: string },
    fallback: CodingSessionState,
  ) {
    if (!onAction) return false;
    setBusy(true);
    setError(null);
    try {
      const next = (await onAction(action)) as CodingSessionState | undefined;
      setLocal({ base: state, next: next ?? fallback });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: 'approve' | 'deny') {
    if (!coder) return;
    setBusy(true);
    setError(null);
    try {
      await coder.decideApproval(id, decision);
      setDecided((d) => ({ ...d, [id]: decision === 'approve' ? 'approved' : 'denied' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the decision');
    } finally {
      setBusy(false);
    }
  }

  async function openTerminal() {
    if (!coder) return;
    setError(null);
    try {
      await coder.openTerminal(props.session_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the terminal');
    }
  }

  async function viewLog() {
    if (!coder) return;
    setLog({ open: true, text: null, error: null });
    try {
      const text = await coder.loadLog(props.session_id);
      setLog({ open: true, text, error: null });
    } catch (e) {
      setLog({
        open: true,
        text: null,
        error: e instanceof Error ? e.message : 'Could not load the log',
      });
    }
  }

  async function sendContinue(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const ok = await run(
      { type: 'continue', prompt: text },
      { ...current, status: 'queued', control: 'continue' },
    );
    if (ok) {
      setPrompt('');
      setContinuing(false);
    }
  }

  const approvals = current.approvals.map((a) =>
    a.status === 'pending' && decided[a.id] ? { ...a, status: decided[a.id]! } : a,
  );
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const closedApprovals = approvals.filter((a) => a.status !== 'pending');
  const discarding = current.control === 'discard';

  return (
    <div
      data-widget="coding_session"
      data-status={status}
      className={cn(
        'flex w-full max-w-xl flex-col gap-2 rounded-lg border bg-card p-3 text-sm',
        status === 'failed' && 'border-destructive/50',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          data-dot={status}
          className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])}
        />
        <span className="font-medium">Coding session</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {CODER_AGENT_LABELS[props.agent]}
        </span>
        <span
          className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
          title={`${props.repo} on ${props.branch}`}
        >
          {repoName(props.repo)} · {props.branch}
        </span>
        <span className="ml-auto text-xs text-muted-foreground" role="status">
          {sessionStatusWords[status]}
          {time ? ` · ${time}` : ''}
        </span>
      </div>

      {props.prompt_excerpt && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{props.prompt_excerpt}</p>
      )}

      <Feed lines={current.feed} follow={!ended} />

      {pendingApprovals.map((a) => (
        <div
          key={a.id}
          data-approval={a.id}
          className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{a.title}</span>
            <span className="text-xs text-muted-foreground">
              {CODER_ACTION_WORDS[a.action_class]}
            </span>
          </div>
          {a.detail && (
            <code className="break-all rounded bg-muted px-1.5 py-1 font-mono text-xs">
              {a.detail}
            </code>
          )}
          {coder && (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void decide(a.id, 'approve')}
              >
                Approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void decide(a.id, 'deny')}
              >
                Deny
              </Button>
            </div>
          )}
        </div>
      ))}
      {closedApprovals.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {closedApprovals.map((a) => (
            <li key={a.id} data-approval={a.id}>
              {a.title}: {approvalStatusWords[a.status as keyof typeof approvalStatusWords]}
            </li>
          ))}
        </ul>
      )}

      {ended && result && (
        <div className="flex flex-col gap-2 border-t pt-2" data-result>
          {result.summary &&
            (renderMarkdown ? (
              renderMarkdown(result.summary)
            ) : (
              <p className="whitespace-pre-wrap">{result.summary}</p>
            ))}
          {result.changed_files.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium">
                {result.changed_files.length === 1
                  ? '1 file changed'
                  : `${result.changed_files.length} files changed`}{' '}
                <span className="font-normal text-muted-foreground">
                  (+{sum(result.changed_files, 'added')} −{sum(result.changed_files, 'removed')})
                </span>
              </p>
              <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto font-mono text-xs">
                {result.changed_files.map((f) => (
                  <li key={f.path} className="flex gap-2" data-file={f.path}>
                    <span className="min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="text-emerald-600 dark:text-emerald-400">+{f.added}</span>
                    <span className="text-destructive">−{f.removed}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.commits.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs">
              {result.commits.map((c) => (
                <li key={c.sha} className="flex gap-2">
                  <code className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</code>
                  <span className="min-w-0 truncate">{c.title}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {result.usage && <span data-usage>{usageWords(result.usage, props.agent)}</span>}
            {diffArtifactId && onOpenArtifact && (
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => onOpenArtifact(diffArtifactId)}
              >
                View diff
              </button>
            )}
            {result.pr_url && (
              <a
                href={result.pr_url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Open PR
              </a>
            )}
          </div>
        </div>
      )}

      {current.error && (
        <p className="whitespace-pre-wrap break-words text-xs text-destructive" data-error>
          {sessionErrorWords(current.error)}
        </p>
      )}
      {discarding && (
        <p className="text-xs text-muted-foreground" role="status">
          Discarding the branch.
        </p>
      )}

      {continuing && ended && (
        <form className="flex items-center gap-2" onSubmit={(e) => void sendContinue(e)}>
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should it do next?"
            aria-label="Next prompt"
            maxLength={4000}
            disabled={busy}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={busy || !prompt.trim()}>
            Send
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setContinuing(false)}>
            Cancel
          </Button>
        </form>
      )}

      {confirmDiscard && ended && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2">
          <p className="min-w-0 flex-1 text-xs">
            Delete the branch {props.branch} and its worktree? Commits that were not pushed are
            lost.
          </p>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void run({ type: 'discard' }, { ...current, control: 'discard' }).then(() =>
                setConfirmDiscard(false),
              )
            }
          >
            Discard branch
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
            Keep it
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {coder && ended && (
          <Button type="button" size="sm" variant="outline" onClick={() => void openTerminal()}>
            Open terminal
          </Button>
        )}
        {onAction && !ended && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run({ type: 'stop' }, { ...current, status: 'stopped' })}
          >
            Stop
          </Button>
        )}
        {onAction && ended && !continuing && !discarding && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setConfirmDiscard(false);
              setContinuing(true);
            }}
          >
            Continue
          </Button>
        )}
        {onAction && ended && !confirmDiscard && !discarding && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setContinuing(false);
              setConfirmDiscard(true);
            }}
          >
            Discard branch
          </Button>
        )}
        {coder && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void viewLog()}>
            View log
          </Button>
        )}
      </div>
      {coder && onAction && !ended && (
        <p className="text-xs text-muted-foreground">
          Stop the session to continue it in the terminal.
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <Dialog open={log.open} onOpenChange={(open) => setLog((l) => ({ ...l, open }))}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Session log</DialogTitle>
            <DialogDescription>
              {CODER_AGENT_LABELS[props.agent]} on {props.repo}, branch {props.branch}
            </DialogDescription>
          </DialogHeader>
          {log.error ? (
            <p role="alert" className="text-sm text-destructive">
              {log.error}
            </p>
          ) : log.text === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <pre
              data-log
              className="max-h-[60vh] overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {log.text || 'The log is empty.'}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The Artifact the session's diff was saved as, when the server saved one. */
function diffArtifact(result: CodingSessionState['result']): string | null {
  const id = (result as { diff_artifact_id?: unknown } | undefined)?.diff_artifact_id;
  return typeof id === 'string' && id ? id : null;
}

function sum(files: readonly { added: number; removed: number }[], key: 'added' | 'removed') {
  return files.reduce((n, f) => n + f[key], 0);
}

/** The last feed lines in a scrolling monospace block that follows new lines while live. */
function Feed({ lines, follow }: { lines: CodingSessionState['feed']; follow: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  if (!lines.length) {
    return <p className="text-xs text-muted-foreground">No activity yet.</p>;
  }
  return (
    <div
      ref={box}
      data-feed
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed"
    >
      {lines.map((line, i) => (
        <div
          key={`${line.t}-${i}`}
          data-type={line.type}
          className={cn(
            'whitespace-pre-wrap break-words',
            line.type === 'error' && 'text-destructive',
            line.type === 'approval_request' && 'text-amber-700 dark:text-amber-400',
          )}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}
