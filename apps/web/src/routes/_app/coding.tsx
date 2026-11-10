import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useRightPanel } from '../../app/right-panel.js';
import { CodingSessionsDrawer } from '../../features/coders/drawer/drawer-content.js';
import { useCodingSessionsLive } from '../../features/coders/drawer/live.js';

export const Route = createFileRoute('/_app/coding')({
  component: CodingSessionsPage,
});

function CodingSessionsPage() {
  const { close } = useRightPanel();
  useEffect(close, [close]);
  useCodingSessionsLive();
  return <CodingSessionsDrawer />;
}
