import { describe, expect, it } from 'vitest';
import { contextWindow } from './summaries.js';

// Newest first, as the run worker reads them: the newest `window + 2 * batch`.
const newest = (last: number, window = 40, batch = 20, first = 1) =>
  Array.from({ length: Math.min(window + 2 * batch, last - first + 1) }, (_, i) => ({
    seq: last - i,
  }));
const seqs = (rows: { seq: number }[]) => rows.map((r) => r.seq);

describe('contextWindow', () => {
  it('reads a short chat whole, oldest first', () => {
    expect(seqs(contextWindow(newest(5), 40, 20, null))).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts after the summary, so the start holds until the summary is rewritten', () => {
    // Summarized through 20: each new message extends the same opening.
    const starts = [61, 62, 70, 79].map((last) => contextWindow(newest(last), 40, 20, 20)[0]!.seq);
    expect(starts).toEqual([21, 21, 21, 21]);
    // The next pass folds 21 to 40 in, and the window moves on with it.
    expect(contextWindow(newest(81), 40, 20, 40)[0]!.seq).toBe(41);
    expect(contextWindow(newest(81), 40, 20, 40)).toHaveLength(41);
  });

  it('holds the start for a batch at a time without a summary', () => {
    const starts = [60, 61, 79, 80, 99, 100].map(
      (last) => contextWindow(newest(last), 40, 20, null)[0]!.seq,
    );
    expect(starts).toEqual([20, 20, 40, 40, 60, 60]);
    for (const last of [60, 79, 80, 99]) {
      const rows = contextWindow(newest(last), 40, 20, null);
      expect(rows.length).toBeGreaterThanOrEqual(40);
      expect(rows.length).toBeLessThan(60);
    }
  });

  it('falls back when the summary has fallen behind what was read', () => {
    // 200 messages, summarized through 20: far more than a window since then.
    expect(contextWindow(newest(200), 40, 20, 20)[0]!.seq).toBe(160);
  });

  it('is exactly the last `window` with a batch of one', () => {
    const rows = contextWindow(newest(200, 40, 0).slice(0, 40), 40, 1, null);
    expect(seqs(rows)).toEqual(Array.from({ length: 40 }, (_, i) => 161 + i));
  });
});
