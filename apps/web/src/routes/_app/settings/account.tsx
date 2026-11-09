import { IconButton, LogOutIcon } from '@openbots/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { auth } from '../../../app/api.js';
import { NotificationSettings } from '../../../features/notifications/web-notifications.js';
import { ApiKeys } from '../../../features/settings/api-keys.js';

// The Mac app's local mode has no account: General takes this tab's place.

export const Route = createFileRoute('/_app/settings/account')({
  beforeLoad: ({ context }) => {
    if (context.localAuth) throw redirect({ to: '/settings/general' });
  },
  component: Account,
});

function Account() {
  const { me } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: auth.signOut,
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/sign-in' });
    },
  });

  return (
    <div className="flex flex-col gap-8">
      <section className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">{me.user.name}</p>
          <p className="text-sm text-muted-foreground">{me.user.email}</p>
        </div>
        <IconButton label="Sign out" busy={signOut.isPending} onClick={() => signOut.mutate()}>
          <LogOutIcon />
        </IconButton>
      </section>
      <NotificationSettings />
      <ApiKeys />
    </div>
  );
}
