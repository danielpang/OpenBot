import type {
  CoderAgent,
  CoderEvent,
  CoderUsage,
  CodingSessionEntry,
  CoderTranscriptEvent,
} from '@openbots/shared';
import { Button, cn } from '@openbots/ui';
import { usageWords } from '@openbots/widgets';
import { CODER_ACTION_WORDS } from '@openbots/widgets/react';
import { useState, type ReactNode } from 'react';
import { ErrorText } from '../../models/error-text.js';
import { Markdown } from '../../transcript/markdown.js';
import { AcceptEdits } from '../../bots/accept-edits.js';
import { AgentMark } from '../agent-mark.js';
import type { CodingSession, PendingApproval } from '../api.js';

// A session's transcript as a conversation (CA15): the prompts as the
// asker's bubbles, the agent's messages in markdown, its actions as compact
// rows between them, its approval requests as cards and each turn's end as
// a closing block.

type Of<T extends CoderTranscriptEvent['type']> = CodingSessionEntry & {
  event: Extract<CoderTranscriptEvent, { type: T }>;
};
type ActionEntry = Of<'tool_use'> | Of<'command'> | Of<'file_change'>;

export type TranscriptItem =
  | { kind: 'prompt'; entry: Of<'prompt'> }
  | { kind: 'text'; entry: Of<'text'> }
  | { kind: 'actions'; entries: ActionEntry[] }
  | { kind: 'approval'; entry: Of<'approval_request'> }
  | { kind: 'result'; entry: Of<'result'>; usage?: CoderUsage }
  | { kind: 'error'; entry: Of<'error'> };

const isAction = (entry: CodingSessionEntry): entry is ActionEntry =>
  entry.event.type === 'tool_use' ||
  entry.event.type === 'command' ||
  entry.event.type === 'file_change';

/** The entries as the conversation shows them: actions in a row grouped, usage on its turn's result. */
export function transcriptItems(entries: readonly CodingSessionEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let usage: { turn: number; usage: CoderUsage } | undefined;
  for (const entry of entries) {
    const last = items.at(-1);
    if (isAction(entry)) {
      if (last?.kind === 'actions') last.entries.push(entry);
      else items.push({ kind: 'actions', entries: [entry] });
      continue;
    }
    const { event } = entry;
    if (event.type === 'usage') {
      const { type: _type, ...counts } = event;
      usage = { turn: entry.turn, usage: counts };
      continue;
    }
    if (event.type === 'result') {
      items.push({
        kind: 'result',
        entry: entry as Of<'result'>,
        ...(usage?.turn === entry.turn ? { usage: usage.usage } : {}),
      });
      continue;
    }
    if (event.type === 'prompt') items.push({ kind: 'prompt', entry: entry as Of<'prompt'> });
    else if (event.type === 'text') items.push({ kind: 'text', entry: entry as Of<'text'> });
    else if (event.type === 'approval_request') {
      items.push({ kind: 'approval', entry: entry as Of<'approval_request'> });
    } else items.push({ kind: 'error', entry: entry as Of<'error'> });
  }
  return items;
}

/**
 * The pending approval each request in the transcript waits on, by seq: the
 * server records an approval it asks the owner for with the approval's id
 * as `request_id`, and `GET /approvals` says which session asked.
 */
export function matchApprovals(
  items: readonly TranscriptItem[],
  approvals: readonly PendingApproval[] | undefined,
  sessionId: string,
): Map<number, PendingApproval> {
  const open = new Map(
    approvals?.filter((a) => a.sessionId === sessionId).map((a) => [a.id, a]) ?? [],
  );
  const matched = new Map<number, PendingApproval>();
  for (const item of items) {
    const approval = item.kind === 'approval' && open.get(item.entry.event.request_id);
    if (approval) matched.set(item.entry.seq, approval);
  }
  return matched;
}

/** More actions than this in a row fold into "N actions". */
const ACTIONS_SHOWN = 3;

export function TranscriptView({
  items,
  session,
  botName,
  approvals,
  onDecide,
}: {
  items: readonly TranscriptItem[];
  session: CodingSession;
  botName: string;
  approvals: Map<number, PendingApproval>;
  onDecide(approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
}) {
  const lastResult = items.findLast((item) => item.kind === 'result');
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
        switch (item.kind) {
          case 'prompt':
            return <PromptBubble key={item.entry.seq} entry={item.entry} botName={botName} />;
          case 'text':
            return (
              <AgentMessage key={item.entry.seq} agent={session.agent}>
                <Markdown text={item.entry.event.text} />
              </AgentMessage>
            );
          case 'actions':
            return <ActionRows key={item.entries[0]!.seq} entries={item.entries} />;
          case 'approval':
            return (
              <ApprovalCard
                key={item.entry.seq}
                entry={item.entry}
                botId={session.botId}
                approval={approvals.get(item.entry.seq)}
                onDecide={onDecide}
              />
            );
          case 'result':
            return (
              <ResultBlock
                key={item.entry.seq}
                result={item.entry.event}
                usage={item.usage}
                agent={session.agent}
                session={item === lastResult ? session : undefined}
              />
            );
          case 'error':
            return (
              <p
                key={item.entry.seq}
                data-entry="error"
                className="whitespace-pre-wrap break-words text-sm text-destructive"
              >
                {item.entry.event.message}
              </p>
            );
        }
      })}
    </div>
  );
}

