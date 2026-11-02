import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: ({ context }) => {
    throw redirect({ to: context.localAuth ? '/settings/general' : '/settings/account' });
  },
});
