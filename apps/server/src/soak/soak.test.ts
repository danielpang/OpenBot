import { describe, expect, it } from 'vitest';
import { runSoak } from './soak.js';

// The soak harness on a few seconds instead of an hour, so CI keeps it
// working; `pnpm --filter @openbots/server soak` is the full run (plan 18.9).

describe('soak', () => {
  it('keeps twenty runs in flight across ten Bots in order, and leaks nothing', async () => {
    // Replies stream over a realistic stretch, so twenty runs can be in flight
    // at once on a real Postgres, where a run finishes in a few milliseconds.
    const report = await runSoak({
      durationMs: 4_000,
      seed: 7,
      decideDelayMs: 200,
      chunkDelayMs: 20,
    });

    expect(report.violations).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.peakInFlight).toBeGreaterThanOrEqual(20);
    expect(report.byTrigger.message).toBeGreaterThan(0);
    expect(report.byTrigger.routine).toBeGreaterThan(0);
    expect(report.byTrigger.webhook).toBeGreaterThan(0);
    expect(report.approvals).toBeGreaterThan(0);
    expect(report.byStatus.completed).toBe(report.runs);
  }, 60_000);
});
