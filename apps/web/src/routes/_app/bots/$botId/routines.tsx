import { createFileRoute } from '@tanstack/react-router';
import { RoutinesTab } from '../../../../features/routines/routines-tab.js';

export const Route = createFileRoute('/_app/bots/$botId/routines')({
  component: Routines,
});

function Routines() {
  const { botId } = Route.useParams();
  return <RoutinesTab botId={botId} />;
}
