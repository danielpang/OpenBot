import type { CodingSessionEntry } from '@openbots/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime } from '../../transcript/realtime.js';
import { codingSessionEvents } from '../api.js';

// A session's transcript in seq order (CA15): read page by page from the
// start, then grown by `coding_session.events`. Seqs run from 1 without
// holes, so whenever the entries held do not reach the highest seq seen
// (a batch missed while the socket was down, or one that came in during
// the first read) the hook reads on from the last unbroken seq. A status
// change reads on too: the server sends a session's entries before its
// status, so that catches a batch the socket dropped.

export interface SessionTranscript {
  entries: CodingSessionEntry[];
  loading: boolean;
  error: Error | null;
}

/** `held` with `incoming` merged in by seq, dropping seqs already held. */
export function mergeEntries(
  held: CodingSessionEntry[],
  incoming: readonly CodingSessionEntry[],
): CodingSessionEntry[] {
  const seen = new Set(held.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq) && seen.add(e.seq));
  if (fresh.length === 0) return held;
  return [...held, ...fresh].sort((a, b) => a.seq - b.seq);
}

/** The highest seq up to which every entry is held. */
export function unbrokenSeq(entries: readonly CodingSessionEntry[]): number {
  let seq = 0;
  for (const entry of entries) {
    if (entry.seq !== seq + 1) break;
    seq = entry.seq;
  }
  return seq;
}

export function useSessionTranscript(sessionId: string, status: string): SessionTranscript {
  const { client } = useRealtime();
  const [entries, setEntries] = useState<CodingSessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const held = useRef<CodingSessionEntry[]>([]);
  const reading = useRef(false);
  const again = useRef(false);

  const merge = useCallback((incoming: readonly CodingSessionEntry[]) => {
    held.current = mergeEntries(held.current, incoming);
    setEntries(held.current);
  }, []);

  const readOn = useCallback(async () => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        again.current = false;
        let hasMore = true;
        while (hasMore) {
          const page = await codingSessionEvents(sessionId, unbrokenSeq(held.current));
          merge(page.entries);
          hasMore = page.hasMore && page.entries.length > 0;
        }
      } while (again.current);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }, [sessionId, merge]);

  useEffect(() => {
    if (!client) return;
    return client.on('coding_session.events', (event) => {
      if (event.payload.sessionId !== sessionId) return;
      merge(event.payload.entries as CodingSessionEntry[]);
      const last = held.current.at(-1)?.seq ?? 0;
      if (unbrokenSeq(held.current) < last) void readOn();
    });
  }, [client, sessionId, merge, readOn]);

  useEffect(() => {
    void readOn();
  }, [readOn, status]);

  return { entries, loading, error };
}
