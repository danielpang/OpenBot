import { unwrap } from '@openbots/api-client';
import { Button, Input } from '@openbots/ui';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { orgApi, type AuditEntry as Entry } from './api.js';

// Settings > Audit log, for an organization's owners and admins (plan 17
// control 9, S-11, plan 21.5): who signed in, made keys and invites,
// changed members, settings, providers, connectors and webhooks, and drove
// the computer, in this organization. Newest first, filtered by action
// group, actor and day.

export interface AuditFilter {
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'All actions' },
  { value: 'auth.', label: 'Sign-in and sign-out' },
  { value: 'api_key.', label: 'API keys' },
  { value: 'organization.', label: 'Organization' },
  { value: 'invitation.', label: 'Invites' },
  { value: 'member.', label: 'Members' },
  { value: 'settings.', label: 'Settings' },
  { value: 'provider.', label: 'Model providers' },
  { value: 'connector.', label: 'Connectors' },
  { value: 'connector_policy.', label: 'Connector block list' },
  { value: 'webhook.', label: 'Webhooks' },
  { value: 'event_subscription.', label: 'Event subscriptions' },
  { value: 'computer.', label: 'Computer' },
  { value: 'approval.', label: 'Approvals' },
  { value: 'tool.', label: 'Refused tool calls' },
  { value: 'bot.', label: 'Bots' },
];

const auditQuery = (filter: AuditFilter) =>
  infiniteQueryOptions({
    queryKey: ['audit', filter],
    queryFn: ({ pageParam }) =>
      unwrap(
        orgApi.GET('/api/v1/organization/audit', {
          params: { query: { ...filter, ...(pageParam ? { cursor: pageParam } : {}), limit: 50 } },
        }),
      ),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/**
 * The query for a submitted filter form. Days are local: `from` is the start
 * of its day and `to` the end of its day.
 */
export function auditFilter(form: FormData): AuditFilter {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  const day = (name: string, end: boolean) => {
    const value = text(name);
    return value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : '';
  };
  const filter: AuditFilter = {
    action: text('action'),
    actorId: text('actorId'),
    from: day('from', false),
    to: day('to', true),
  };
  return Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) as AuditFilter;
}

/** Who did it, in words. */
export function describeActor(entry: Pick<Entry, 'actorType' | 'actorId' | 'actorLabel'>) {
  if (entry.actorType === 'system') return 'OpenBots';
  if (entry.actorLabel)
    return entry.actorType === 'bot' ? `Bot ${entry.actorLabel}` : entry.actorLabel;
  if (!entry.actorId) return 'Unknown';
  return `${entry.actorType === 'bot' ? 'Bot' : 'User'} ${entry.actorId.slice(0, 8)}`;
}

export function AuditLog() {
  const [filter, setFilter] = useState<AuditFilter>({});
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery(
    auditQuery(filter),
  );
  const entries = data?.pages.flatMap((page) => page.items) ?? [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilter(auditFilter(new FormData(event.currentTarget)));
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className="flex flex-col gap-1.5 text-sm">
          Action
          <select
            name="action"
            defaultValue=""
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {ACTION_GROUPS.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Actor id
          <Input name="actorId" key={filter.actorId ?? ''} defaultValue={filter.actorId} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          From
          <Input name="from" type="date" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          To
          <Input name="to" type="date" />
        </label>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data && !entries.length && (
        <p className="text-sm text-muted-foreground">Nothing recorded for these filters.</p>
      )}
      {!!entries.length && (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">When</th>
              <th className="py-1 pr-3 font-normal">Who</th>
              <th className="py-1 pr-3 font-normal">Action</th>
              <th className="py-1 font-normal">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t align-top" data-action={entry.action}>
                <td className="whitespace-nowrap py-1 pr-3">
                  {new Date(entry.createdAt).toLocaleString()}
                </td>
                <td className="py-1 pr-3">
                  {entry.actorId ? (
                    <button
                      type="button"
                      className="hover:underline"
                      title="Show only this actor"
                      onClick={() => setFilter({ ...filter, actorId: entry.actorId! })}
                    >
                      {describeActor(entry)}
                    </button>
                  ) : (
                    describeActor(entry)
                  )}
                </td>
                <td className="py-1 pr-3 font-mono text-xs">{entry.action}</td>
                <td className="break-all py-1 font-mono text-xs text-muted-foreground">
                  {[
                    entry.targetType && `${entry.targetType} ${entry.targetId?.slice(0, 8) ?? ''}`,
                    Object.keys(entry.metadata).length ? JSON.stringify(entry.metadata) : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
