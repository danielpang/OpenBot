import { createFileRoute } from '@tanstack/react-router';
import { BotSettings } from '../../../../features/bots/bot-settings.js';

export const Route = createFileRoute('/_app/bots/$botId/settings')({
  component: Settings,
});

function Settings() {
  const { botId } = Route.useParams();
  return <BotSettings botId={botId} />;
}
