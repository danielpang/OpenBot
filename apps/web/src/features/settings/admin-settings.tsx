import { unwrap, type components } from '@openbots/api-client';
import { Button, Input } from '@openbots/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { api, meQuery } from '../../app/api.js';
import { useLocalAuth } from '../../app/deployment.js';

// The limits (U3): a self-hosted owner's in Settings > Limits. On the
// managed service each organization's owners and admins change them, with
// the audit log's retention, in the settings the managed build adds (plan
// 21.5), which reuses the pieces below.

type Settings = components['schemas']['Settings'];
type Limits = Settings['limits'];

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => unwrap(api.GET('/api/v1/settings')),
});

export const LIMIT_LABELS: Record<keyof Limits, string> = {
  botsPerAccount: 'Bots per account',
  botsPerGroup: 'Bots per group',
  routinesPerBot: 'Routines per Bot',
  skillsPerAccount: 'Skills per account',
  runRecordsPerRoutine: 'Run records per Routine',
  webhookPayloadBytes: 'Webhook payload (bytes)',
  syncWebhookWaitSeconds: 'Sync webhook wait (seconds)',
  webhookIpRatePerMin: 'Webhook requests per address (a minute)',
  webhookFailedAuthPerMin: 'Failed webhook checks per address (a minute)',
  webhookEndpointRatePerMin: 'Webhook endpoint default rate (a minute)',
  uploadBytes: 'Upload size (bytes)',
};

/** In the Mac app's local mode there are no accounts to count per. */
const LOCAL_LIMIT_LABELS: Partial<Record<keyof Limits, string>> = {
  botsPerAccount: 'Bots',
  skillsPerAccount: 'Skills',
};

export function limitLabel(key: keyof Limits, localAuth: boolean): string {
  return (localAuth && LOCAL_LIMIT_LABELS[key]) || LIMIT_LABELS[key];
}

/**
 * The limits a submitted form changes. Only limits that differ from the
 * current ones are sent, so untouched limits keep following the env.
 */
export function limitsPatch(form: FormData, current: Limits): Partial<Limits> {
  const limits: Partial<Limits> = {};
  for (const key of Object.keys(LIMIT_LABELS) as (keyof Limits)[]) {
    const value = Number(form.get(key));
    if (value !== current[key]) limits[key] = value;
  }
  return limits;
}

type SettingsPatch = components['schemas']['SettingsPatch'];

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => unwrap(api.PATCH('/api/v1/settings', { body })),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsQuery.queryKey, settings);
      return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
}

/** The limit inputs; `ceilings` caps each (the managed service's, plan 21.6). */
export function LimitFields({ limits, ceilings }: { limits: Limits; ceilings?: Limits | null }) {
  const localAuth = useLocalAuth();
  return (
    <fieldset className="grid grid-cols-2 gap-4">
      <legend className="mb-2 text-sm font-medium">Limits</legend>
      {(Object.keys(LIMIT_LABELS) as (keyof Limits)[]).map((key) => (
        <label key={key} className="flex flex-col gap-1.5 text-sm">
          {limitLabel(key, localAuth)}
          <Input
            name={key}
            type="number"
            min={1}
            max={ceilings?.[key]}
            step={1}
            defaultValue={limits[key]}
            required
          />
        </label>
      ))}
    </fieldset>
  );
}

export function SaveRow({ save }: { save: ReturnType<typeof useSaveSettings> }) {
  return (
    <>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-muted-foreground">Saved</span>}
      </div>
    </>
  );
}

/** A self-hosted owner's limits: how many Bots, Routines and Skills, and upload and webhook caps. */
export function LimitsSettings() {
  const { data } = useQuery(settingsQuery);
  const save = useSaveSettings();
  if (!data) return null;
  const current = data.limits;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ limits: limitsPatch(new FormData(event.currentTarget), current) });
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <LimitFields limits={current} />
      <SaveRow save={save} />
    </form>
  );
}
