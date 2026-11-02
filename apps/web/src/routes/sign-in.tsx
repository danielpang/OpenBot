import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { auth, meQuery } from '../app/api.js';
import { loadAuthMode, loadDeployment } from '../app/deployment.js';
import { AuthCard, AuthForm, Field } from '../features/auth/auth-form.js';
import { LocalOnly } from '../features/auth/local-only.js';
import { authErrorMessage } from '../features/auth/messages.js';
import { OAuthButtons } from '../features/auth/oauth-buttons.js';
import { afterAuth, afterAuthUrl, signedIn } from '../features/auth/after-auth.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';

// A self-hosted install has one account, so there is no Sign up link;
// `?signup=closed` (from /sign-up) says why. An invite (`?invite=<id>`)
// goes on to /onboarding once signed in (plan 21.5).

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search): { error?: string; signup?: 'closed'; invite?: string } => ({
    error: typeof search.error === 'string' ? search.error : undefined,
    signup: search.signup === 'closed' ? 'closed' : undefined,
    invite: typeof search.invite === 'string' ? search.invite : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    if ((await loadAuthMode(context.queryClient)) === 'local') {
      // The Mac app signs the owner in: a signed-in window goes on to the app.
      const signedIn = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 }).then(
        () => true,
        () => false,
      );
      if (signedIn) throw redirect({ to: '/' });
      return { local: true as const, deployment: 'self_hosted' as const };
    }
    if (await setupRequired(() => context.queryClient.fetchQuery(setupQuery))) {
      throw redirect({ to: '/setup' });
    }
    // Signed in already: an invite goes on to be accepted.
    if (search.invite && (await signedIn(context.queryClient))) {
      throw redirect({ to: '/onboarding', search: { invite: search.invite } });
    }
    return { local: false as const, deployment: await loadDeployment(context.queryClient) };
  },
  component: SignInPage,
});

function SignInPage() {
  return Route.useRouteContext().local ? <LocalOnly /> : <SignIn />;
}

function SignIn() {
  const search = Route.useSearch();
  const { deployment } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [oauthError, setOAuthError] = useState<unknown>(search.error);
  async function enter() {
    queryClient.removeQueries({ queryKey: ['me'] });
    await navigate(afterAuth(search.invite));
  }
  const signIn = useMutation({ mutationFn: auth.signInEmail, onSuccess: enter });
  const error = signIn.error ?? oauthError;

  return (
    <AuthCard title="Sign in">
      {search.signup === 'closed' && deployment !== 'managed' && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          This OpenBots server has one account, its owner. Sign up is closed.
        </p>
      )}
      <AuthForm
        submitLabel="Sign in"
        pending={signIn.isPending}
        error={error ? authErrorMessage(error) : null}
        onSubmit={(form) =>
          signIn.mutate({
            email: String(form.get('email')),
            password: String(form.get('password')),
            callbackURL: afterAuthUrl(search.invite),
          })
        }
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </AuthForm>
      <OAuthButtons invite={search.invite} onError={setOAuthError} />
      {deployment === 'managed' && (
        <p className="text-center text-sm text-muted-foreground">
          No account?{' '}
          <Link
            to="/sign-up"
            search={search.invite ? { invite: search.invite } : {}}
            className="text-foreground underline underline-offset-4"
          >
            Sign up
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
