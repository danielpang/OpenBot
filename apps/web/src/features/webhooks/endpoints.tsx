import type { PolicyDecision, TriggerOverride, WebhookSignaturePreset } from '@openbots/shared';
import { Button, cn, Input } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Routine } from '../routines/api.js';
import { DECISION_LABELS, EDITED_GROUPS, GROUP_LABELS } from '../tools/policy.js';
import {
  endpointsQuery,
  useEndpointActions,
  type Endpoint,
  type IssuedEndpoint,
  type UpdateEndpoint,
} from './api.js';
import { DeliveryLog } from './delivery-log.js';

// The Bot's webhook endpoints (H1 to H5). The inbox (a POST becomes a
// message the Bot answers), which every Bot has, is in Bot Settings, as PRD
// section 5 places the Bot's webhook settings; each event Routine's endpoint
// is shown with its Routine in the Routines tab. Each shows its URL; the
// token and any signing secret OpenBots chose are shown once, when issued. An
// endpoint starts without a token and refuses deliveries until the owner
// generates one.
// The signing secret field is write-only (P3): it starts empty, says whether
// a secret is stored, and is sent only when the owner types a new one.

const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

export const PRESETS: { preset: WebhookSignaturePreset | ''; label: string }[] = [
  { preset: '', label: 'Token only' },
  { preset: 'github', label: 'GitHub signature' },
  { preset: 'slack', label: 'Slack signature' },
  { preset: 'stripe', label: 'Stripe signature' },
  { preset: 'generic', label: 'Generic HMAC' },
];

/** Presets whose secret the sender issues, so the owner must paste it. */
const PASTED: readonly string[] = ['slack', 'stripe'];

type EditedGroup = (typeof EDITED_GROUPS)[number];

/**
 * The choices for the endpoint's tool policy override (plan 4.7). It can
 * only make a run stricter than the Bot's own settings (the policy engine
 * ignores an `auto` in an override), so it offers Ask first and Never.
 */
const OVERRIDE_DECISIONS = ['ask', 'deny'] as const satisfies readonly PolicyDecision[];
type OverrideDecision = (typeof OVERRIDE_DECISIONS)[number] | '';

const overrideValue = (d: PolicyDecision | undefined): OverrideDecision =>
  d === 'ask' || d === 'deny' ? d : '';

/** What an issue (create, rotate, a new chosen secret) handed back, kept until dismissed. */
type Shown = Pick<IssuedEndpoint, 'token' | 'signingSecret'>;

/** The secrets issued to one endpoint, kept until the owner dismisses them. */
function useShown() {
  const [shown, setShown] = useState<Shown | null>(null);
  return {
    shown,
    show: (issued: IssuedEndpoint) => {
      if (!issued.token && !issued.signingSecret) return;
      setShown((s) => ({
        ...s,
        ...(issued.token ? { token: issued.token } : {}),
        ...(issued.signingSecret ? { signingSecret: issued.signingSecret } : {}),
      }));
    },
    dismiss: () => setShown(null),
  };
}

/** Bot Settings: the Bot's inbox (H1), where scripts and services message it. */
export function BotInbox({ botId }: { botId: string }) {
  const { data, error } = useQuery(endpointsQuery(botId));
  const { shown, show, dismiss } = useShown();
  const inbox = data?.find(isInbox);
  return (
    <div className="flex flex-col gap-3" aria-label="Webhook inbox" role="group">
      <p>Scripts can message this Bot here. It asks before changing anything.</p>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {inbox && (
        <ul className="flex flex-col gap-3 text-foreground">
          <EndpointCard
            botId={botId}
            endpoint={inbox}
            title="Inbox"
            shown={shown ?? undefined}
            onIssued={show}
            onDismiss={dismiss}
          />
        </ul>
      )}
    </div>
  );
}

/**
 * The endpoint an event Routine waits on (R2, H2), shown with the Routine. It
 * is made with the Routine; one deleted since can be added again.
 */