function PromptBubble({ entry, botName }: { entry: Of<'prompt'>; botName: string }) {
  return (
    <div data-entry="prompt" data-by={entry.event.by} className="flex flex-col items-end gap-1">
      <span className="text-xs text-muted-foreground">
        {entry.event.by === 'owner' ? 'You' : botName}
      </span>
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        {entry.event.text}
      </p>
    </div>
  );
}

function AgentMessage({ agent, children }: { agent: CoderAgent; children: ReactNode }) {
  return (
    <div data-entry="text" className="flex gap-2">
      <AgentMark agent={agent} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function actionLine(event: Extract<CoderEvent, { type: ActionEntry['event']['type'] }>) {
  switch (event.type) {
    case 'tool_use':
      return { label: event.name, text: event.summary };
    case 'command':
      return {
        label: event.exit_code === undefined ? 'Run' : `Run (exit ${event.exit_code})`,
        text: event.command,
      };
    case 'file_change': {
      const counts =
        event.added !== undefined || event.removed !== undefined
          ? ` +${event.added ?? 0} −${event.removed ?? 0}`
          : '';
      const verb = { edit: 'Edit', create: 'Create', delete: 'Delete' }[event.kind];
      return { label: verb, text: `${event.path}${counts}` };
    }
  }
}

function ActionRows({ entries }: { entries: ActionEntry[] }) {
  const [open, setOpen] = useState(false);
  const grouped = entries.length > ACTIONS_SHOWN;
  return (
    <div data-entry="actions" className="ml-7 flex flex-col gap-1 font-mono text-xs">
      {grouped && (
        <button
          type="button"
          className="self-start text-muted-foreground hover:underline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide actions' : `${entries.length} actions`}
        </button>
      )}
      {(!grouped || open) &&
        entries.map((entry) => {
          const line = actionLine(entry.event);
          return (
            <details
              key={entry.seq}
              data-action={entry.event.type}
              className="rounded-md border px-2 py-1.5"
            >
              <summary className="cursor-pointer text-muted-foreground">
                {line.label}
                <span className="ml-2 inline-block max-w-[75%] truncate align-bottom">
                  {line.text}
                </span>
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words border-t pt-2 font-mono text-xs">
                {line.text}
                {entry.event.type === 'command' && entry.event.summary
                  ? `\n${entry.event.summary}`
                  : ''}
              </pre>
            </details>
          );
        })}
    </div>
  );
}

function ApprovalCard({
  entry,
  botId,
  approval,
  onDecide,
}: {
  entry: Of<'approval_request'>;
  botId: string;
  approval: PendingApproval | undefined;
  onDecide(approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { event } = entry;
  const decide = async (decision: 'approve' | 'deny') => {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(approval.id, decision);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-entry="approval"
      data-approval={approval?.id}
      className={cn(
        'ml-7 flex flex-col gap-1.5 rounded-md border p-2 text-sm',
        approval && 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{event.title}</span>
        <span className="text-xs text-muted-foreground">
          {CODER_ACTION_WORDS[event.action_class]}
        </span>
      </div>
      {event.detail && (
        <code className="break-all rounded bg-muted px-1.5 py-1 font-mono text-xs">
          {event.detail}
        </code>
      )}
      {approval && (
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide('deny')}
          >
            Deny
          </Button>
        </div>
      )}
      {approval && <AcceptEdits botId={botId} />}
      <ErrorText error={error} />
    </div>
  );
}

const sum = (files: CodingSession['changedFiles'], key: 'added' | 'removed') =>
  files.reduce((n, f) => n + f[key], 0);

/** A turn's end; the session's last also lists what the session changed, from its row. */
function ResultBlock({
  result,
  usage,
  agent,
  session,
}: {
  result: Of<'result'>['event'];
  usage?: CoderUsage;
  agent: CoderAgent;
  session?: CodingSession;
}) {
  const files = session?.changedFiles ?? [];
  const commits = session?.commits ?? [];
  return (
    <div data-entry="result" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      {result.summary && <Markdown text={result.summary} />}
      {result.error && (
        <p className="whitespace-pre-wrap break-words text-destructive">{result.error}</p>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">
            {files.length === 1 ? '1 file changed' : `${files.length} files changed`}{' '}
            <span className="font-normal text-muted-foreground">
              (+{sum(files, 'added')} −{sum(files, 'removed')})
            </span>
          </p>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto font-mono text-xs">
            {files.map((f) => (
              <li key={f.path} className="flex gap-2" data-file={f.path}>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-emerald-600 dark:text-emerald-400">+{f.added}</span>
                <span className="text-destructive">−{f.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {commits.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {commits.map((c) => (
            <li key={c.sha} className="flex gap-2">
              <code className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</code>
              <span className="min-w-0 truncate">{c.title}</span>
            </li>
          ))}
        </ul>
      )}
      {(usage || session?.prUrl) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {usage && <span data-usage>{usageWords(usage, agent)}</span>}
          {session?.prUrl && (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Open PR
            </a>
          )}
        </div>
      )}
    </div>
  );
}
