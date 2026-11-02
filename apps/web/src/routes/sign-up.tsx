import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { meQuery } from '../app/api.js';
import { loadAuthMode, loadDeployment } from '../app/deployment.js';
import { EmailSignUp } from '../features/auth/email-sign-up.js';
import { LocalOnly } from '../features/auth/local-only.js';
import { OAuthButtons } from '../features/auth/oauth-buttons.js';
import { afterAuth, signedIn } from '../features/auth/after-auth.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';

// An invite link is /sign-up?invite=<id>. Signing up is for the managed
// service: a self-hosted install has one account, made by the setup wizard,
// so this page sends visitors to sign in, which says why. Someone who
// arrives with an invite goes on to /onboarding with it once they have an
// account, where the managed build accepts it (plan 21.5); without one, a
// new account goes there to create its organization. The email comes
// first, confirmed with a code, then the name and password (plan 21.6); the
// invite goes with every step.

export const Route = createFileRoute('/sign-up')({
  validateSearch: (search): { invite?: string; error?: string } => ({
    invite: typeof search.invite === 'string' ? search.invite : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    if ((await loadAuthMode(context.queryClient)) === 'local') {
      // The Mac app signs the owner in: a signed-in window goes on to the app.
      const signedIn = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 }).then(
        () => true,
        () => false,
      );
      if (signedIn) throw redirect({ to: '/' });
      return { local: true as const };
    }
    if (await setupRequired(() => context.queryClient.fetchQuery(setupQuery))) {
      throw redirect({ to: '/setup' });
    }
    if ((await loadDeployment(context.queryClient)) !== 'managed') {
      throw redirect({ to: '/sign-in', search: { signup: 'closed' } });
    }
    // Signed in already: an invite goes on to be accepted.
    if (search.invite && (await signedIn(context.queryClient))) {
      throw redirect({ to: '/onboarding', search: { invite: search.invite } });
    }
    return { local: false as const };
  },
  component: SignUpPage,
});

function SignUpPage() {
  return Route.useRouteContext().local ? <LocalOnly /> : <SignUp />;
}

function SignUp() {
  const { invite, error: callbackError } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [oauthError, setOAuthError] = useState<unknown>(callbackError);

  async function enter() {
    queryClient.removeQueries({ queryKey: ['me'] });
    await navigate(afterAuth(invite));
  }

  return (
    <EmailSignUp
      invite={invite}
      error={oauthError}
      onSignedIn={enter}
      footer={
        <>
          <OAuthButtons invite={invite} onError={setOAuthError} />
          <p className="text-center text-sm text-muted-foreground">
            Have an account?{' '}
            <Link
              to="/sign-in"
              search={invite ? { invite } : {}}
              className="text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>
          </p>
        </>
      }
    />
  );
}
