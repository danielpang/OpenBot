import { ApiError } from '@openbots/api-client';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../app/api.js';
import { loadAuthMode, loadDeployment } from '../app/deployment.js';
import { isActive } from '../app/extensions.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';
import { Shell } from '../app/shell.js';

// Every signed-in page sits under this pathless layout. It loads the caller
// and the install's deployment (self-hosted or managed), which decides
// whether anything about admins, members or the audit log shows, and its auth
// mode: with `local` the Mac app signs the owner in, so there is no account
// and the first-run wizard (providers, then a first Bot) shows until it is done.
// On the managed service someone with no active organization, or suspended
// in theirs, goes to /onboarding, which the managed build fills (plan 21.5);
// every page under here has one.

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    const { queryClient } = context;
    const authMode = await loadAuthMode(queryClient);
    try {
      const [me, deployment] = await Promise.all([
        queryClient.ensureQueryData(meQuery),
        loadDeployment(queryClient),
      ]);
      if (!isActive(me)) throw redirect({ to: '/onboarding' });
      if (authMode === 'local') {
        // Cached once: the wizard's last step clears it.
        const setup = await setupRequired(() => queryClient.ensureQueryData(setupQuery));
        if (setup) throw redirect({ to: '/setup' });
      }
      return { me, deployment, localAuth: authMode === 'local' };
    } catch (error) {
      // An account from before email verification (the managed service): signing in
      // again sends the link, so sign-in says so.
      if (error instanceof ApiError && error.code === 'EMAIL_NOT_VERIFIED') {
        throw redirect({ to: '/sign-in', search: { error: 'EMAIL_NOT_VERIFIED' } });
      }
      if (error instanceof ApiError && error.status === 401) {
        // The Mac app signs a local owner in again from /sign-in.
        if (authMode === 'local') throw redirect({ to: '/sign-in' });
        // A new install has nobody to sign in as: the first-run wizard creates the owner.
        const setup = await setupRequired(() => queryClient.fetchQuery(setupQuery));
        throw redirect({ to: setup ? '/setup' : '/sign-in' });
      }
      throw error;
    }
  },
  component: Shell,
});