export function RoutineEndpoint({ botId, routine }: { botId: string; routine: Routine }) {
  const { data, error } = useQuery(endpointsQuery(botId));
  const actions = useEndpointActions(botId);
  const { shown, show, dismiss } = useShown();
  if (error) return <p className="text-xs text-destructive">{error.message}</p>;
  if (!data) return null;
  const endpoint = data.find((e) => e.routineId === routine.id);
  const source = routine.trigger.type === 'event' ? routine.trigger.source : 'webhook';
  return (
    <ul className="flex flex-col gap-2" aria-label={`${routine.name} endpoint`}>
      {endpoint ? (
        <EndpointCard
          botId={botId}
          endpoint={endpoint}
          title="Endpoint"
          shown={shown ?? undefined}
          onIssued={show}
          onDismiss={dismiss}
        />
      ) : (
        <Missing
          title="Endpoint"
          note="No endpoint yet, so nothing can start it."
          action="Add endpoint"
          pending={actions.create.isPending}
          onClick={() =>
            actions.create.mutate(
              {
                routineId: routine.id,
                // GitHub signs with a secret OpenBots issues; Slack's must be pasted first.
                ...(source === 'github' ? { signature: { preset: 'github' as const } } : {}),
              },
              { onSuccess: show },
            )
          }
        />
      )}
      {actions.create.error && (
        <p className="text-xs text-destructive">{actions.create.error.message}</p>
      )}
    </ul>
  );
}

function Missing({
  title,
  note,
  action,
  pending,
  onClick,
}: {
  title: string;
  note: string;
  action: string;
  pending: boolean;
  onClick(): void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm">
      <div className="flex flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      <Button size="sm" variant="outline" disabled={pending} onClick={onClick}>
        {action}
      </Button>
    </li>
  );
}

/** The Bot inbox (H1): no Routine, slug `inbox`. It can be turned off, not deleted. */
export const isInbox = (endpoint: Endpoint) => !endpoint.routineId && endpoint.slug === 'inbox';

export function ShownOnce({ label, value }: { label: string; value: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        readOnly
        value={value}
        aria-label={label}
        className="font-mono"
        onFocus={(e) => e.currentTarget.select()}
      />
    </label>
  );
}

