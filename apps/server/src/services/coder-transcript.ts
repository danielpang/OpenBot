import {
  SESSION_EVENT_TEXT_MAX,
  SESSION_EVENTS_MAX,
  wsEvent,
  type CoderTranscriptEvent,
  type CodingSessionEntry,
} from '@openbots/shared';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { publishEvent } from '../infra/index.js';

// A coding session's transcript (CA15): the prompts it was given and the
// agent's events, kept in `coding_session_events` for the drawer's chat.
// Entries are numbered per session (`seq` from 1) and by prompt (`turn`: a
// prompt starts the next one). Writes for one session run one after another
// and hold a lock on the session, so the API's prompt and a runner's events
// never take the same `seq`. New entries go to the owner as
// `coding_session.events`, at most once every TRANSCRIPT_FLUSH_MS;
// coder-state.ts flushes them before it publishes a change to the session,
// so a client reads the entries before the status they led to.
//
// The callers pass what the runner already scrubbed of the provider key; a
// permission prompt's `input` is never kept.

type TranscriptDeps = Pick<AppDeps, 'db' | 'infra' | 'logger'>;

/** At most one `coding_session.events` per session this often. */
export const TRANSCRIPT_FLUSH_MS = 500;

/** The last entry a full transcript gets. */
export const TRANSCRIPT_FULL = 'The transcript reached 5,000 entries; the rest is in the log';

interface Slot {
  owner: { ownerId: string; workspaceId: string } | null;
  unsent: CodingSessionEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  chain: Promise<unknown>;
  queued: number;
}
const slots = new Map<string, Slot>();

function slot(sessionId: string): Slot {
  let found = slots.get(sessionId);
  if (!found) {
    found = {
      owner: null,
      unsent: [],
      timer: null,
      lastFlush: 0,
      chain: Promise.resolve(),
      queued: 0,
    };
    slots.set(sessionId, found);
  }
  return found;
}

function serial<T>(sessionId: string, fn: (s: Slot) => Promise<T>): Promise<T> {
  const s = slot(sessionId);
  s.queued++;
  const run = () => fn(s);
  const next = s.chain.then(run, run).finally(() => {
    s.queued--;
    if (!s.queued && !s.unsent.length && !s.timer && slots.get(sessionId) === s) {
      slots.delete(sessionId);
    }
  });
  s.chain = next.catch(() => {});
  return next;
}

const clipText = (text: string) =>
  text.length > SESSION_EVENT_TEXT_MAX ? `${text.slice(0, SESSION_EVENT_TEXT_MAX - 1)}…` : text;

/** The event as it is kept: every string clipped, a prompt's `input` dropped. */
export function keptEvent(event: CoderTranscriptEvent): CoderTranscriptEvent {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'input') continue;
    kept[key] = typeof value === 'string' ? clipText(value) : value;
  }
  return kept as CoderTranscriptEvent;
}

type EntryRow = typeof schema.codingSessionEvents.$inferSelect;

const toEntry = (row: EntryRow): CodingSessionEntry => ({
  seq: row.seq,
  turn: row.turn,
  at: row.at.toISOString(),
  event: row.event,
});

async function sessionOwner(deps: TranscriptDeps, s: Slot, sessionId: string) {
  if (s.owner) return s.owner;
  const [row] = await deps.db
    .select({
      ownerId: schema.codingSessions.ownerId,
      workspaceId: schema.codingSessions.workspaceId,
    })
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId));
  s.owner = row ?? null;
  return s.owner;
}

async function append(
  deps: TranscriptDeps,
  s: Slot,
  sessionId: string,
  event: CoderTranscriptEvent,
): Promise<CodingSessionEntry | null> {
  const owner = await sessionOwner(deps, s, sessionId);
  if (!owner) return null;
  const row = await inWorkspace(owner.workspaceId, () =>
    deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`coder-transcript:${sessionId}`}))`,
      );
      const [last] = await tx
        .select({ seq: schema.codingSessionEvents.seq, turn: schema.codingSessionEvents.turn })
        .from(schema.codingSessionEvents)
        .where(eq(schema.codingSessionEvents.sessionId, sessionId))
        .orderBy(desc(schema.codingSessionEvents.seq))
        .limit(1);
      const seq = (last?.seq ?? 0) + 1;
      if (seq > SESSION_EVENTS_MAX) return null;
      const kept: CoderTranscriptEvent =
        seq === SESSION_EVENTS_MAX ? { type: 'error', message: TRANSCRIPT_FULL } : keptEvent(event);
      const turn = kept.type === 'prompt' ? (last?.turn ?? 0) + 1 : (last?.turn ?? 1);
      const [inserted] = await tx
        .insert(schema.codingSessionEvents)
        .values({
          workspaceId: owner.workspaceId,
          sessionId,
          seq,
          turn,
          at: new Date(),
          event: kept,
        })
        .returning();
      return inserted ?? null;
    }),
  );
  if (!row) return null;
  const entry = toEntry(row);
  s.unsent.push(entry);
  schedule(deps, s, sessionId);
  return entry;
}

function schedule(deps: TranscriptDeps, s: Slot, sessionId: string) {
  if (s.timer) return;
  const wait = Math.max(0, TRANSCRIPT_FLUSH_MS - (Date.now() - s.lastFlush));
  s.timer = setTimeout(() => {
    s.timer = null;
    flushTranscript(deps, sessionId).catch((error: unknown) =>
      deps.logger.warn({ err: error, sessionId }, 'coding session transcript not published'),
    );
  }, wait);
  s.timer.unref?.();
}

async function publish(deps: TranscriptDeps, s: Slot, sessionId: string) {
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.lastFlush = Date.now();
  const entries = s.unsent.splice(0);
  if (!entries.length || !s.owner) return;
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'coding_session.events',
      { sessionId, entries },
      { user_id: s.owner.ownerId, workspace_id: s.owner.workspaceId },
    ),
  );
}

/**
 * Adds an entry to the session's transcript and resolves with it once it is
 * written (null when the session is gone or its transcript is full). It is
 * published with the next flush. A failure is logged, never thrown: the
 * transcript never stops a session.
 */
export function recordEntry(
  deps: TranscriptDeps,
  sessionId: string,
  event: CoderTranscriptEvent,
): Promise<CodingSessionEntry | null> {
  return serial(sessionId, (s) => append(deps, s, sessionId, event)).catch((error: unknown) => {
    deps.logger.warn({ err: error, sessionId }, 'coding session transcript entry not written');
    return null;
  });
}

/** Publishes the entries written so far, after every write already asked for. */
export function flushTranscript(deps: TranscriptDeps, sessionId: string): Promise<void> {
  if (!slots.has(sessionId)) return Promise.resolve();
  return serial(sessionId, (s) => publish(deps, s, sessionId));
}

/** The entries after `after`, in order, at most `limit`, and whether more follow. */
export async function readEntries(
  db: Db,
  sessionId: string,
  { after = 0, limit = 200 }: { after?: number; limit?: number } = {},
): Promise<{ entries: CodingSessionEntry[]; hasMore: boolean }> {
  const take = Math.min(Math.max(limit, 1), 500);
  const rows = await db
    .select()
    .from(schema.codingSessionEvents)
    .where(
      and(
        eq(schema.codingSessionEvents.sessionId, sessionId),
        gt(schema.codingSessionEvents.seq, after),
      ),
    )
    .orderBy(asc(schema.codingSessionEvents.seq))
    .limit(take + 1);
  return { entries: rows.slice(0, take).map(toEntry), hasMore: rows.length > take };
}
