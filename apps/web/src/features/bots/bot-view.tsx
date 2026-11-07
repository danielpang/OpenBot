import { Avatar } from '@openbots/avatars/react';
import { Button, cn } from '@openbots/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { capabilitiesQuery } from '../../app/api.js';
import { windowDragClass } from '../../app/platform.js';
import { useRightPanel } from '../../app/right-panel.js';
import { CodingSessionsButton } from '../coders/drawer/drawer.js';
import { ComputerActiveDot, computerActive } from '../computer/status-icon.js';
import { panelId, useShowBotPanel } from '../transcript/panel.js';
import { botChatQuery, botsQuery, type Bot } from './queries.js';

// The Bot view (PRD section 5): title bar, then the secondary tabs above the
// tab's content. The Computer toggle (K3) shows when the install has a
// computer, with a green dot while the Bot is using it (I5).

const TABS = [
  { to: '/bots/$botId', label: 'Chat', exact: true },
  { to: '/bots/$botId/routines', label: 'Routines', exact: false },
  { to: '/bots/$botId/artifacts', label: 'Artifacts', exact: false },
  { to: '/bots/$botId/memory', label: 'Memory', exact: false },
  { to: '/bots/$botId/settings', label: 'Settings', exact: false },
] as const;

// The active state goes through the Link's `data-status`: a variant always
// beats the base classes, which a second plain class of the same property may not.
const TAB_CLASS =
  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground data-[status=active]:border-foreground data-[status=active]:text-foreground';

/** The Bot with this id from the cached roster, which `bot.state` events keep current. */
export function useBot(botId: string) {
  const { data, isPending } = useQuery(botsQuery);
  return { bot: data?.items.find((bot) => bot.id === botId), isPending };
}

export function BotView({ botId }: { botId: string }) {
  const { bot, isPending } = useBot(botId);
  // Opening a Bot opens its transcript, which also clears a blocked state (B4).
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery({ ...botChatQuery(botId), staleTime: 0 });
  }, [queryClient, botId]);

  if (!bot) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {isPending ? null : 'This Bot does not exist.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <BotTitleBar bot={bot} />
      {/* The tabs sit in the middle column, so they stay centred whatever is beside them. */}
      <div data-slot="bot-tabs" className="grid grid-cols-[1fr_auto_1fr] border-b px-4">
        <div role="tablist" className="col-start-2 flex gap-1">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ botId }}
              role="tab"
              activeOptions={{ exact: tab.exact }}
              className={TAB_CLASS}
              activeProps={{ 'aria-selected': true }}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>
      {/* Positioned, so hidden absolute elements inside scroll here, not the window. */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

export function BotTitleBar({ bot }: { bot: Bot }) {
  return (
    <header className={cn('flex items-center gap-3 px-4 py-3', windowDragClass())}>
      <Avatar params={bot.avatar} state={bot.state.state} size={32} label={bot.name} />
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate font-semibold">{bot.name}</h1>
        {bot.label && <span className="truncate text-sm text-muted-foreground">{bot.label}</span>}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <ComputerControls bot={bot} />
        <CodingSessionsButton botId={bot.id} iconOnly />
      </div>
    </header>
  );
}

/** The Computer toggle, which opens the screen in the right panel, dotted while it is in use. */
function ComputerControls({ bot }: { bot: Bot }) {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { id } = useRightPanel();
  const show = useShowBotPanel(bot.id);
  if (!capabilities?.computer) return null;
  const previewing = id === panelId(bot.id, 'screen');
  const active = computerActive(bot.state);
  return (
    <div className="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={previewing}
        aria-label="Computer"
        title={active ? (bot.state.currentAction ?? 'Using its computer') : 'Computer'}
        className={cn('relative', previewing && 'bg-accent')}
        onClick={() => show(previewing ? null : { kind: 'screen' })}
      >
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
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
        <ComputerActiveDot bot={bot} />
      </Button>
    </div>
  );
}

/** A tab whose feature arrives in a later phase. */
export function LaterTab({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
