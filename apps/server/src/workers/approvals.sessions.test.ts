import { CODER_CONTROL_CHANNEL, type CoderControl } from '@openbots/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import { coderWorld, type CoderWorld } from '../services/__fixtures__/coders/setup.js';
import { closeApprovalsForRun, expireApproval } from '../services/approvals.js';
import { setApproval } from '../services/coder-state.js';

// The approvals bridge for coding sessions (I13): a session's request is
// decided, expired or cancelled like any other, but the answer goes to the
// session's job over openbots:coder-control and no run resumes.

describe('session approvals', () => {
  let w: CoderWorld;
  const controls: CoderControl[] = [];

  beforeAll(async () => {
    w = await coderWorld('bridge@example.com');
    await w.t.deps.infra.bus.subscribe<CoderControl>(CODER_CONTROL_CHANNEL, (m) =>
      controls.push(m),
    );
  });
  afterAll(() => w.close());

  async function request(actionClass: string, expiresAt = new Date(Date.now() + 60_000)) {
    const { sessionId, runId, messageId } = await w.newSession({ status: 'waiting' });
    const [row] = await w.t.db
      .insert(schema.approvals)
      .values({
        workspaceId: w.workspaceId,
        runId,
        messageId,
        toolName: 'Bash',
        args: { command: 'git push origin bot/x' },
        reason: 'Run: git push origin bot/x',
        sessionId,
        actionClass,
        expiresAt,
      })
      .returning();
    await w.t.inOrganization(() =>
      setApproval(w.t.deps, sessionId, {
        id: row!.id,
        action_class: actionClass as 'push',
        title: row!.reason!,
        status: 'pending',
      }),
    );
    return { sessionId, runId, approvalId: row!.id };
  }

  const approvalOf = async (id: string) =>
    (await w.t.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)))[0]!;
  const forSession = (sessionId: string) =>
    controls.filter((c) => 'sessionId' in c && c.sessionId === sessionId);

  it('an approved push arms the session and answers it; no run resumes', async () => {
    const { sessionId, runId, approvalId } = await request('push');
    const res = await w.call('POST', `/approvals/${approvalId}/decide`, {
      decision: 'approve',
      note: 'Go ahead',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approval: { id: approvalId, status: 'approved', note: 'Go ahead' },
      resumedRunId: null,
    });
    await w.until(() =>
      expect(forSession(sessionId)).toEqual([
        { type: 'push_allowed', sessionId },
        { type: 'approval', sessionId, approvalId, decision: 'approved' },
      ]),
    );
    expect((await approvalOf(approvalId)).decidedBy).toBe(w.ownerId);
    expect((await w.run(runId)).status).toBe('waiting');
    expect((await w.widget(sessionId)).approvals[0]!.status).toBe('approved');
  });

  it('a denial answers no and arms nothing', async () => {
    const { sessionId, approvalId } = await request('install');
    expect(
      (await w.call('POST', `/approvals/${approvalId}/decide`, { decision: 'deny' })).status,
    ).toBe(200);
    await w.until(() =>
      expect(forSession(sessionId)).toEqual([
        { type: 'approval', sessionId, approvalId, decision: 'denied' },
      ]),
    );
  });

  it('expiry answers denied', async () => {
    const { sessionId, runId, approvalId } = await request('push', new Date(Date.now() - 1_000));
    expect(await w.t.inOrganization(() => expireApproval(w.t.deps, approvalId))).toBe(true);
    expect((await approvalOf(approvalId)).status).toBe('expired');
    await w.until(() =>
      expect(forSession(sessionId)).toEqual([
        { type: 'approval', sessionId, approvalId, decision: 'denied' },
      ]),
    );
    expect((await w.widget(sessionId)).approvals[0]!.status).toBe('expired');
    expect((await w.run(runId)).status).toBe('waiting');
  });

  it("the run's cancellation answers denied", async () => {
    const { sessionId, runId, approvalId } = await request('destructive');
    await w.t.inOrganization(() => closeApprovalsForRun(w.t.deps, runId));
    expect((await approvalOf(approvalId)).status).toBe('denied');
    await w.until(() =>
      expect(forSession(sessionId)).toEqual([
        { type: 'approval', sessionId, approvalId, decision: 'denied' },
      ]),
    );
  });
});
