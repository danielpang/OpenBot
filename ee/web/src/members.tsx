import { unwrap } from '@openbots/api-client';
import { Button, Input } from '@openbots/ui';
import { meQuery } from '@openbots/web/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  invitationsQuery,
  membersQuery,
  orgApi,
  type Invitation,
  type Member,
  type Role,
} from './api.js';

// Settings > Members, for owners and admins (plan 21.5): invite by email
// (the link is emailed when the server can send email, and can always be
// copied), pending invites with Copy link and Revoke, and members with
// their role, Suspend or Restore, and Remove. Only owners see Owner as a
// choice; the server keeps the rest of the rules (the last owner stays).

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** The roles the caller may give. */
export function assignableRoles(callerRole: Role | null | undefined): Role[] {
  return callerRole === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

export function MembersSettings() {
  return (
    <div className="flex flex-col gap-8">
      <InviteForm />
      <PendingInvites />
      <Members />
    </div>
  );
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(text);
      } catch {
        // No clipboard access: the field is selectable.
      }
    },
  };
}

function InviteForm() {
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const { copied, copy } = useCopy();
  const create = useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      unwrap(orgApi.POST('/api/v1/organization/invitations', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsQuery.queryKey }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    create.mutate(
      { email: String(data.get('email') ?? '').trim(), role: data.get('role') as Role },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Invite</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          Email
          <Input name="email" type="email" required aria-label="Invite email" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Role
          <select
            name="role"
            defaultValue="member"
            aria-label="Invite role"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {assignableRoles(me.data?.role).map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={create.isPending}>
          Invite
        </Button>
      </form>
      {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
      {create.data && (
        <div className="flex flex-col gap-1.5 rounded-md border p-3 text-sm">
          <p>
            {create.data.emailed
              ? `We emailed ${create.data.email}. You can also send the link.`
              : `Send ${create.data.email} this link. It works for 7 days.`}
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={create.data.link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={() => void copy(create.data.link)}>
              {copied === create.data.link ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PendingInvites() {
  const { data } = useQuery(invitationsQuery);
  const queryClient = useQueryClient();
  const { copied, copy } = useCopy();
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(orgApi.DELETE('/api/v1/organization/invitations/{id}', { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsQuery.queryKey }),
  });
  if (!data?.items.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Pending invites</h2>
      <ul className="flex flex-col divide-y rounded-md border">
        {data.items.map((invite: Invitation) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{invite.email}</span>
            <span className="text-muted-foreground">
              {ROLE_LABELS[invite.role]}, expires {day(invite.expiresAt)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void copy(invite.link)}>
              {copied === invite.link ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(invite.id)}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {revoke.error && <p className="text-sm text-destructive">{revoke.error.message}</p>}
    </section>
  );
}

function Members() {
  const me = useQuery(meQuery);
  const { data } = useQuery(membersQuery);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: Role; suspended?: boolean }) =>
      unwrap(orgApi.PATCH('/api/v1/organization/members/{id}', { params: { path: { id } }, body })),
    onSuccess: async () => {
      await refresh();
      // The caller's own role may have changed.
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(orgApi.DELETE('/api/v1/organization/members/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
  if (!data) return null;
  const error = update.error ?? remove.error;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Members</h2>
      <ul className="flex flex-col divide-y rounded-md border">
        {data.items.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            self={member.id === me.data?.user.id}
            callerRole={me.data?.role ?? null}
            pending={update.isPending || remove.isPending}
            onChange={(change) => update.mutate({ id: member.id, ...change })}
            onRemove={() => remove.mutate(member.id)}
          />
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
    </section>
  );
}

export function MemberRow({
  member,
  self,
  callerRole,
  pending,
  onChange,
  onRemove,
}: {
  member: Member;
  self: boolean;
  callerRole: Role | null;
  pending: boolean;
  onChange(change: { role?: Role; suspended?: boolean }): void;
  onRemove(): void;
}) {
  const [removing, setRemoving] = useState(false);
  // Only an owner changes an owner.
  const locked = member.role === 'owner' && callerRole !== 'owner';
  const roles = assignableRoles(callerRole);
  return (
    <li className="flex flex-wrap items-center gap-3 p-3 text-sm" data-member={member.email}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {member.name}
          {self && <span className="text-muted-foreground"> (you)</span>}
        </span>
        <span className="truncate text-muted-foreground">{member.email}</span>
      </span>
      {member.suspendedAt && <span className="text-muted-foreground">Suspended</span>}
      <select
        value={member.role}
        aria-label={`Role of ${member.email}`}
        disabled={locked || pending}
        onChange={(e) => onChange({ role: e.currentTarget.value as Role })}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      >
        {(roles.includes(member.role) ? roles : [...roles, member.role]).map((role) => (
          <option key={role} value={role}>
            {ROLE_LABELS[role]}
          </option>
        ))}
      </select>
      {!self && !locked && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onChange({ suspended: !member.suspendedAt })}
          >
            {member.suspendedAt ? 'Restore' : 'Suspend'}
          </Button>
          {removing ? (
            <>
              <Button size="sm" variant="destructive" disabled={pending} onClick={onRemove}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          )}
        </>
      )}
    </li>
  );
}
