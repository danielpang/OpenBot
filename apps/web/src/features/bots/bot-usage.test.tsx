import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BotUsageSection,
  botUsageQuery,
  formatCost,
  unpricedNote,
  USAGE_HELP,
  type BotUsage,
} from './bot-usage.js';

// The usage section of Bot Settings (plan 5.8), rendered with its query answered.

const BOT_ID = '00000000-0000-4000-8000-0000000000b1';

const sums = (over: Partial<BotUsage['totals']> = {}): BotUsage['totals'] => ({
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  steps: 0,
  costUsd: null,
  unpricedRuns: 0,
  ...over,
});

function render(usage: BotUsage) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(botUsageQuery(BOT_ID, 30).queryKey, usage);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <BotUsageSection botId={BOT_ID} />
    </QueryClientProvider>,
  )
    .replaceAll('<!-- -->', '')
    .replaceAll('&#x27;', "'");
}

describe('Bot Settings usage section', () => {
  it('shows the totals, the notes and a row per model', () => {
    const html = render({
      days: 30,
      since: '2026-09-30T00:00:00.000Z',
      totals: sums({
        runs: 3,
        inputTokens: 12_345,
        outputTokens: 678,
        cachedInputTokens: 2_000,
        steps: 4,
        costUsd: 0.4321,
        unpricedRuns: 1,
      }),
      daily: [],
      models: [
        { model: 'claude-x', ...sums({ runs: 2, inputTokens: 12_000, costUsd: 0.4321 }) },
        { model: 'local-llm', ...sums({ runs: 1, inputTokens: 345, unpricedRuns: 1 }) },
      ],
    });
    expect(html).toContain('<option value="30" selected="">Last 30 days</option>');
    expect(html).toContain('$0.43');
    expect(html).toContain('12,345');
    expect(html).toContain('2,000 input tokens were read from the cache.');
    expect(html).toContain(unpricedNote(1));
    expect(html).toContain('claude-x');
    expect(html).toMatch(/local-llm<\/td>.*No estimate/);
    expect(html).toContain(USAGE_HELP);
  });

  it('says so when the Bot had no runs', () => {
    const html = render({
      days: 30,
      since: '2026-09-30T00:00:00.000Z',
      totals: sums(),
      daily: [],
      models: [],
    });
    expect(html).toContain('No runs in the last 30 days.');
    expect(html).not.toContain('Estimated cost');
  });

  it('formats estimates and the unpriced note', () => {
    expect(formatCost(null)).toBe('No estimate');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('Under $0.01');
    expect(formatCost(12.5)).toBe('$12.50');
    expect(unpricedNote(3)).toBe('3 runs used unpriced models and are left out.');
  });
});
