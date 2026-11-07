import { CODING_SESSION_LIVE } from '@openbots/shared';
import { cn } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { CODING_SESSIONS_PANEL, useRightPanel } from '../../../app/right-panel.js';
import { PanelFrame } from '../../transcript/panel-frame.js';
import { codingSessionsQuery } from '../api.js';
import { useCodingSessionsLive } from './live.js';

// The coding sessions drawer (CA15): the sidebar's button opens it in the
// right panel, wide. The button is in every page's shell, so it stays light:
// the body (the list, a session's conversation, its terminal) loads when the
// drawer first opens.

const CodingSessionsDrawer = lazy(() =>
  import('./drawer-content.js').then((m) => ({ default: m.CodingSessionsDrawer })),
);

/** The sidebar's Coding sessions toggle, with how many sessions are live. */
export function CodingSessionsButton({
  botId,
  iconOnly = false,
}: {
  botId?: string;
  iconOnly?: boolean;
}) {
  useCodingSessionsLive();
  const sessions = useQuery(codingSessionsQuery);
  const { id, open, close } = useRightPanel();
  const live =
    sessions.data?.filter(
      (s) => (!botId || s.botId === botId) && CODING_SESSION_LIVE.includes(s.status),
    ).length ?? 0;
  const panelId = botId ? `${CODING_SESSIONS_PANEL}:${botId}` : CODING_SESSIONS_PANEL;
  const shown = id === panelId;
  const drawer = (
    <Suspense
      fallback={
        <PanelFrame title="Coding sessions" onClose={close}>
          <p className="p-4 text-xs text-muted-foreground">Loading…</p>
        </PanelFrame>
      }
    >
      <CodingSessionsDrawer key={botId ?? 'all'} botId={botId} onClose={close} />
    </Suspense>
  );
  return (
    <button
      type="button"
      aria-expanded={shown}
      aria-label="Coding sessions"
      title={iconOnly ? 'Coding sessions' : undefined}
      className={cn(
        'flex items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
        shown && 'bg-accent font-medium',
        iconOnly && 'h-8 w-9 justify-center',
      )}
      onClick={() => (shown ? close() : open(drawer, panelId, { width: 'wide' }))}
    >
      {iconOnly ? (
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />
        </svg>
      ) : (
        'Coding sessions'
      )}
      {!iconOnly && live > 0 && (
        <span
          data-live-count
          aria-label={live === 1 ? '1 live session' : `${live} live sessions`}
          className="ml-auto rounded-full bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-700 tabular-nums dark:text-emerald-400"
        >
          {live}
        </span>
      )}
    </button>
  );
}
