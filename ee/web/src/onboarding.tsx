import { ApiError } from '@openbots/api-client';
import { Button } from '@openbots/ui';
import { AuthCard } from '@openbots/web/auth-form';
import type { Me } from '@openbots/web/extensions';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  acceptInvitation,
  activateOrganization,
  invitationQuery,
  organizationsQuery,
  reloadInto,
} from './api.js';
import { CreateOrganizationForm } from './create-organization.js';

// /onboarding on the managed service (plan 21.5). With an invite: join its
// organization, no other step. Without one: someone with no organization
// creates theirs (one step, its name) and becomes its owner; someone
// suspended in theirs, or removed from it, picks another or creates one.

export function Onboarding({ me, invite }: { me: Me; invite?: string }) {
  if (invite) return <JoinInvite id={invite} me={me} />;
  return <NoOrganization me={me} />;
}

function JoinInvite({ id, me }: { id: string; me: Me }) {
  const invitation = useQuery(invitationQuery(id));
  const join = useMutation({
    mutationFn: () => acceptInvitation(id),
    onSuccess: () => reloadInto('/'),
  });
  if (invitation.isPending) return null;
  if (invitation.error) {
    const gone = invitation.error instanceof ApiError && invitation.error.status === 404;
    return (
      <AuthCard title="Invite not found">
        <p className="text-center text-sm text-muted-foreground">
          {gone
            ? `This invite was used, expired, or is for another email than ${me.user.email}.`
            : invitation.error.message}
        </p>
        <Button variant="outline" onClick={() => reloadInto('/onboarding')}>
          Continue
        </Button>
      </AuthCard>
    );
  }
  const { organization, role, invitedBy } = invitation.data;
  return (
    <AuthCard title={`Join ${organization}`}>
      <p className="text-center text-sm text-muted-foreground">
        {invitedBy ? `${invitedBy} invited you` : 'You are invited'} as{' '}
        {role === 'member' ? 'a member' : `an ${role}`}.
      </p>
      {join.error && <p className="text-sm text-destructive">{join.error.message}</p>}
      <Button onClick={() => join.mutate()} disabled={join.isPending}>
        Join
      </Button>
    </AuthCard>
  );
}

function NoOrganization({ me }: { me: Me }) {
  const organizations = useQuery(organizationsQuery);
  const open = useMutation({ mutationFn: activateOrganization, onSuccess: () => reloadInto('/') });
  const others = (organizations.data?.items ?? []).filter((o) => !o.suspended);
  const suspendedIn = me.workspace?.suspended ? me.workspace.name : null;

  return (
    <AuthCard title={others.length ? 'Pick an organization' : 'Create your organization'}>
      {suspendedIn && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          You are suspended in {suspendedIn}.
        </p>
      )}
      {others.length > 0 && (
        <ul className="flex flex-col gap-2">
          {others.map((org) => (
            <li key={org.id}>
              <Button
                variant="outline"
                className="w-full justify-start"
                disabled={open.isPending}
                onClick={() => open.mutate(org.id)}
              >
                {org.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open.error && <p className="text-sm text-destructive">{open.error.message}</p>}
      {others.length > 0 && (
        <p className="text-center text-sm text-muted-foreground">Or create a new one.</p>
      )}
      <CreateOrganizationForm />
    </AuthCard>
  );
}
