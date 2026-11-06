import { CODER_CONTROL_CHANNEL, type CoderControl } from '@openbots/shared';
import { stateVolumeName, volumeName } from '@openbots/computer';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import {
  coderWorld,
  defaultGit,
  REPO_PATH,
  type CoderWorld,
} from '../services/__fixtures__/coders/setup.js';
import { RESET_PREPARE_TTL_MS, resetStatus } from '../services/computer-reset.js';
import { runRescueJob } from '../services/repos-rescue.js';

// Reset computer, rescue first (GH5): prepare runs the rescue and lists what
// it could not push and the live sessions; the reset, confirmed after a done
// prepare, removes the machine and its home through the provider (the docker
// provider over a mocked daemon here) and marks every checkout missing.

describe('computer reset', () => {
  let w: CoderWorld;
  let computerId: string;
  const controls: CoderControl[] = [];
  const worktree = `${REPO_PATH}/.worktrees/bot-x`;

  beforeAll(async () => {
    w = await coderWorld('computer-reset@example.com');
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    await w.t.deps.infra.bus.subscribe<CoderControl>(CODER_CONTROL_CHANNEL, (m) =>
      controls.push(m),
    );
  });
  afterAll(() => w.close());

  async function checkout() {
    await w.t.db
      .delete(schema.repoCheckouts)
      .where(eq(schema.repoCheckouts.computerId, computerId));
    await w.t.db.insert(schema.repoCheckouts).values({
      workspaceId: w.workspaceId,
      repoId: w.repoId,
      computerId,
      path: REPO_PATH,
      state: 'ready',
    });
  }

  /** Prepares a reset and runs its rescue to the end. */
  async function prepared(): Promise<{ requestId: string; status: ResetStatus }> {
    const res = await w.call('POST', '/computer/reset/prepare');
    expect(res.status, await res.clone().text()).toBe(202);
    const { requestId } = (await res.json()) as { requestId: string };
    await w.t.inOrganization(() =>
      runRescueJob(w.t.deps, { ownerId: w.ownerId, computerId, requestId }),
    );
    const status = await w.until(async () => {
      const body = (await (
        await w.call('GET', `/computer/reset/${requestId}`)
      ).json()) as ResetStatus;
      expect(body.status).toBe('done');
      return body;
    });
    return { requestId, status };
  }

  type ResetStatus = {
    status: string;
    results: { fullName: string; pushed: boolean }[];
    unsaved: { fullName: string; branch: string | null; note: string }[];
    runningSessions: { id: string }[];
    error: string | null;
  };

  const reset = (body: Record<string, unknown>) => w.call('POST', '/computer/reset', body);

  it('prepares: rescue results, what could not be pushed, and the live sessions', async () => {
    await checkout();
    const { sessionId } = await w.newSession({ status: 'running', worktreePath: worktree });
    // The push of the rescue branch is refused, so the unpushed commit is unsaved.
    w.coder.git = (a) =>
      a.includes('push') ? { code: 1, stderr: 'remote rejected' } : defaultGit(a);
    const { requestId, status } = await prepared();
    expect(status.results.map((r) => r.fullName)).toContain('acme/relay');
    expect(status.unsaved).toEqual([
      expect.objectContaining({
        fullName: 'acme/relay',
        note: expect.stringMatching(/^Could not save 1 unpushed commit/),
      }),
    ]);
    expect(status.runningSessions.map((s) => s.id)).toEqual([sessionId]);
    expect(status.error).toBeNull();
    // Another owner cannot read it.
    const eve = { id: '00000000-0000-4000-8000-000000000001', workspaceId: w.workspaceId };
    await expect(resetStatus(w.t.deps, eve, requestId)).rejects.toMatchObject({ status: 404 });
    w.coder.git = defaultGit;
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'settled' })
      .where(eq(schema.codingSessions.id, sessionId));
  });

  it('refuses a reset without a done prepare, a stale one, or an unseen session', async () => {
    const none = await reset({ requestId: crypto.randomUUID(), confirm: true });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: 'RESET_NOT_PREPARED' });
    expect((await reset({ requestId: crypto.randomUUID() })).status).toBe(400);

    const stale = await prepared();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + RESET_PREPARE_TTL_MS + 1);
    try {
      const late = await reset({ requestId: stale.requestId, confirm: true });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: 'RESET_NOT_PREPARED' });
    } finally {
      clock.mockRestore();
    }

    // A session that started after the prepare was never shown: prepare again.
    const { requestId } = await prepared();
    const { sessionId } = await w.newSession({ status: 'running' });
    const unseen = await reset({ requestId, confirm: true });
    expect(unseen.status).toBe(409);
    expect(await unseen.json()).toMatchObject({ code: 'CODING_SESSION_RUNNING' });
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'settled' })
      .where(eq(schema.codingSessions.id, sessionId));
  });

  it('resets: the machine and its home go, sign-ins stay, checkouts are missing', async () => {
    await checkout();
    const { sessionId } = await w.newSession({ status: 'settled', worktreePath: worktree });
    await w.setAccount('claude', { authKind: 'subscription', accountLabel: 'dana@example.com' });
    const { requestId } = await prepared();
    const home = volumeName(computerId);
    const state = stateVolumeName(computerId);
    expect(w.computer.docker.volumes).toEqual(new Set([home, state]));
    controls.length = 0;

    const res = await reset({ requestId, confirm: true });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await res.json()).toMatchObject({ id: computerId, status: 'stopped' });
    expect(w.computer.docker.volumes).toEqual(new Set([state]));
    expect(w.computer.docker.containers.size).toBe(0);
    expect(controls).toContainEqual({ type: 'stop_all', computerId });

    const [row] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.id, computerId));
    expect(row).toMatchObject({ status: 'stopped', agentUrl: null, containerId: null });
    const checkouts = await w.t.db
      .select()
      .from(schema.repoCheckouts)
      .where(eq(schema.repoCheckouts.computerId, computerId));
    expect(checkouts.map((c) => c.state)).toEqual(['missing']);
    expect((await w.session(sessionId)).worktreePath).toBeNull();
    const [account] = await w.t.db
      .select()
      .from(schema.coderAccounts)
      .where(
        and(eq(schema.coderAccounts.ownerId, w.ownerId), eq(schema.coderAccounts.agent, 'claude')),
      );
    expect(account).toMatchObject({ authKind: 'subscription' });
    const [audit] = await w.t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'computer.reset'));
    expect(audit).toMatchObject({ targetId: computerId, metadata: { requestId, signIns: false } });

    // Used once.
    expect((await reset({ requestId, confirm: true })).status).toBe(409);

    // The next start makes a fresh computer with a new home.
    const creates = w.computer.docker.calls.filter((c) => c.op === 'createContainer').length;
    expect((await w.call('POST', '/computer/start')).status).toBe(200);
    expect(w.computer.docker.calls.filter((c) => c.op === 'createContainer')).toHaveLength(
      creates + 1,
    );
    expect(w.computer.docker.volumes).toEqual(new Set([home, state]));
  });

  it('removes the sign-ins too when asked', async () => {
    await w.setAccount('claude', { authKind: 'subscription', accountLabel: 'dana@example.com' });
    const { requestId } = await prepared();
    const res = await reset({ requestId, confirm: true, resetSignIns: true });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(w.computer.docker.volumes).toEqual(new Set());
    const [account] = await w.t.db
      .select()
      .from(schema.coderAccounts)
      .where(
        and(eq(schema.coderAccounts.ownerId, w.ownerId), eq(schema.coderAccounts.agent, 'claude')),
      );
    expect(account).toMatchObject({ authKind: 'none', accountLabel: null });
  });
});
