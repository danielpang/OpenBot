import { createFileRoute, redirect } from '@tanstack/react-router';
import { NotificationSettings } from '../../../features/notifications/web-notifications.js';
import { ApiKeys } from '../../../features/settings/api-keys.js';
import { YourName } from '../../../features/settings/your-name.js';

// The first Settings tab in the Mac app's local mode, in place of Account:
// the app signs the owner in, so there is no email, password or sign out,
// only the name Bots use, notifications and API keys for scripts.

export const Route = createFileRoute('/_app/settings/general')({
  beforeLoad: ({ context }) => {
    if (!context.localAuth) throw redirect({ to: '/settings/account' });
  },
  component: General,
});

function General() {
  const { me } = Route.useRouteContext();
  return (
    <div className="flex flex-col gap-8">
      <YourName name={me.user.name} />
      <NotificationSettings />
      <ApiKeys />
    </div>
  );
}
