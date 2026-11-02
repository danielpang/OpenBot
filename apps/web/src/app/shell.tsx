import { Outlet } from '@tanstack/react-router';
import { WebNotifications } from '../features/notifications/web-notifications.js';
import { RealtimeProvider } from '../features/transcript/realtime.js';
import { DesktopNavigation } from './platform.js';
import { RightPanelProvider, useRightPanel } from './right-panel.js';
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
  return (
    <RealtimeProvider>
      <WebNotifications />
      <DesktopNavigation />
      <RightPanelProvider>
        <div data-slot="shell" className="relative flex h-dvh overflow-hidden">
          <Sidebar />
          <main className="relative min-w-0 flex-1 overflow-auto">
            <Outlet />
          </main>
          <RightPanelSlot />
        </div>
      </RightPanelProvider>
    </RealtimeProvider>
  );
}

function RightPanelSlot() {
  const { content } = useRightPanel();
  if (!content) return null;
  return <aside className="relative w-96 shrink-0 overflow-auto border-l">{content}</aside>;
}
