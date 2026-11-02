import { unwrap } from '@openbots/api-client';
import { Button, Input } from '@openbots/ui';
import { meQuery } from '@openbots/web/api';
import { isAdmin } from '@openbots/web/extensions';
import {
  LimitFields,
  limitsPatch,
  SaveRow,
  settingsQuery,
  useSaveSettings,
} from '@openbots/web/limits';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { orgApi, organizationsQuery, reloadInto } from './api.js';
import { CreateOrganizationForm } from './create-organization.js';

// Settings > Organization (plan 21.5): its name, and for owners and admins
// its limits and how long its audit log keeps rows, under the ceiling the
// service sets. Everyone may create another organization or leave this one;
// the last owner cannot leave.

export function OrganizationSettings() {
  const me = useQuery(meQuery);
  const admin = isAdmin(me.data?.role);
  return (
    <div className="flex flex-col gap-10">
      <NameSection admin={admin} />
      {admin && <LimitsSection />}
      <OtherOrganizations />
    </div>
  );
}

function NameSection({ admin }: { admin: boolean }) {
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (name: string) => unwrap(orgApi.PATCH('/api/v1/organization', { body: { name } })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: organizationsQuery.queryKey }),
      ]),
  });
  const name = me.data?.workspace?.name ?? '';
  if (!admin) {
    return (
      <section className="flex flex-col gap-1">
        <h2 className="font-medium">Organization</h2>
        <p className="text-sm">{name}</p>
      </section>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (next) rename.mutate(next);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Organization</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          Name
          <Input name="name" key={name} defaultValue={name} required maxLength={80} />
        </label>
        <Button type="submit" disabled={rename.isPending}>
          Save
        </Button>
      </form>
      {rename.error && <p className="text-sm text-destructive">{rename.error.message}</p>}
    </section>
  );
}

function LimitsSection() {
  const { data } = useQuery(settingsQuery);
  const save = useSaveSettings();
  if (!data) return null;
  const current = data.limits;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({
      limits: limitsPatch(form, current),
      auditRetentionDays: Number(form.get('auditRetentionDays')),
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Limits</h2>
      {data.ceilings && (
        <p className="text-sm text-muted-foreground">You can lower these, up to your plan.</p>
      )}
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <LimitFields limits={current} ceilings={data.ceilings} />
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Keep the audit log for (days)</span>
          <Input
            name="auditRetentionDays"
            type="number"
            min={30}
            max={3650}
            step={1}
            defaultValue={data.auditRetentionDays}
            required
            className="w-40"
          />
        </label>
        <SaveRow save={save} />
      </form>
    </section>
  );
}

function OtherOrganizations() {
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const leave = useMutation({
    mutationFn: () => unwrap(orgApi.POST('/api/v1/organization/leave')),
    onSuccess: () => reloadInto('/'),
  });
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">More</h2>
      {creating ? (
        <div className="max-w-sm">
          <CreateOrganizationForm submitLabel="Create organization" />
        </div>
      ) : (
        <Button variant="outline" className="self-start" onClick={() => setCreating(true)}>
          Create organization
        </Button>
      )}
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">Leave this organization? Your Bots here stay behind.</span>
          <Button variant="destructive" disabled={leave.isPending} onClick={() => leave.mutate()}>
            Leave
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="ghost" className="self-start" onClick={() => setConfirming(true)}>
          Leave organization
        </Button>
      )}
      {leave.error && <p className="text-sm text-destructive">{leave.error.message}</p>}
    </section>
  );
}
