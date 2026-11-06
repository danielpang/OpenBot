import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import {
  coderWorld,
  REPO_PATH,
  type CoderIo,
  type CoderWorld,
} from '../services/__fixtures__/coders/setup.js';
import { rescueStatus, runRescueJob } from '../services/repos-jobs.js';
import {
  cloneRepo,
  forgetRepo,
  listFound,
  patchRepo,
  rememberFound,
  rememberRepos,
  requestScan,
} from '../services/repos.js';

// The repositories routes of Phase 2 (GH2 to GH6): remember from a
// connection, found clones, the per-repository toggles, rescue, scan and
// forget, each scoped to its owner. A self-hosted install has one account,
// so the second owner is a row of their own, asked through the services the
// routes call.

describe('repos routes', () => {
  let w: CoderWorld;
  let computerId: string;
  let connectionId: string;
  let eve: { id: string; workspaceId: string };
  let eveConnection: string;
  /** What another owner gets: the status of the error, or `ok`. */
  const asEve = <T>(fn: () => Promise<T>) =>
    w.t.inOrganization(fn).then(
      () => 'ok',
      (error: { status?: number }) => error.status,
    );

  beforeAll(async () => {
    w = await coderWorld('repos-routes@example.com');
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
    const [connection] = await w.t.db
      .insert(schema.gitConnections)
      .values({
        workspaceId: w.workspaceId,
        ownerId: w.ownerId,
        kind: 'app',
        installationId: '42',
        accountLogin: 'acme',
        repositories: [
          { fullName: 'acme/web', push: true, admin: false },
          { fullName: 'acme/relay', push: true, admin: false },
          { fullName: 'other/web', push: true, admin: false },
        ],
      })
      .returning();
    connectionId = connection!.id;
    const [user] = await w.t.db
      .insert(schema.users)
      .values({ name: 'Eve', email: 'eve-repos@example.com' })
      .returning();
    eve = { id: user!.id, workspaceId: w.workspaceId };
    const [other] = await w.t.db
      .insert(schema.gitConnections)
      .values({ workspaceId: w.workspaceId, ownerId: eve.id, kind: 'token', accountLogin: 'eve' })
      .returning();
    eveConnection = other!.id;
    await w.t.db.insert(schema.repoCheckouts).values({
      workspaceId: w.workspaceId,
      repoId: w.repoId,
      computerId,
      path: REPO_PATH,
      state: 'ready',
    });
    w.coder.agent = (io: CoderIo) => io.exit(0);
  });
  afterAll(() => w.close());

  type Repo = {
    id: string;
    fullName: string;
    found: boolean;
    keepCloned: boolean;
    pinned: boolean;
    lastRemotePushAt: string | null;
    checkout: { state: string; path: string; updatedAt: string } | null;
  };

  it('remembers repositories picked from a connection and clones each', async () => {
    const res = await w.call('POST', '/repos/remember', {
      fullNames: ['acme/web', 'acme/relay', 'acme/web'],
      connectionId,
    });
    expect(res.status).toBe(200);
    const { repos } = (await res.json()) as { repos: Repo[] };
    expect(repos.map((r) => r.fullName).sort()).toEqual(['acme/relay', 'acme/web']);
    const web = repos.find((r) => r.fullName === 'acme/web')!;
    expect(web).toMatchObject({
      found: false,
      keepCloned: true,
      lastRemotePushAt: null,
      checkout: { state: 'cloning', path: '/home/bot/repos/acme/web' },
    });
    // When the state last changed, so the page can tell a clone that is stuck.
    expect(Date.now() - Date.parse(web.checkout!.updatedAt)).toBeLessThan(60_000);
    const [row] = await w.t.db.select().from(schema.repos).where(eq(schema.repos.id, web.id));
    expect(row).toMatchObject({
      connectionId,
      remoteUrl: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
    });
    // The fixture's repository was already remembered: left as it was.
    const relay = repos.find((r) => r.fullName === 'acme/relay')!;
    expect(relay.id).toBe(w.repoId);

    expect(
      (await w.call('POST', '/repos/remember', { fullNames: ['not a name'], connectionId })).status,
    ).toBe(400);
    expect(
      (await w.call('POST', '/repos/remember', { fullNames: ['acme/..'], connectionId })).status,
    ).toBe(400);
    // A name the connection does not list, or another account's, is refused, and nothing is kept.
    for (const name of ['acme/unlisted', 'other/web']) {
      const refused = await w.call('POST', '/repos/remember', {
        fullNames: ['acme/web', name],
        connectionId,
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'CONNECTION_NO_ACCESS' });
    }
    const kept = await w.t.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.fullName, 'other/web'));
    expect(kept).toEqual([]);
    // Someone else's connection is not found.
    expect(
      (
        await w.call('POST', '/repos/remember', {
          fullNames: ['acme/x'],
          connectionId: eveConnection,
        })
      ).status,
    ).toBe(404);
    expect(
      await asEve(() => rememberRepos(w.t.deps, eve, { fullNames: ['acme/x'], connectionId })),
    ).toBe(404);
  });

  it('lists found clones and remembers one where it is', async () => {
    await w.t.db.insert(schema.repos).values({
      workspaceId: w.workspaceId,
      ownerId: w.ownerId,
      fullName: 'acme/tool',
      remoteUrl: 'https://github.com/acme/tool.git',
      keepCloned: false,
      foundPath: '/home/bot/code/tool',
    });
    const found = (await (await w.call('GET', '/repos/found')).json()) as { found: unknown[] };
    expect(found.found).toEqual([
      {
        path: '/home/bot/code/tool',
        remoteUrl: 'https://github.com/acme/tool.git',
        fullName: 'acme/tool',
      },
    ]);
    expect(await w.t.inOrganization(() => listFound(w.t.deps, eve))).toEqual([]);
    const listed = (await (await w.call('GET', '/repos')).json()) as { repos: Repo[] };
    expect(listed.repos.find((r) => r.fullName === 'acme/tool')).toMatchObject({
      found: true,
      keepCloned: false,
    });
    expect(await asEve(() => rememberFound(w.t.deps, eve, '/home/bot/code/tool'))).toBe(404);
    expect((await w.call('POST', '/repos/found/remember', { path: '/home/bot/nope' })).status).toBe(
      404,
    );
    const res = await w.call('POST', '/repos/found/remember', { path: '/home/bot/code/tool' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: Repo }).repo).toMatchObject({
      fullName: 'acme/tool',
      found: false,
      keepCloned: true,
      checkout: { state: 'ready', path: '/home/bot/code/tool' },
    });
    expect(
      ((await (await w.call('GET', '/repos/found')).json()) as { found: unknown[] }).found,
    ).toEqual([]);
  });

  it('patches keepCloned and pinned, for the owner only', async () => {
    const res = await w.call('PATCH', `/repos/${w.repoId}`, { keepCloned: false, pinned: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { repo: Repo }).repo).toMatchObject({
      keepCloned: false,
      pinned: true,
    });
    expect(await asEve(() => patchRepo(w.t.deps, eve, w.repoId, { pinned: false }))).toBe(404);
    const list = (await (await w.call('GET', '/repos')).json()) as { repos: Repo[] };
    expect(list.repos[0]!.id).toBe(w.repoId);
  });

  it('queues a scan, 409 without a computer', async () => {
    const res = await w.call('POST', '/repos/scan');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(await asEve(() => requestScan(w.t.deps, eve))).toBe(409);
  });

  it('says when the computer is made, for a Clone with no computer yet', async () => {
    const [repo] = await w.t.db
      .insert(schema.repos)
      .values({
        workspaceId: eve.workspaceId,
        ownerId: eve.id,
        fullName: 'eve/notes',
        remoteUrl: 'https://github.com/eve/notes.git',
      })
      .returning();
    const error = await w.t
      .inOrganization(() => cloneRepo(w.t.deps, eve, repo!.id))
      .catch((e: { status: number; message: string }) => e);
    expect(error).toMatchObject({
      status: 409,
      message:
        'The computer has not been created yet. It is created the first time a Bot uses it, and the repository is cloned then.',
    });
  });

  it("adds by URL under the URL's own name only", async () => {
    const res = await w.call('POST', '/repos', {
      remoteUrl: 'https://github.com/acme/site',
      fullName: '../../etc',
    });
    expect(res.status).toBe(400);
  });

  it('rescues: a request to poll, its results for the owner only', async () => {
    const res = await w.call('POST', '/repos/rescue');
    expect(res.status).toBe(202);
    const { requestId } = (await res.json()) as { requestId: string };
    expect(await (await w.call('GET', `/repos/rescue/${requestId}`)).json()).toEqual({
      status: 'running',
      results: [],
    });
    expect(await asEve(async () => rescueStatus(eve, requestId))).toBe(404);
    await w.t.inOrganization(() =>
      runRescueJob(w.t.deps, { ownerId: w.ownerId, computerId, requestId }),
    );
    const done = (await (await w.call('GET', `/repos/rescue/${requestId}`)).json()) as {
      status: string;
      results: { fullName: string }[];
    };
    expect(done.status).toBe('done');
    expect(done.results.map((r) => r.fullName)).toContain('acme/relay');
  });

  it('forgets a repository, keeping its clone unless asked to delete it', async () => {
    const list = (await (await w.call('GET', '/repos')).json()) as { repos: Repo[] };
    const web = list.repos.find((r) => r.fullName === 'acme/web')!;
    expect(await asEve(() => forgetRepo(w.t.deps, eve, web.id))).toBe(404);
    const kept = await w.call('DELETE', `/repos/${web.id}`);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({
      filesDeleted: false,
      path: '/home/bot/repos/acme/web',
      note: 'Forgot acme/web. Its clone stays on the computer at /home/bot/repos/acme/web',
    });

    const before = w.coder.calls.length;
    const deleted = await w.call('DELETE', `/repos/${w.repoId}?deleteFiles=true`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ filesDeleted: true, path: REPO_PATH });
    const rm = w.coder.calls.slice(before).find((c) => c.launch.command === 'rm')!;
    expect(rm.launch).toMatchObject({ user: 'runner', args: ['-rf', '--', REPO_PATH] });

    // A clone outside ~/repos is never deleted.
    const tool = list.repos.find((r) => r.fullName === 'acme/tool')!;
    const outside = await w.call('DELETE', `/repos/${tool.id}?deleteFiles=true`);
    expect(outside.status).toBe(409);
    expect(await outside.json()).toMatchObject({ code: 'NOT_DELETABLE' });
  });
});
