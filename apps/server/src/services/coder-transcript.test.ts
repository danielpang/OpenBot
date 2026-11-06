import {
  EVENTS_CHANNEL,
  SESSION_EVENT_TEXT_MAX,
  SESSION_EVENTS_MAX,
  type CodingSessionEntry,
  type WsEvent,
} from '@openbots/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { coderWorld, type CoderWorld } from './__fixtures__/coders/setup.js';
import { setSessionStatus } from './coder-state.js';
import { flushTranscript, readEntries, recordEntry, TRANSCRIPT_FULL } from './coder-transcript.js';

// A session's transcript (CA15): numbered in order and by prompt, clipped,
// capped with one marker, and published in batches that come before the
// status change they led to.

describe('coder transcript', () => {
  let w: CoderWorld;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    w = await coderWorld('transcript@example.com');
    await w.t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => w.close());

  const rows = (sessionId: string) =>
    w.t.db
      .select()
      .from(schema.codingSessionEvents)
      .where(eq(schema.codingSessionEvents.sessionId, sessionId))
      .orderBy(asc(schema.codingSessionEvents.seq));
  const forSession = (sessionId: string) =>
    events.filter(
      (e) =>
        (e.type === 'coding_session.events' &&
          (e.payload as { sessionId: string }).sessionId === sessionId) ||
        (e.type === 'coding_session.updated' &&
          (e.payload as { session: { id: string } }).session.id === sessionId),
    );

  it('numbers entries per session, with a new turn per prompt', async () => {
    const { sessionId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      await recordEntry(deps, sessionId, { type: 'prompt', text: 'Fix it', by: 'bot' });
      await recordEntry(deps, sessionId, { type: 'text', text: 'Looking' });
      await recordEntry(deps, sessionId, { type: 'tool_use', name: 'Read', summary: 'a.ts' });
      await recordEntry(deps, sessionId, { type: 'prompt', text: 'And the docs', by: 'owner' });
      await recordEntry(deps, sessionId, { type: 'text', text: 'Done' });
    });
    expect((await rows(sessionId)).map((r) => [r.seq, r.turn, r.event.type])).toEqual([
      [1, 1, 'prompt'],
      [2, 1, 'text'],
      [3, 1, 'tool_use'],
      [4, 2, 'prompt'],
      [5, 2, 'text'],
    ]);
    const page = await readEntries(w.t.db, sessionId, { after: 1, limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect((await readEntries(w.t.db, sessionId, { after: 3, limit: 2 })).hasMore).toBe(false);

    // Another session starts again from 1.
    const other = await w.newSession();
    await w.t.inOrganization(() =>
      recordEntry(deps, other.sessionId, { type: 'text', text: 'Hello' }),
    );
    expect((await rows(other.sessionId)).map((r) => [r.seq, r.turn])).toEqual([[1, 1]]);
  });

  it("clips long text and never keeps a prompt's input", async () => {
    const { sessionId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      await recordEntry(deps, sessionId, {
        type: 'text',
        text: 'x'.repeat(SESSION_EVENT_TEXT_MAX + 50),
      });
      await recordEntry(deps, sessionId, {
        type: 'approval_request',
        request_id: 'r1',
        action_class: 'push',
        title: 'Run: git push',
        input: { command: 'git push' },
      });
    });
    const [text, approval] = await rows(sessionId);
    const kept = (text!.event as { text: string }).text;
    expect(kept).toHaveLength(SESSION_EVENT_TEXT_MAX);
    expect(kept.endsWith('…')).toBe(true);
    expect(approval!.event).toEqual({
      type: 'approval_request',
      request_id: 'r1',
      action_class: 'push',
      title: 'Run: git push',
    });
  });

  it('stops at the cap with one marker entry', async () => {
    const { sessionId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.db.insert(schema.codingSessionEvents).values(
      Array.from({ length: SESSION_EVENTS_MAX - 2 }, (_, i) => ({
        workspaceId: w.workspaceId,
        sessionId,
        seq: i + 1,
        turn: 1,
        at: new Date(),
        event: { type: 'text' as const, text: `line ${i}` },
      })),
    );
    const results = await w.t.inOrganization(async () => [
      await recordEntry(deps, sessionId, { type: 'text', text: 'last kept' }),
      await recordEntry(deps, sessionId, { type: 'text', text: 'becomes the marker' }),
      await recordEntry(deps, sessionId, { type: 'text', text: 'dropped' }),
    ]);
    expect(results.map((r) => r?.seq ?? null)).toEqual([
      SESSION_EVENTS_MAX - 1,
      SESSION_EVENTS_MAX,
      null,
    ]);
    const all = await rows(sessionId);
    expect(all).toHaveLength(SESSION_EVENTS_MAX);
    expect(all.at(-1)!.event).toEqual({ type: 'error', message: TRANSCRIPT_FULL });
  });

  it('publishes entries in batches, before the status change they led to', async () => {
    const { sessionId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      await recordEntry(deps, sessionId, { type: 'prompt', text: 'Fix it', by: 'bot' });
      await recordEntry(deps, sessionId, { type: 'text', text: 'Working' });
      await recordEntry(deps, sessionId, { type: 'text', text: 'Still working' });
    });
    // Nothing yet: the batch waits for its flush.
    expect(forSession(sessionId)).toEqual([]);
    await w.t.inOrganization(() => setSessionStatus(deps, sessionId, 'running'));
    const published = forSession(sessionId);
    expect(published.map((e) => e.type)).toEqual([
      'coding_session.events',
      'coding_session.updated',
    ]);
    expect(published[0]).toMatchObject({ user_id: w.ownerId, workspace_id: w.workspaceId });
    const { entries } = published[0]!.payload as unknown as { entries: CodingSessionEntry[] };
    expect(entries.map((e) => [e.seq, e.event.type])).toEqual([
      [1, 'prompt'],
      [2, 'text'],
      [3, 'text'],
    ]);
    expect(published[1]).toMatchObject({
      user_id: w.ownerId,
      workspace_id: w.workspaceId,
      payload: { session: { id: sessionId, status: 'running', title: 'Fix the reconnect loop' } },
    });

    // On its own, a batch goes out within the flush interval.
    await w.t.inOrganization(() => recordEntry(deps, sessionId, { type: 'text', text: 'More' }));
    await w.until(() => expect(forSession(sessionId)).toHaveLength(3));
    await w.t.inOrganization(() => flushTranscript(deps, sessionId));
    expect(forSession(sessionId)).toHaveLength(3);
  });
});
