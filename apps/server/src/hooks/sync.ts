import { EVENTS_CHANNEL, type MessagePart, type WsEvent } from '@openbots/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import type { RunStatus } from '../services/runs.js';

// Sync response mode (plan 11, H4): the request waits on the event bus for
// the run's status, which every process sees, up to the endpoint's timeout,
// then answers with the Bot's reply text. A run that pauses for the owner
// (an approval or a question) ends the wait too: the owner, not the caller,
// decides what happens next.

/** Where the wait ends. */
const SETTLED: RunStatus[] = ['completed', 'failed', 'cancelled', 'waiting'];

export interface SyncReply {
  status: RunStatus;
  /** The Bot's reply in this run, its text parts joined; null when it said nothing. */
  text: string | null;
  error: string | null;
}

/** Waits up to `timeoutMs` for the run to settle; null on timeout. */
export async function waitForReply(
  deps: Pick<AppDeps, 'db' | 'infra'>,
  runId: string,
  timeoutMs: number,
): Promise<SyncReply | null> {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const unsubscribe = await deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (event) => {
    if (
      event.type === 'run.status' &&
      event.payload.runId === runId &&
      SETTLED.includes(event.payload.status)
    ) {
      settle();
    }
  });
  const timer = setTimeout(settle, timeoutMs);
  try {
    // A status published before the subscription is in the row already.
    if (!(await settledRun(deps, runId))) await settled;
    return await settledRun(deps, runId);
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

async function settledRun(deps: Pick<AppDeps, 'db'>, runId: string): Promise<SyncReply | null> {
  const [run] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!run || !SETTLED.includes(run.status)) return null;
  const messages = await deps.db
    .select({ parts: schema.messages.parts })
    .from(schema.messages)
    .where(and(eq(schema.messages.runId, runId), eq(schema.messages.authorType, 'bot')))
    .orderBy(asc(schema.messages.seq));
  const text = messages
    .flatMap((m) => (m.parts as MessagePart[]).filter((p) => p.type === 'text'))
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n');
  return { status: run.status, text: text || null, error: run.error };
}
