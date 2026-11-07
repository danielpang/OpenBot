import { unwrap, type components } from '@openbots/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../app/api.js';

// The usage section of Bot Settings (plan 5.8): tokens and the estimated
// cost of the Bot's runs over recent days, in total and by model. Usage
// stays out of the transcript (principle 10); this is where it shows.

/** Coding sessions in the window (CA10): their tokens, and how many billed the owner's plan. */
type BotCodingUsage = components['schemas']['BotCodingUsage'];

export type BotUsage = components['schemas']['BotUsage'];

export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const botUsageQuery = (botId: string, days: UsageWindow) =>
  queryOptions({
    queryKey: ['bot-usage', botId, days],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/bots/{id}/usage', {
          params: { path: { id: botId }, query: { days } },
        }),
      ),
  });

export const USAGE_HELP = "Estimated from each model's pricing, in US dollars.";

const count = new Intl.NumberFormat('en-US');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** An estimate as the section shows it; null means no run had pricing. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'No estimate';
  if (costUsd > 0 && costUsd < 0.01) return 'Under $0.01';
  return dollars.format(costUsd);
}

export function unpricedNote(runs: number): string {
  return runs === 1
    ? '1 run used an unpriced model and is left out.'
    : `${count.format(runs)} runs used unpriced models and are left out.`;
}

export function BotUsageSection({ botId }: { botId: string }) {
  const [days, setDays] = useState<UsageWindow>(30);
  const { data, error } = useQuery(botUsageQuery(botId, days));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 self-start">
        <span className="sr-only">Period</span>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.currentTarget.value) as UsageWindow)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
          {USAGE_WINDOWS.map((value) => (
            <option key={value} value={value}>
              Last {value} days
            </option>
          ))}
        </select>
      </label>
      {error && <p className="text-destructive">{error.message}</p>}
      {data && <UsageSummary usage={data} />}
      <p className="text-xs">{USAGE_HELP}</p>
    </div>
  );
}

/** "3 coding sessions, 12,000 in / 600 out tokens, $0.40". */
export function codingWords(coding: BotCodingUsage): string {
  const sessions =
    coding.sessions === 1 ? '1 coding session' : `${count.format(coding.sessions)} coding sessions`;
  const tokens = `${count.format(coding.inputTokens)} in / ${count.format(coding.outputTokens)} out tokens`;
  return coding.costUsd === null
    ? `${sessions}, ${tokens}`
    : `${sessions}, ${tokens}, ${formatCost(coding.costUsd)}`;
}

/** "2 sessions on your plan": their tokens are billed to the owner's subscription, not counted in dollars. */
export function onPlanWords(sessions: number): string {
  return sessions === 1
    ? '1 session on your plan'
    : `${count.format(sessions)} sessions on your plan`;
}

function CodingSummary({ coding }: { coding: BotCodingUsage }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2" data-coding-usage>
      <span className="text-xs">Coding agents</span>
      <span className="text-sm font-medium tabular-nums text-foreground">
        {codingWords(coding)}
      </span>
      {coding.onPlanSessions > 0 && (
        <span className="text-xs">{onPlanWords(coding.onPlanSessions)}</span>
      )}
    </div>
  );
}

export function UsageSummary({ usage }: { usage: BotUsage }) {
  const { totals, models } = usage;
  const coding = usage.coding?.sessions ? usage.coding : null;
  if (!totals.runs) {
    return (
      <>
        <p>No runs in the last {usage.days} days.</p>
        {coding && <CodingSummary coding={coding} />}
      </>
    );
  }
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Estimated cost" value={formatCost(totals.costUsd)} />
        <Stat label="Input tokens" value={count.format(totals.inputTokens)} />
        <Stat label="Output tokens" value={count.format(totals.outputTokens)} />
        <Stat label="Runs" value={count.format(totals.runs)} />
      </dl>
      {totals.cachedInputTokens > 0 && (
        <p className="text-xs">
          {count.format(totals.cachedInputTokens)} input tokens were read from the cache.
        </p>
      )}
      {totals.unpricedRuns > 0 && <p className="text-xs">{unpricedNote(totals.unpricedRuns)}</p>}
      {coding && <CodingSummary coding={coding} />}
      {models.length > 0 && (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Usage by model</caption>
          <thead>
            <tr className="border-b">
              <th className="py-1.5 font-medium">Model</th>
              <th className="py-1.5 text-right font-medium">Runs</th>
              <th className="py-1.5 text-right font-medium">Input tokens</th>
              <th className="py-1.5 text-right font-medium">Output tokens</th>
              <th className="py-1.5 text-right font-medium">Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => (
              <tr key={row.model ?? ''} className="border-b last:border-0">
                <td className="py-1.5 text-foreground">{row.model ?? 'Unknown model'}</td>
                <td className="py-1.5 text-right tabular-nums">{count.format(row.runs)}</td>
                <td className="py-1.5 text-right tabular-nums">{count.format(row.inputTokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{count.format(row.outputTokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCost(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
      <dt className="text-xs">{label}</dt>
      <dd className="text-base font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
