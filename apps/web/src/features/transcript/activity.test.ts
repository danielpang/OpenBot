import { describe, expect, it } from 'vitest';
import { activityEntries, addStep, formatDuration, formatUsage, runDuration } from './activity.js';
import type { RunStep } from './api.js';

const step = (idx: number, over: Partial<RunStep>): RunStep => ({
  id: `s${idx}`,
  runId: 'r',
  idx,
  type: 'tool_call',
  label: '',
  tokensIn: null,
  tokensOut: null,
  durationMs: null,
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
});

describe('activity log', () => {
  it('lists steps in order with durations, letting model steps carry their own time', () => {
    const entries = activityEntries([
      step(2, { label: 'Edited math.ts +14 −10', durationMs: 42 }),
      step(0, { label: 'Environment ready', durationMs: 387 }),
      step(1, { type: 'llm', label: 'Thought briefly', durationMs: 1800 }),
      step(3, { label: 'Ran npm test: 212 passed', durationMs: 12_345 }),
      step(4, { type: 'steer', label: 'Steered: use vitest' }),
      step(5, { type: 'error', label: 'Rate limited' }),
    ]);
    expect(entries.map((e) => [e.label, e.duration])).toEqual([
      ['Environment ready', '387ms'],
      ['Thought briefly', null],
      ['Edited math.ts +14 −10', '42ms'],
      ['Ran npm test: 212 passed', '12s'],
      ['Steered: use vitest', null],
      ['Rate limited', null],
    ]);
    expect(entries.map((e) => e.error)).toEqual([false, false, false, false, false, true]);
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(387)).toBe('387ms');
    expect(formatDuration(2_400)).toBe('2.4s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(
      runDuration({
        startedAt: '2026-10-16T00:00:00.000Z',
        finishedAt: '2026-10-16T00:00:03.250Z',
      }),
    ).toBe('3.3s');
    expect(runDuration({ startedAt: null, finishedAt: null })).toBeNull();
  });

  it('adds live steps once, in idx order', () => {
    let list = addStep(undefined, step(1, { label: 'b' }));
    list = addStep(list, step(0, { label: 'a' }));
    list = addStep(list, step(1, { label: 'b' }));
    expect(list.map((s) => s.label)).toEqual(['a', 'b']);
  });

  it('formats the cost estimate, without token counts, or nothing without pricing', () => {
    const usage = { inputTokens: 1204, outputTokens: 318, cachedInputTokens: 0, steps: 2 };
    expect(formatUsage({ ...usage, costUsd: 0.0042 })).toBe('$0.0042');
    expect(formatUsage({ ...usage, costUsd: 1.5 })).toBe('$1.50');
    expect(formatUsage({ ...usage, cachedInputTokens: 900, costUsd: null })).toBeNull();
  });
});
