import { ApiError } from '@openbots/api-client';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../app/api.js';
import { isActive, webExtensions } from '../app/extensions.js';
import { AuthCard } from '../features/auth/auth-form.js';

// Where someone signed in lands without an active organization (none yet, or
// suspended in theirs), and where an invite (`?invite=<id>`) arrives after
// sign-in or sign-up. The managed build fills it (plan 21.5): create an
// organization, accept the invite, or pick another. A self-hosted install
// always has one, so nobody stays here.

export const Route = createFileRoute('/onboarding')({
  validateSearch: (search): { invite?: string } => ({
    invite: typeof search.invite === 'string' ? search.invite : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    try {
      const me = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      if (isActive(me) && !search.invite) throw redirect({ to: '/' });
      return { me };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: '/sign-in', search: search.invite ? { invite: search.invite } : {} });
      }
      throw error;
    }
  },
  component: Onboarding,
});

function Onboarding() {
  const { me } = Route.useRouteContext();
  const { invite } = Route.useSearch();
  const Extension = webExtensions().Onboarding;
  if (Extension) return <Extension me={me} invite={invite} />;
  return (
    <AuthCard title="No workspace">
      <p className="text-center text-sm text-muted-foreground">
        This account is not part of a workspace yet.
      </p>
    </AuthCard>
  );
}
