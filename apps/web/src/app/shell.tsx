import { cn } from '@openbots/ui';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebNotifications } from '../features/notifications/web-notifications.js';
import { RealtimeProvider } from '../features/transcript/realtime.js';
import { DesktopNavigation } from './platform.js';
import {
  clampPanelWidth,
  MIN_PANEL_WIDTH,
  PANEL_WIDTHS,
  RightPanelProvider,
  storedPanelWidth,
  storePanelWidth,
  useRightPanel,
} from './right-panel.js';
import { useOfficeShortcut } from './shortcuts.js';
import { Sidebar } from './sidebar.js';

// The signed-in frame (PRD section 5): sidebar, main area, right panel, and
// the one realtime connection everything under it shares, the browser
// notifications that listen on it, and the Mac app's deep links.
//
// The frame fills the window exactly and never lets the document scroll: only
// the panes do. Each pane is positioned, so an absolutely positioned element
// inside it (Radix's visually hidden inputs and labels) scrolls with the pane
// instead of stretching the document below the sidebar.

export function Shell() {
  const navigate = useNavigate();
  useOfficeShortcut(useCallback(() => void navigate({ to: '/' }), [navigate]));
  return (
    <RealtimeProvider>
      <WebNotifications />
      <DesktopNavigation />
      <RightPanelProvider>
        <div data-slot="shell" className="relative flex h-dvh overflow-hidden">
          <Sidebar />
          <main data-slot="content" className="relative min-w-0 flex-1 overflow-auto">
            <Outlet />
          </main>
          <RightPanelSlot />
        </div>
      </RightPanelProvider>
    </RealtimeProvider>
  );
}

function RightPanelSlot() {
  const { content, width: kind } = useRightPanel();
  const [width, setWidth] = useState(() => storedPanelWidth(kind));
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const viewport = () => (typeof window === 'undefined' ? Infinity : window.innerWidth);

  // Each kind of panel keeps its own width; keep it within the window as that resizes.
  useEffect(() => setWidth(storedPanelWidth(kind)), [kind]);
  useEffect(() => {
    const fit = () => setWidth((w) => clampPanelWidth(w, viewport()));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  if (!content) return null;
  const shown = clampPanelWidth(width, viewport());
  const resize = (next: number) => {
    const clamped = clampPanelWidth(next, viewport());
    setWidth(clamped);
    storePanelWidth(kind, clamped);
  };

  return (
    <aside
      data-slot="right-panel"
      data-width={kind}
      style={{ width: shown }}
      className={cn('relative shrink-0 border-l', dragging && 'select-none')}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={shown}
        aria-valuemin={MIN_PANEL_WIDTH}
        tabIndex={0}
        title="Drag to resize. Double click to reset."
        className={cn(
          'absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none',
          dragging && 'bg-ring/60',
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // No live pointer to capture (a synthetic event): the drag still works over the handle.
          }
          start.current = { x: event.clientX, width: shown };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!start.current) return;
          // The panel is on the right: dragging its edge left makes it wider.
          setWidth(
            clampPanelWidth(start.current.width + start.current.x - event.clientX, viewport()),
          );
        }}
        onPointerUp={() => {
          if (!start.current) return;
          start.current = null;
          setDragging(false);
          setWidth((w) => {
            storePanelWidth(kind, w);
            return w;
          });
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
        }}
        onDoubleClick={() => {
          storePanelWidth(kind, null);
          setWidth(PANEL_WIDTHS[kind]);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          if (event.key === 'ArrowLeft') resize(shown + step);
          else if (event.key === 'ArrowRight') resize(shown - step);
          else return;
          event.preventDefault();
        }}
      />
      {/* Positioned, so absolutely positioned elements inside scroll with the panel. */}
      <div className="relative h-full overflow-auto">{content}</div>
    </aside>
  );
}
