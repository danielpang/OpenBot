import { createFileRoute } from '@tanstack/react-router';
import { MemoryTab } from '../../../../features/memory/memory-tab.js';

export const Route = createFileRoute('/_app/bots/$botId/memory')({
  component: Memory,
});

function Memory() {
  const { botId } = Route.useParams();
  return <MemoryTab botId={botId} />;
}
