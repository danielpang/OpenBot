import { createFileRoute, redirect } from '@tanstack/react-router';
import { isAdmin } from '../../../app/extensions.js';
import { LimitsSettings } from '../../../features/settings/admin-settings.js';

// A self-hosted owner's limits. On the managed service each organization's
// are in its settings, which the managed build adds (plan 21.5).

export const Route = createFileRoute('/_app/settings/limits')({
  beforeLoad: ({ context }) => {
    if (context.deployment === 'managed' || !isAdmin(context.me.role)) {
      throw redirect({ to: '/settings' });
    }
  },
  component: LimitsSettings,
});
