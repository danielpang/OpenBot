import { Button, XIcon } from '@openbots/ui';
import type { ReactNode } from 'react';

// The right panel's frame: a title, Close, and the panel's own scroll. On
// its own so a panel that only needs the frame (the coding sessions drawer,
// opened from the sidebar) does not load the artifact viewer, the screen
// preview and the thread with it.

export function PanelFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Button variant="ghost" size="icon" aria-label={`Close ${title}`} onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