export function EndpointCard({
  botId,
  endpoint,
  title,
  shown,
  onIssued,
  onDismiss,
}: {
  botId: string;
  endpoint: Endpoint;
  title: string;
  shown?: Shown;
  onIssued(issued: IssuedEndpoint): void;
  onDismiss(): void;
}) {
  const actions = useEndpointActions(botId);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const failure = [actions.rotate, actions.remove].find((m) => m.error)?.error;

  return (
    <li
      className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm"
      data-endpoint={endpoint.id}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('font-medium', !endpoint.enabled && 'text-muted-foreground')}>
            {title}
            {!endpoint.enabled && ' · Off'}
          </span>
          <code className="break-all text-xs">POST {endpoint.url}</code>
          <span className="text-xs text-muted-foreground">
            {endpoint.hasToken
              ? describeEndpoint(endpoint)
              : 'Generate a token to accept deliveries.'}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {endpoint.hasToken ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={actions.rotate.isPending}
              onClick={() => {
                if (
                  globalThis.confirm?.('Issue a new token? The current one stops working at once.')
                ) {
                  actions.rotate.mutate(endpoint.id, { onSuccess: onIssued });
                }
              }}
            >
              Rotate token
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={actions.rotate.isPending}
              onClick={() => actions.rotate.mutate(endpoint.id, { onSuccess: onIssued })}
            >
              Generate token
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close' : 'Settings'}
          </Button>
          {!isInbox(endpoint) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={actions.remove.isPending}
              onClick={() => {
                if (globalThis.confirm?.(`Delete the endpoint “${title}” and its delivery log?`)) {
                  actions.remove.mutate(endpoint.id);
                }
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      {shown && (
        <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3" data-shown-once>
          <p className="text-xs">Copy these now. They are shown only once.</p>
          {shown.token && <ShownOnce label="Token" value={shown.token} />}
          {shown.signingSecret && <ShownOnce label="Signing secret" value={shown.signingSecret} />}
          <p className="text-xs text-muted-foreground">
            Send the token as <code>Authorization: Bearer …</code>, as <code>X-OpenBots-Token</code>
            , or at the end of the URL.
          </p>
          <Button variant="ghost" size="sm" className="self-end" onClick={onDismiss}>
            Done
          </Button>
        </div>
      )}
      {failure && <p className="text-xs text-destructive">{failure.message}</p>}
      {editing && (
        <EndpointSettings
          endpoint={endpoint}
          pending={actions.update.isPending}
          error={actions.update.error}
          onSave={(body) =>
            actions.update.mutate(
              { id: endpoint.id, body },
              {
                onSuccess: (issued) => {
                  onIssued(issued);
                  setEditing(false);
                },
              },
            )
          }
          onCancel={() => setEditing(false)}
        />
      )}
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none text-xs text-muted-foreground">
          Deliveries
        </summary>
        {open && <DeliveryLog botId={botId} endpoint={endpoint} />}
      </details>
    </li>
  );
}

/** Verification, response mode and limits in words, under the URL. */
export function describeEndpoint(endpoint: Endpoint): string {
  const verification = endpoint.signature
    ? `${PRESETS.find((p) => p.preset === endpoint.signature!.preset)?.label ?? 'Signature'}${
        endpoint.signature.hasSecret ? '' : ' (no secret yet)'
      }`
    : 'Token only';
  const response =
    endpoint.responseMode === 'sync'
      ? `Waits up to ${endpoint.syncWaitS} s for the reply`
      : 'Answers at once';
  return [
    verification,
    response,
    endpoint.allowedIps.length ? `${endpoint.allowedIps.length} allowed IP ranges` : null,
    endpoint.rateLimitPerMin ? `${endpoint.rateLimitPerMin} per minute` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface EndpointForm {
  preset: WebhookSignaturePreset | '';
  header: string;
  /** Typed by the owner; empty keeps the stored secret. */
  secret: string;
  responseMode: Endpoint['responseMode'];
  syncTimeoutS: string;
  allowedIps: string;
  rateLimitPerMin: string;
  template: string;
  enabled: boolean;
  /** The override's `default`: every tool that can change something. */
  overrideDefault: OverrideDecision;
  overrideGroups: Record<EditedGroup, OverrideDecision>;
}

export function formFromEndpoint(endpoint: Endpoint): EndpointForm {
  return {
    preset: endpoint.signature?.preset ?? '',
    header: endpoint.signature?.header ?? '',
    secret: '',
    responseMode: endpoint.responseMode,
    syncTimeoutS: String(endpoint.syncTimeoutS ?? 60),
    allowedIps: endpoint.allowedIps.join('\n'),
    rateLimitPerMin: endpoint.rateLimitPerMin ? String(endpoint.rateLimitPerMin) : '',
    template: endpoint.template ?? '',
    enabled: endpoint.enabled,
    overrideDefault: overrideValue(endpoint.toolPolicyOverride?.default),
    overrideGroups: Object.fromEntries(
      EDITED_GROUPS.map((g) => [g, overrideValue(endpoint.toolPolicyOverride?.groups?.[g])]),
    ) as Record<EditedGroup, OverrideDecision>,
  };
}

/** JSON with object keys sorted, so two overrides compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/**
 * The stored override with the form's choices applied; the rest of it (per
 * tool settings, other groups, set through the API) is kept. Null when empty.
 */
export function overrideFromForm(
  stored: TriggerOverride | null,
  form: Pick<EndpointForm, 'overrideDefault' | 'overrideGroups'>,
): TriggerOverride | null {
  const { default: _default, groups: storedGroups, ...rest } = stored ?? {};
  const groups: NonNullable<TriggerOverride['groups']> = { ...storedGroups };
  for (const group of EDITED_GROUPS) {
    const decision = form.overrideGroups[group];
    if (decision) groups[group] = decision;
    else delete groups[group];
  }
  const override: TriggerOverride = {
    ...rest,
    ...(form.overrideDefault ? { default: form.overrideDefault } : {}),
    ...(Object.keys(groups).length ? { groups } : {}),
  };
  if (override.tools && !Object.keys(override.tools).length) delete override.tools;
  return Object.keys(override).length ? override : null;
}

export type PatchCheck = { ok: true; body: UpdateEndpoint } | { ok: false; error: string };

/**
 * The PATCH for a settings form. The signature goes only when it changed or
 * a new secret was typed: sending it again would make the server choose a
 * new secret (GitHub, generic) or refuse without one (Slack, Stripe).
 */
export function endpointPatch(endpoint: Endpoint, form: EndpointForm): PatchCheck {
  const body: UpdateEndpoint = {
    responseMode: form.responseMode,
    allowedIps: form.allowedIps
      .split(/[\s,]+/)
      .map((ip) => ip.trim())
      .filter(Boolean),
    rateLimitPerMin: form.rateLimitPerMin.trim() ? Number(form.rateLimitPerMin) : null,
    template: form.template.trim() ? form.template : null,
    enabled: form.enabled,
  };
  // Sent only when it changed, like the signature.
  const override = overrideFromForm(endpoint.toolPolicyOverride, form);
  if (canonical(override) !== canonical(endpoint.toolPolicyOverride)) {
    body.toolPolicyOverride = override;
  }
  if (form.responseMode === 'sync') {
    const timeout = Number(form.syncTimeoutS);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
      return { ok: false, error: 'Wait between 1 and 60 seconds.' };
    }
    body.syncTimeoutS = timeout;
  }
  if (
    body.rateLimitPerMin !== null &&
    !(Number.isInteger(body.rateLimitPerMin) && body.rateLimitPerMin! >= 1)
  ) {
    return { ok: false, error: 'The rate limit is a whole number of requests per minute.' };
  }
  const secret = form.secret.trim();
  const header = form.preset === 'generic' ? form.header.trim() : '';
  if (!form.preset) {
    if (endpoint.signature) body.signature = null;
  } else if (
    secret ||
    form.preset !== endpoint.signature?.preset ||
    header !== (endpoint.signature?.header ?? '')
  ) {
    if (PASTED.includes(form.preset) && !secret) {
      return { ok: false, error: 'Paste the signing secret the sender shows for this endpoint.' };
    }
    if (secret && secret.length < 8) {
      return { ok: false, error: 'The signing secret is at least 8 characters.' };
    }
    body.signature = {
      preset: form.preset,
      ...(header ? { header } : {}),
      ...(secret ? { secret } : {}),
    };
  }
  return { ok: true, body };
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>
        {label}
        {note && <span className="ml-2">({note})</span>}
      </span>
      {children}
    </label>
  );
}

export function EndpointSettings({
  endpoint,
  pending,
  error,
  onSave,
  onCancel,
}: {
  endpoint: Endpoint;
  pending: boolean;
  error: Error | null;
  onSave(body: UpdateEndpoint): void;
  onCancel(): void;
}) {
  const [form, setForm] = useState(() => formFromEndpoint(endpoint));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<EndpointForm>) => setForm((f) => ({ ...f, ...patch }));
  const stored = endpoint.signature?.preset === form.preset && endpoint.signature.hasSecret;

  function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const checked = endpointPatch(endpoint, form);
    if (!checked.ok) return setProblem(checked.error);
    onSave(checked.body);
    // Never keep a typed secret in the form once it has been sent.
    set({ secret: '' });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={submit}
      aria-label="Endpoint settings"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Verification">
          <select
            aria-label="Verification"
            value={form.preset}
            onChange={(e) => set({ preset: e.target.value as EndpointForm['preset'] })}
            className={selectClass}
          >
            {PRESETS.map((p) => (
              <option key={p.preset} value={p.preset}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        {form.preset === 'generic' && (
          <Field label="Signature header">
            <Input
              aria-label="Signature header"
              value={form.header}
              onChange={(e) => set({ header: e.target.value })}
              placeholder="X-Signature"
              className="w-44"
            />
          </Field>
        )}
        {form.preset && (
          <Field
            label="Signing secret"
            note={
              stored ? 'set' : PASTED.includes(form.preset) ? 'required' : 'blank to have one made'
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              aria-label="Signing secret"
              value={form.secret}
              onChange={(e) => set({ secret: e.target.value })}
              placeholder={stored ? 'Enter a new secret to replace it' : ''}
              className="w-64"
            />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Response">
          <select
            aria-label="Response"
            value={form.responseMode}
            onChange={(e) => set({ responseMode: e.target.value as EndpointForm['responseMode'] })}
            className={selectClass}
          >
            <option value="async">Answer at once (202 with the run id)</option>
            <option value="sync">Wait for the Bot’s reply</option>
          </select>
        </Field>
        {form.responseMode === 'sync' && (
          <Field label="Wait up to (seconds)">
            <Input
              type="number"
              min={1}
              max={60}
              aria-label="Wait up to (seconds)"
              value={form.syncTimeoutS}
              onChange={(e) => set({ syncTimeoutS: e.target.value })}
              className="w-24"
            />
          </Field>
        )}
        <Field label="Rate limit per minute" note="blank for the default">
          <Input
            type="number"
            min={1}
            aria-label="Rate limit per minute"
            value={form.rateLimitPerMin}
            onChange={(e) => set({ rateLimitPerMin: e.target.value })}
            className="w-28"
          />
        </Field>
      </div>
      <Field label="Allowed IP addresses or ranges" note="one per line; blank allows any">
        <textarea
          aria-label="Allowed IP addresses or ranges"
          value={form.allowedIps}
          onChange={(e) => set({ allowedIps: e.target.value })}
          rows={2}
          placeholder="192.30.252.0/22"
          className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
        />
      </Field>
      <Field label="Template" note="how the payload reads in the prompt; blank for the default">
        <textarea
          aria-label="Template"
          value={form.template}
          onChange={(e) => set({ template: e.target.value })}
          rows={2}
          placeholder="New order {{data.object.id}} for {{data.object.amount}}"
          className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <legend className="mb-1">
          Tools for runs it starts, never looser than the Bot&apos;s settings.
        </legend>
        <OverrideRow
          label="Tools that change something"
          value={form.overrideDefault}
          onChange={(overrideDefault) => set({ overrideDefault })}
        />
        {EDITED_GROUPS.map((group) => (
          <OverrideRow
            key={group}
            label={GROUP_LABELS[group]}
            value={form.overrideGroups[group]}
            onChange={(decision) =>
              set({ overrideGroups: { ...form.overrideGroups, [group]: decision } })
            }
          />
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Endpoint enabled"
          checked={form.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Accept deliveries
      </label>
      {(problem ?? error) && (
        <p className="text-sm text-destructive">{problem ?? error?.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** One override choice: the Bot's settings, Ask first or Never. */
function OverrideRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OverrideDecision;
  onChange(value: OverrideDecision): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-foreground">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as OverrideDecision)}
        className="h-8 rounded-md border bg-transparent px-2 text-xs text-foreground"
      >
        <option value="">Default: the Bot&apos;s settings</option>
        {OVERRIDE_DECISIONS.map((d) => (
          <option key={d} value={d}>
            {DECISION_LABELS[d]}
          </option>
        ))}
      </select>
    </div>
  );
}
