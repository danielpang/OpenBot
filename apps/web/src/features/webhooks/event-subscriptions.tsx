import { OutboundEventSchema, type OutboundEvent } from '@openbots/shared';
import {
  Button,
  cn,
  IconButton,
  Input,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateIcon,
  Switch,
  TrashIcon,
} from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { adminLabel, useManaged } from '../../app/deployment.js';
import { formatWhen } from '../routines/routines-tab.js';
import {
  eventDeliveriesQuery,
  subscriptionsQuery,
  useSubscriptionActions,
  type EventDelivery,
  type Subscription,
} from './api.js';
import { ShownOnce } from './endpoints.js';

// Settings > Events (H6): URLs that receive signed events from all of the
// owner's Bots, each with the events it wants, its delivery attempts and
// errors, and a signing secret shown once (on create and on rotation).
// Deliveries reach public addresses only (S-8); an admin (a self-hosted
// install's owner) can tick "Runs on my network" for a receiver on this
// machine or the LAN.

export const EVENT_WORDS: Record<OutboundEvent, string> = {
  'message.created': 'A Bot posted a message',
  'run.completed': 'A run completed',
  'run.failed': 'A run failed',
  'approval.requested': 'A Bot asks for approval',
  'routine.ran': 'A Routine ran',
  'artifact.created': 'A Bot created an Artifact',
};

const ALL_EVENTS = OutboundEventSchema.options;

const DELIVERY_WORDS: Record<EventDelivery['status'], string> = {
  pending: 'Retrying',
  delivered: 'Delivered',
  failed: 'Failed',
};

