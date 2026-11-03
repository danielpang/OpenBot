import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../app/api.js';
import { loadAuthMode } from '../app/deployment.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';
import { SetupWizard } from '../features/setup/setup-wizard.js';

// Shown only while setup is needed; afterwards /setup goes to the app. In the
// Mac app's local mode the app has signed the owner in already, so the
// wizard skips its account step. A server that makes its owner by pairing
// only (OPENBOTS_SETUP_PAIRING_ONLY, the standalone image) shows how to pair
// instead of the account form, which it would refuse.

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const { queryClient } = context;
    let pairingOnly = false;
    const required = await setupRequired(async () => {
      const setup = await queryClient.fetchQuery(setupQuery);
      pairingOnly = setup.pairingOnly === true;
      return setup;
    });
    if (!required) throw redirect({ to: '/' });
    if (pairingOnly) return { local: false, pairingOnly };
    const local = (await loadAuthMode(queryClient)) === 'local';
    if (local) {
      const signedIn = await queryClient.ensureQueryData(meQuery).then(
        () => true,
        () => false,
      );
      if (!signedIn) throw redirect({ to: '/sign-in' });
    }
    return { local, pairingOnly };
  },
  component: Setup,
});

function Setup() {
  const { local, pairingOnly } = Route.useRouteContext();
  if (pairingOnly) return <PairToSetUp />;
  return <SetupWizard skipAccount={local} />;
}

/** The owner of this server is made by pairing a phone: say how. */
export function PairToSetUp() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 px-4 py-16">
      <h1 className="text-xl font-semibold">Set up OpenBots from your phone</h1>
      <p className="text-sm text-muted-foreground">
        This server makes its owner by pairing a phone. On the server, run{' '}
        <code className="font-mono">openbots pair</code> and scan the code it prints with the
        OpenBots app. You can set an email and a password for the web from the app afterwards.
      </p>
    </main>
  );
}
