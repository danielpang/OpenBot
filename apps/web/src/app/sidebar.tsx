import {
  Button,
  cn,
  PlusIcon,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@openbots/ui';
import { Link } from '@tanstack/react-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Roster } from '../features/bots/roster.js';
import { ConnectionIndicator } from './connection-indicator.js';
import { NAV_LINKS } from './nav.js';
import { webExtensions } from './extensions.js';
import { NewDialog } from './new-dialog.js';
import { platform as appPlatform, hasInsetTitleBar, WINDOW_DRAG } from './platform.js';
import { newShortcutLabel, useNewShortcut } from './shortcuts.js';

export function Sidebar() {
  // The managed build's organization switcher (plan 21.5).
  const { SidebarHeader } = webExtensions();
  const [newOpen, setNewOpen] = useState(false);
  const openNew = useCallback(() => setNewOpen(true), []);
  useNewShortcut(openNew);
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const shortcut = newShortcutLabel(platform, appPlatform().kind === 'desktop');

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
      <TitleBarInset />
      {SidebarHeader && <SidebarHeader />}
      <div className="p-3">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" className="w-full justify-start" onClick={openNew}>
                <PlusIcon />
                New
                <kbd className="ml-auto font-sans text-xs text-muted-foreground">{shortcut}</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Create a Bot or start a group ({shortcut})</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Roster />
      </ScrollArea>
      <div className="flex flex-col gap-0.5 border-t p-2">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className="rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            activeProps={{ className: 'bg-accent font-medium' }}
          >
            {link.label}
          </Link>
        ))}
        <ConnectionIndicator />
      </div>
      <NewDialog open={newOpen} onOpenChange={setNewOpen} />
    </nav>
  );
}

/**
 * In the Mac app, room above New for the traffic lights, which the window
 * draws over the page's top left, and a handle to drag the window by. Nothing
 * in a browser.
 */
export function TitleBarInset() {
  if (!hasInsetTitleBar()) return null;
  return (
    <div aria-hidden data-slot="title-bar-inset" className={cn('h-8 shrink-0', WINDOW_DRAG)} />
  );
}

export function SidebarSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children?: ReactNode;
}) {
  return (
    <section className="px-3 pb-3">
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h2>
      {children ?? <p className="px-2 text-sm text-muted-foreground">{empty}</p>}
    </section>
  );
}