/** `admin` shows the "Runs on my network" choice, which only an admin may set (S-8). */
export function EventSubscriptions({ admin = false }: { admin?: boolean }) {
  const { data, error } = useQuery(subscriptionsQuery);
  const actions = useSubscriptionActions();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Send signed events from your Bots to another service.
        </p>
        {!adding && (
          <IconButton label="Add subscription" className="shrink-0" onClick={() => setAdding(true)}>
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {adding && (
        <SubscriptionForm
          admin={admin}
          pending={actions.create.isPending}
          error={actions.create.error}
          onSave={(body) =>
            actions.create.mutate(body, {
              onSuccess: (issued) => {
                if (issued.secret) setSecret({ id: issued.subscription.id, secret: issued.secret });
                setAdding(false);
              },
            })
          }
          onCancel={() => setAdding(false)}
        />
      )}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data && !data.length && !adding && (
        <p className="text-sm text-muted-foreground">No subscriptions.</p>
      )}
      {!!data?.length && (
        <ul className="divide-y rounded-md border">
          {data.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              admin={admin}
              subscription={subscription}
              secret={secret?.id === subscription.id ? secret.secret : undefined}
              onSecret={(value) => setSecret(value ? { id: subscription.id, secret: value } : null)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SubscriptionRow({
  admin,
  subscription,
  secret,
  onSecret,
}: {
  admin: boolean;
  subscription: Subscription;
  secret?: string;
  onSecret(secret: string | null): void;
}) {
  const actions = useSubscriptionActions();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const failure = [actions.update, actions.remove].find((m) => m.error)?.error;

  if (editing) {
    return (
      <li className="p-3">
        <SubscriptionForm
          admin={admin}
          subscription={subscription}
          pending={actions.update.isPending}
          error={actions.update.error}
          onSave={(body) =>
            actions.update.mutate(
              { id: subscription.id, body },
              { onSuccess: () => setEditing(false) },
            )
          }
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 text-sm" data-subscription={subscription.id}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'break-all font-medium',
              !subscription.enabled && 'text-muted-foreground',
            )}
          >
            {subscription.url}
            {!subscription.enabled && ' · Off'}
          </span>
          {subscription.local && (
            <span className="text-xs text-muted-foreground">Runs on my network</span>
          )}
          <span className="text-xs text-muted-foreground">
            {subscription.events.map((e) => EVENT_WORDS[e]).join(' · ')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={subscription.enabled ? 'Pause' : 'Resume'}
            disabled={actions.update.isPending}
            onClick={() =>
              actions.update.mutate({
                id: subscription.id,
                body: { enabled: !subscription.enabled },
              })
            }
          >
            {subscription.enabled ? <PauseIcon /> : <PlayIcon />}
          </IconButton>
          <IconButton label="Edit" onClick={() => setEditing(true)}>
            <PencilIcon />
          </IconButton>
          <IconButton
            label="Rotate secret"
            disabled={actions.update.isPending}
            onClick={() => {
              if (
                globalThis.confirm?.(
                  'Issue a new secret? The current one stops being used at once.',
                )
              ) {
                actions.update.mutate(
                  { id: subscription.id, body: { rotateSecret: true } },
                  { onSuccess: (issued) => issued.secret && onSecret(issued.secret) },
                );
              }
            }}
          >
            <RotateIcon />
          </IconButton>
          <IconButton
            label="Delete"
            busy={actions.remove.isPending}
            onClick={() => {
              if (globalThis.confirm?.(`Stop sending events to ${subscription.url}?`)) {
                actions.remove.mutate(subscription.id);
              }
            }}
          >
            <TrashIcon />
          </IconButton>
        </div>
      </div>
      {secret && (
        <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3" data-shown-once>
          <p className="text-xs">Copy this secret now. It is shown only once.</p>
          <ShownOnce label="Signing secret" value={secret} />
          <Button variant="ghost" size="sm" className="self-end" onClick={() => onSecret(null)}>
            Done
          </Button>
        </div>
      )}
      {failure && <p className="text-xs text-destructive">{failure.message}</p>}
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">
          Deliveries
        </summary>
        {open && <EventDeliveries subscriptionId={subscription.id} />}
      </details>
    </li>
  );
}

function EventDeliveries({ subscriptionId }: { subscriptionId: string }) {
  const { data, error } = useQuery(eventDeliveriesQuery(subscriptionId));
  if (error) return <p className="mt-1 text-xs text-destructive">{error.message}</p>;
  if (!data) return null;
  if (!data.length) return <p className="mt-1 text-xs text-muted-foreground">No deliveries yet.</p>;
  return (
    <ol className="mt-1 flex flex-col gap-1 border-l pl-3 text-xs">
      {data.map((delivery) => (
        <li key={delivery.id} className="flex flex-col" data-status={delivery.status}>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn(delivery.status === 'failed' && 'text-destructive')}>
              {DELIVERY_WORDS[delivery.status]}
            </span>
            <span className="text-muted-foreground">
              {[
                delivery.event,
                formatWhen(delivery.createdAt),
                `${delivery.attempts} ${delivery.attempts === 1 ? 'attempt' : 'attempts'}`,
                delivery.status === 'pending' && delivery.nextAttemptAt
                  ? `next ${formatWhen(delivery.nextAttemptAt)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {delivery.lastError && (
            <span className="text-muted-foreground">{delivery.lastError}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function SubscriptionForm({
  admin,
  subscription,
  pending,
  error,
  onSave,
  onCancel,
}: {
  admin: boolean;
  subscription?: Subscription;
  pending: boolean;
  error: Error | null;
  onSave(body: { url: string; events: OutboundEvent[]; local?: boolean }): void;
  onCancel(): void;
}) {
  const [url, setUrl] = useState(subscription?.url ?? '');
  const [events, setEvents] = useState<OutboundEvent[]>(subscription?.events ?? []);
  const [local, setLocal] = useState(subscription?.local ?? false);
  const [problem, setProblem] = useState<string | null>(null);
  const managed = useManaged();

  function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!events.length) return setProblem('Pick at least one event.');
    onSave({
      url: url.trim(),
      events: ALL_EVENTS.filter((ev) => events.includes(ev)),
      // Sent by admins only; the server refuses it from anyone else.
      ...(admin ? { local } : {}),
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={submit}
      aria-label={subscription ? 'Edit subscription' : 'New subscription'}
    >
      <Input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/openbots-events"
        aria-label="URL"
        required
      />
      {admin && (
        <label className="flex items-start gap-2 text-sm">
          <Switch
            name="local"
            checked={local}
            onChange={(e) => setLocal(e.currentTarget.checked)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Runs on my network</span>
            <span className="text-muted-foreground">
              {adminLabel(managed, 'allows a receiver on your machine or LAN, such as n8n.')}
            </span>
          </span>
        </label>
      )}
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">Events</legend>
        {ALL_EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={event}
              checked={events.includes(event)}
              onChange={(e) =>
                setEvents((current) =>
                  e.target.checked ? [...current, event] : current.filter((c) => c !== event),
                )
              }
            />
            {EVENT_WORDS[event]}
            <code className="text-xs text-muted-foreground">{event}</code>
          </label>
        ))}
      </fieldset>
      {(problem ?? error) && (
        <p className="text-sm text-destructive">{problem ?? error?.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {subscription ? 'Save' : 'Add subscription'}
        </Button>
      </div>
    </form>
  );
}
