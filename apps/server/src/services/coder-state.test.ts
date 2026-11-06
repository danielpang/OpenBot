import { CODER_FEED_MAX, EVENTS_CHANNEL, type WsEvent } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { coderWorld, type CoderWorld } from './__fixtures__/coders/setup.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_SESSION_ID } from './coder-adapters/index.js';
import {
  appendFeed,
  applyEvent,
  feedLine,
  flushFeed,
  readSessionLog,
  removeSessionLog,
  sessionLogPath,
  setApproval,
  setApprovalStatus,
  setSessionStatus,
  settleSession,
} from './coder-state.js';

const V9 = '9b1e2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

// A coding session's row and widget move together, the widget hears
// `widget.updated` like any other, and feed lines are batched.

describe('coder state', () => {
  let w: CoderWorld;
  const events: WsEvent[] = [];

  beforeAll(async () => {
    w = await coderWorld('state@example.com');
    await w.t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
  });
  afterAll(() => w.close());

  const updates = (messageId: string) =>
    events.filter(
      (e) =>
        e.type === 'widget.updated' &&
        (e.payload as { widget: { messageId: string } }).widget.messageId === messageId,
    );

  it('batches feed lines into one write and publish, capped', async () => {
    const { sessionId, messageId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      for (let i = 0; i < CODER_FEED_MAX + 20; i++) {
        appendFeed(deps, sessionId, feedLine('text', `line ${i}`));
      }
    });
    expect(updates(messageId)).toHaveLength(0);
    await w.until(() => expect(updates(messageId)).toHaveLength(1));
    const state = await w.widget(sessionId);
    expect(state.feed).toHaveLength(CODER_FEED_MAX);
    expect(state.feed.at(-1)!.text).toBe(`line ${CODER_FEED_MAX + 19}`);
    const event = updates(messageId)[0]!;
    expect(event).toMatchObject({ chat_id: w.bot.chatId, bot_id: w.bot.id });
  });

  it('records status, usage, results, approvals, and settles', async () => {
    const { sessionId, messageId, runId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      await setSessionStatus(deps, sessionId, 'running', { startedAt: new Date() });
      await applyEvent(deps, sessionId, {
        type: 'usage',
        input_tokens: 10,
        output_tokens: 2,
        cost_usd: 0.01,
        billed: 'api',
      });
      await applyEvent(deps, sessionId, {
        type: 'usage',
        input_tokens: 5,
        output_tokens: 1,
        billed: 'api',
      });
      await applyEvent(deps, sessionId, {
        type: 'result',
        ok: true,
        summary: 'Done',
        vendor_session_id: V9,
      });
      await setApproval(deps, sessionId, {
        id: '11111111-1111-4111-8111-111111111111',
        action_class: 'push',
        title: 'Run: git push',
        status: 'pending',
      });
      await setApproval(deps, sessionId, {
        id: '22222222-2222-4222-8222-222222222222',
        action_class: 'install',
        title: 'Run: pnpm add x',
        status: 'pending',
      });
      await setApprovalStatus(deps, sessionId, '22222222-2222-4222-8222-222222222222', 'approved');
    });
    const row = await w.session(sessionId);
    expect(row).toMatchObject({
      status: 'running',
      vendorSessionId: V9,
      summary: 'Done',
      usage: { input_tokens: 15, output_tokens: 3, cost_usd: 0.01, billed: 'api' },
    });
    let state = await w.widget(sessionId);
    expect(state).toMatchObject({ status: 'running', vendor_session_id: V9 });
    expect(state.started_at).toBeDefined();
    expect(state.approvals.map((a) => a.status)).toEqual(['pending', 'approved']);
    expect(state.feed.map((l) => l.type)).toEqual(['usage', 'usage', 'result']);

    state = await w.t.inOrganization(() =>
      settleSession(deps, sessionId, {
        status: 'settled',
        result: {
          summary: 'Done',
          changed_files: [],
          commits: [{ sha: 'a', title: 'A' }],
          branch: 'bot/x',
          base: 'main',
          worktree_path: '/home/bot/repos/acme/relay/.worktrees/bot-x',
        },
      }),
    );
    expect(state.status).toBe('settled');
    expect(state.finished_at).toBeDefined();
    // A request still pending when the session ends can no longer be answered.
    expect(state.approvals.map((a) => a.status)).toEqual(['expired', 'approved']);
    expect(await w.widget(sessionId)).toEqual(state);
    const settled = await w.session(sessionId);
    expect(settled).toMatchObject({ status: 'settled', commits: [{ sha: 'a', title: 'A' }] });
    expect(settled.finishedAt).not.toBeNull();
    const [ws] = await w.t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, messageId));
    expect(ws!.pendingRunId).toBeNull();
    expect(runId).toBeDefined();
    // Nothing buffered is left behind.
    expect(await w.t.inOrganization(() => flushFeed(deps, sessionId))).toEqual(state);
  });

  it('drops a vendor session id that is not a UUID, with a feed line', async () => {
    const { sessionId } = await w.newSession();
    const deps = w.t.deps;
    await w.t.inOrganization(async () => {
      await applyEvent(deps, sessionId, {
        type: 'result',
        ok: true,
        summary: 'Done',
        vendor_session_id: '--dangerously-skip-permissions',
      });
      await flushFeed(deps, sessionId);
    });
    const row = await w.session(sessionId);
    expect(row).toMatchObject({ vendorSessionId: null, summary: 'Done' });
    const state = await w.widget(sessionId);
    expect(state.vendor_session_id).toBeUndefined();
    expect(state.feed.map((l) => l.text)).toContain(IGNORED_SESSION_ID);
  });

  it('shows the widget a sentence while the row keeps the marker', async () => {
    const { sessionId } = await w.newSession();
    const state = await w.t.inOrganization(() =>
      settleSession(w.t.deps, sessionId, {
        status: 'failed',
        error: 'needs_login',
        widgetError: 'Claude Code is not signed in on this computer.',
      }),
    );
    expect(state.error).toBe('Claude Code is not signed in on this computer.');
    expect((await w.widget(sessionId)).error).toBe(state.error);
    expect((await w.session(sessionId)).error).toBe('needs_login');
  });

  it('reads the tail of a session log from the server, and removes it', async () => {
    const deps = w.t.deps;
    const session = { id: '3c4d5e6f-0000-4000-8000-000000000123' };
    const file = sessionLogPath(deps, session.id);
    expect(file).toBe(path.join(deps.config.filesDir, 'coders', `${session.id}.log`));
    expect(await readSessionLog(deps, session, 100)).toBe('');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'first line\nsecond line\n');
    expect(await readSessionLog(deps, session, 12)).toBe('second line\n');
    expect(await readSessionLog(deps, session, 1_000)).toBe('first line\nsecond line\n');
    await removeSessionLog(deps, session);
    expect(await readSessionLog(deps, session, 100)).toBe('');
    // A row's id is the only part of the path; anything else is refused.
    expect(() => sessionLogPath(deps, '../../etc/passwd')).toThrow();
  });
});
