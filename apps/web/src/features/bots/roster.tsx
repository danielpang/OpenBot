import { Avatar } from '@openbots/avatars/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type MouseEvent } from 'react';
import { SidebarSection } from '../../app/sidebar.js';
import { GroupsSection } from '../chats/groups.js';
import { DeleteBotDialog } from './delete-bot-dialog.js';
import { botsQuery, hoverAction, rosterSections, useBotActions, type Bot } from './queries.js';

// The sidebar roster (B1): Pinned, Bots, then Groups. A row is the avatar,
// which carries the Bot's state (I2), the name and the label. Actions live in
// the right-click menu; there are no badges and no three-dots button.

export function Roster() {
  const { data } = useQuery(botsQuery);
  const [showHidden, setShowHidden] = useState(false);
  const [deleting, setDeleting] = useState<Bot | null>(null);

  return (
    <>
      <RosterView
        items={data?.items ?? []}
        showHidden={showHidden}
        onShowHidden={setShowHidden}
        onDelete={setDeleting}
      />
      <DeleteBotDialog bot={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

export function RosterView({
  items,
  showHidden,
  onShowHidden,
  onDelete,
}: {
  items: readonly Bot[];
  showHidden: boolean;
  onShowHidden(show: boolean): void;
  onDelete(bot: Bot): void;
}) {
  const { pinned, bots, hidden } = rosterSections(items);
  const list = (rows: Bot[]) =>
    rows.length ? (
      <ul className="flex flex-col gap-0.5">
        {rows.map((bot) => (
          <li key={bot.id}>
            <BotRow bot={bot} onDelete={onDelete} />
          </li>
        ))}
      </ul>
    ) : undefined;

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarSection title="Pinned" empty="Pinned Bots appear here.">
        {list(pinned)}
      </SidebarSection>
      <SidebarSection title="Bots" empty="No Bots yet.">
        {bots.length || hidden.length ? (
          <>
            {list(bots)}
            {showHidden && list(hidden)}
            {hidden.length > 0 && (
              <button
                type="button"
                className="mt-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                aria-pressed={showHidden}
                onClick={() => onShowHidden(!showHidden)}
              >
                {showHidden ? 'Hide hidden' : `Show hidden (${hidden.length})`}
              </button>
            )}
          </>
        ) : undefined}
      </SidebarSection>
      <GroupsSection bots={items} />
    </TooltipProvider>
  );
}

export function BotRow({ bot, onDelete }: { bot: Bot; onDelete(bot: Bot): void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { toggle, duplicate } = useBotActions();
  const navigate = useNavigate();
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenuOpen(true);
  };
  const action = hoverAction(bot.state);

  const row = (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.id }}
      onContextMenu={onContextMenu}
      className={`flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent ${bot.hidden ? 'opacity-60' : ''}`}
      activeProps={{ className: 'bg-accent' }}
    >
      <Avatar params={bot.avatar} state={bot.state.state} size={24} label={bot.name} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm">{bot.name}</span>
        {bot.label && <span className="truncate text-xs text-muted-foreground">{bot.label}</span>}
      </span>
    </Link>
  );

  return (
    <div className="relative">
      {action ? (
        <Tooltip>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-64 truncate">
            {action}
          </TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* Anchors the right-click menu under the row; never clicked itself. */}
        <DropdownMenuTrigger
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-2 size-0"
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => toggle.mutate({ id: bot.id, action: bot.pinned ? 'unpin' : 'pin' })}
          >
            {bot.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => toggle.mutate({ id: bot.id, action: bot.hidden ? 'unhide' : 'hide' })}
          >
            {bot.hidden ? 'Show in sidebar' : 'Hide'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              duplicate.mutate(bot.id, {
                onSuccess: (copy) =>
                  void navigate({ to: '/bots/$botId', params: { botId: copy.id } }),
              })
            }
          >
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(bot)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
