import { createFileRoute } from '@tanstack/react-router';
import { BotView } from '../../../features/bots/bot-view.js';

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Bot,
});

function Bot() {
  const { botId } = Route.useParams();
  return <BotView botId={botId} />;
}
