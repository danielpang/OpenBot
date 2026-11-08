import { CODING_SESSION_LIVE, sessionTitle, type CodingSessionStatus } from '@openbots/shared';
import { Button, cn } from '@openbots/ui';
import { sessionStatusWords } from '@openbots/widgets';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ComputerTerminal } from '../../computer/terminal.js';
import { ErrorText } from '../../models/error-text.js';
import { SessionComposer } from './session-composer.js';
import { AgentMark } from '../agent-mark.js';
import { AgentOrb, sessionActivity } from '../agent-orb.js';
import {
  codingSessionsQuery,
  codingSessionTerminal,
  decideApproval,
  pendingApprovalsQuery,
  stopCodingSession,
  type CodingSession,
} from '../api.js';
import { upsertSession } from './live.js';
import { matchApprovals, transcriptItems, TranscriptView } from './transcript.js';
import { useSessionTranscript } from './use-session-transcript.js';

// One coding session in the drawer (CA15): a header with Stop and Terminal,
// the transcript as a conversation that follows the bottom
// while the agent works, a terminal on the worktree when toggled on, and a
// composer for the owner's next prompt once the turn has ended.

export const STATUS_DOT: Record<CodingSessionStatus, string> = {
  queued: 'bg-muted-foreground/50',
  starting: 'bg-emerald-500/60',
  running: 'bg-emerald-500 animate-pulse',
  waiting: 'bg-amber-500',
  settled: 'bg-muted-foreground',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground',
};

export const titleOf = (session: CodingSession) =>
  session.title || sessionTitle('', session.repoFullName);

export const whereOf = (session: CodingSession) =>
  [session.repoFullName, session.branch].filter(Boolean).join(' · ');

export function SessionView({
  session,
  botName,
  onBack,
}: {
  session: CodingSession;
  botName: string;
  onBack(): void;
}) {
  const queryClient = useQueryClient();
  const live = CODING_SESSION_LIVE.includes(session.status);
  const transcript = useSessionTranscript(session.id, session.status);
  const approvals = useQuery(pendingApprovalsQuery);
  const items = useMemo(() => transcriptItems(transcript.entries), [transcript.entries]);
  const matched = useMemo(
    () => matchApprovals(items, approvals.data, session.id),
    [items, approvals.data, session.id],
  );
  const [terminal, setTerminal] = useState(false);
  const activity = sessionActivity(session.status, transcript.entries);

  const keep = (next: CodingSession) =>
    queryClient.setQueryData(codingSessionsQuery.queryKey, (current) =>
      current ? upsertSession(current, next) : current,
    );
  const stop = useMutation({ mutationFn: () => stopCodingSession(session.id), onSuccess: keep });
  const decide = async (approvalId: string, decision: 'approve' | 'deny') => {
    await decideApproval(approvalId, decision);
    await queryClient.invalidateQueries({ queryKey: pendingApprovalsQuery.queryKey });
  };

  // Follow the newest entry while live, unless the owner scrolled up.
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const count = transcript.entries.length;
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count, live]);

  return (
    <div className="flex h-full flex-col" data-session={session.id}>
      <header className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <AgentMark agent={session.agent} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{titleOf(session)}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{whereOf(session)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span aria-hidden className={cn('size-2 rounded-full', STATUS_DOT[session.status])} />
            {sessionStatusWords[session.status]}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {live && (
              <Button
                size="sm"
                variant="outline"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
              >
                Stop
              </Button>
            )}
            <Button
              size="sm"
              variant={terminal ? 'secondary' : 'outline'}
              aria-pressed={terminal}
              onClick={() => setTerminal((on) => !on)}
            >
              Terminal
            </Button>
          </div>
        </div>
        <ErrorText error={stop.error} />
      </header>

      <div
        ref={log}
        role="log"
        aria-label="Session"
        aria-busy={transcript.loading}
        className="min-h-0 flex-1 overflow-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {transcript.loading && items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing in this session yet.</p>
        ) : (
          <TranscriptView
            items={items}
            session={session}
            botName={botName}
            approvals={matched}
            onDecide={decide}
          />
        )}
        {activity && <AgentOrb {...activity} />}
        <ErrorText error={transcript.error} />
      </div>

      {terminal && <SessionTerminal sessionId={session.id} />}
      <SessionComposer session={session} onSent={keep} />
    </div>
  );
}

function SessionTerminal({ sessionId }: { sessionId: string }) {
  const attach = useQuery({
    queryKey: ['coding-sessions', sessionId, 'terminal'],
    queryFn: () => codingSessionTerminal(sessionId),
    retry: false,
    gcTime: 0,
  });
  return (
    <div className="border-t p-3" data-terminal>
      {attach.data ? (
        <ComputerTerminal attach={attach.data} />
      ) : attach.error ? (
        <ErrorText error={attach.error} />
      ) : (
        <p className="text-xs text-muted-foreground">Opening the terminal…</p>
      )}
    </div>
  );
}
