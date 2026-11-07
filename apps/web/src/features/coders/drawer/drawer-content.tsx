import { CODING_SESSION_LIVE } from '@openbots/shared';
import { cn } from '@openbots/ui';
import { sessionStatusWords } from '@openbots/widgets';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { botsQuery } from '../../bots/queries.js';
import { ErrorText } from '../../models/error-text.js';
import { ago } from '../../repos/api.js';
import { PanelFrame } from '../../transcript/panel-frame.js';
import { AgentMark } from '../agent-mark.js';
import { codingSessionsQuery, type CodingSession } from '../api.js';
import { SessionView, STATUS_DOT, titleOf, whereOf } from './session-view.js';

// The drawer's body (CA15), loaded when it first opens: the owner's sessions
// with the ones still live first, and a session in place as a conversation
// with its agent.

export function CodingSessionsDrawer({ onClose }: { onClose(): void }) {
  const sessions = useQuery(codingSessionsQuery);
  const bots = useQuery(botsQuery);
  const [openId, setOpenId] = useState<string | null>(null);
  const botName = (botId: string) => bots.data?.items.find((b) => b.id === botId)?.name ?? 'Bot';
  const session = openId ? sessions.data?.find((s) => s.id === openId) : undefined;

  return (
    <PanelFrame title="Coding sessions" onClose={onClose}>
      {session ? (
        <SessionView
          key={session.id}
          session={session}
          botName={botName(session.botId)}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <SessionList
          sessions={sessions.data}
          error={sessions.error}
          botName={botName}
          onOpen={setOpenId}
        />
      )}
    </PanelFrame>
  );
}

function SessionList({
  sessions,
  error,
  botName,
  onOpen,
}: {
  sessions: CodingSession[] | undefined;
  error: Error | null;
  botName(botId: string): string;
  onOpen(id: string): void;
}) {
  if (error)
    return (
      <div className="p-4">
        <ErrorText error={error} />
      </div>
    );
  if (!sessions) return <p className="p-4 text-xs text-muted-foreground">Loading…</p>;
  if (sessions.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No coding sessions yet. Ask a Bot to work on a repository, or start one from its chat.
      </p>
    );
  }
  const running = sessions.filter((s) => CODING_SESSION_LIVE.includes(s.status));
  const earlier = sessions.filter((s) => !CODING_SESSION_LIVE.includes(s.status));
  return (
    <div className="flex flex-col gap-4 p-3">
      {[
        { title: 'Running', rows: running },
        { title: 'Earlier', rows: earlier },
      ].map(
        (group) =>
          group.rows.length > 0 && (
            <section key={group.title} data-group={group.title}>
              <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>
              <ul className="flex flex-col">
                {group.rows.map((s) => (
                  <li key={s.id}>
                    <SessionRow session={s} botName={botName(s.botId)} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

function SessionRow({
  session,
  botName,
  onOpen,
}: {
  session: CodingSession;
  botName: string;
  onOpen(id: string): void;
}) {
  const when = ago(session.finishedAt ?? session.startedAt ?? session.createdAt);
  return (
    <button
      type="button"
      data-session-row={session.id}
      className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
      onClick={() => onOpen(session.id)}
    >
      <AgentMark agent={session.agent} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{titleOf(session)}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{whereOf(session)}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-2 rounded-full', STATUS_DOT[session.status])} />
          {[sessionStatusWords[session.status], botName, when].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  );
}
