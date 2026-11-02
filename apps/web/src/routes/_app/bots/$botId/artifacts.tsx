import { createFileRoute } from '@tanstack/react-router';
import { ArtifactsTab } from '../../../../features/artifacts/artifacts-tab.js';

export const Route = createFileRoute('/_app/bots/$botId/artifacts')({
  component: Artifacts,
});

function Artifacts() {
  const { botId } = Route.useParams();
  return <ArtifactsTab botId={botId} />;
}
