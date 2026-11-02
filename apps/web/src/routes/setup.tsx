import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../app/api.js';
import { loadAuthMode } from '../app/deployment.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';
import { SetupWizard } from '../features/setup/setup-wizard.js';

// Shown only while setup is needed; afterwards /setup goes to the app. In the
// Mac app's local mode the app has signed the owner in already, so the
// wizard skips its account step.

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const { queryClient } = context;
    if (!(await setupRequired(() => queryClient.fetchQuery(setupQuery)))) {
      throw redirect({ to: '/' });
    }
    const local = (await loadAuthMode(queryClient)) === 'local';
    if (local) {
      const signedIn = await queryClient.ensureQueryData(meQuery).then(
        () => true,
        () => false,
      );
      if (!signedIn) throw redirect({ to: '/sign-in' });
    }
    return { local };
  },
  component: Setup,
});

function Setup() {
  const { local } = Route.useRouteContext();
  return <SetupWizard skipAccount={local} />;
}
