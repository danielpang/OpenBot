import { createFileRoute } from '@tanstack/react-router';
import { isAdmin } from '../../../app/extensions.js';
import { EventSubscriptions } from '../../../features/webhooks/event-subscriptions.js';

export const Route = createFileRoute('/_app/settings/events')({
  component: Events,
});

function Events() {
  const { me } = Route.useRouteContext();
  return <EventSubscriptions admin={isAdmin(me.role)} />;
}
