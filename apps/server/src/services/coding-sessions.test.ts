import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ComputerProvider } from '@openbots/computer';
import {
  CODER_CONTROL_CHANNEL,
  CODERS_QUEUE,
  DEFAULT_MAX_REPOS,
  EVENTS_CHANNEL,
  type CoderControl,
  type CodingSessionEntry,
  type MessagePart,
  type WsEvent,
} from '@openbots/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { widgetToolResult } from '@openbots/widgets';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { ptyParams } from '../ws/computer.js';
import { scriptedCoder } from './__fixtures__/coders/setup.js';
import { useCoderAdapter } from './__fixtures__/coders/adapters.js';
import type { CoderAdapter } from './coder-adapters/index.js';
import type { CoderJob } from './coder-jobs.js';
import { startLogin } from './coder-login.js';
import { runCoderLogin, UNEXPECTED_LOGIN_HOST } from './coder-login-driver.js';
import { sessionLogPath } from './coder-state.js';
import { storeFile } from './files.js';
import { recordEntry } from './coder-transcript.js';
import { coderContextFor, coderServices } from './coder-tool.js';
import { resumeIfCoderWidgetDone } from './coder-widget-actions.js';
import { sessionBranch } from './repos-checkout.js';
import { setComputerProvider } from './computer.js';
import { listRepos, parseRepoUrl, updateRepo } from './repos.js';
import { registerRunHooks, type RunState } from './runs.js';

// Coding agents, server side (I4, I9, I14, I15): `code_task`'s services post
// the session widget and enqueue the runner, or the sign-in widget when the
// agent is not signed in; the sign-in driver reads the link from a scripted
// login and writes the owner's code back; the widget's actions and the REST
// routes move the row; repositories are added by URL; the PTY proxy passes
// a session's terminal parameters only for the owner's own paths. The
// runner is another file's: here its jobs are only recorded.

/** A sign-in that prints a link, asks for a code, and signs in when it gets `good-code`. */
const fakePi: CoderAdapter = {
  agent: 'pi',
  command: 'fake-pi',
  versionArgs: ['--version'],
  signIn: {
    kind: 'pty',
    instructions:
      'Open this link on any device and finish signing in, then paste the code if it gives you one.',
    hosts: ['pi.example'],
    login: () => ({ command: 'fake-pi', args: ['login'], timeoutMs: 5_000 }),
    parseLogin: (chunk, state) => {
      const next = { ...state };
      const url = /https:\/\/\S+/.exec(chunk)?.[0];
      if (url && !next.url) next.url = url;
      if (/paste the code/i.test(chunk)) next.awaitingCode = true;
      const done = /signed in as (\S+)/i.exec(chunk);
      if (done) {
        next.signedIn = true;
        next.accountLabel = done[1];
      }
      return next;
    },
  },
  launch: () => ({ command: 'fake-pi', args: [], env: {} }),
  parser: () => ({ line: () => [], end: () => [] }),
  resumeCommand: (id) => `fake-pi --session ${id}`,
  classify: () => ({ action: 'other', title: 'x' }),
};

describe('coding agents', () => {
  let t: TestApp;
  let computer: TestComputer;
  const coder = scriptedCoder();
  let dana: string;
  let eve: string;
  let danaId: string;
  let workspaceId: string;
  let bot: { id: string; chatId: string; handle: string; name: string };
  let repoId: string;
  const jobs: CoderJob[] = [];
  const controls: CoderControl[] = [];
  const events: WsEvent[] = [];

  let restoreAdapter: () => void;

  beforeAll(async () => {
    restoreAdapter = useCoderAdapter(fakePi);
    t = await createTestApp({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_SIGNUP_MODE: 'open' });
    computer = await useTestComputer(t.ownerDeps);
    const inner = computer.provider;
    const provider: ComputerProvider = {
      ...inner,
      agent: (ref) => ({ ...inner.agent(ref), coder: coder.coder }),
    };
    setComputerProvider(t.ownerDeps, provider);
    dana = (await t.signUp('dana@example.com')).cookie!;
    eve = (await t.signUp('eve@example.com')).cookie!;
    danaId = await t.userId('dana@example.com');
    workspaceId = await t.defaultOrganization();
    await t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(async (job) => void jobs.push(job.data as CoderJob));
    await t.deps.infra.bus.subscribe<CoderControl>(CODER_CONTROL_CHANNEL, (m) => {
      controls.push(m);
    });
    await t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => events.push(e));
    const res = await call(dana, 'POST', '/bots', {
      name: 'Relay Bot',
      modelConfig: { provider_id: await t.providerId(), model_id: 'scripted' },
    });
    expect(res.status).toBe(201);
    bot = (await res.json()) as typeof bot;
    expect((await call(dana, 'POST', '/computer/start')).status).toBe(200);
  });
  afterAll(async () => {
    restoreAdapter();
    await computer.close();
    await t.close();
  });

  function call(cookie: string, method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const until = <T>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5_000, interval: 10 });
  const owner = () => ({ id: danaId, workspaceId });
  const botRow = async () =>
    (await t.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id)))[0]!;

  /** A run of the Bot in its transcript, waiting as `code_task` leaves it. */
  async function waitingRun() {
    const [run] = await t.db
      .insert(schema.runs)
      .values({
        workspaceId,
        botId: bot.id,
        chatId: bot.chatId,
        trigger: 'message',
        status: 'waiting',
        state: {
          version: 1,
          messages: [],
          pending: { reason: 'widget', toolCallId: 'call-1', toolName: 'code_task', args: {} },
        },
      })
      .returning();
    return run!;
  }

  const services = async (runId: string) =>
    coderServices(t.ownerDeps, {
      bot: await botRow(),
      runId,
      chatId: bot.chatId,
      source: 'owner',
    });

  const session = async (id: string) =>
    (await t.db.select().from(schema.codingSessions).where(eq(schema.codingSessions.id, id)))[0]!;
  const widgetRow = async (messageId: string) =>
    (
      await t.db
        .select()
        .from(schema.widgetStates)
        .where(
          and(eq(schema.widgetStates.messageId, messageId), eq(schema.widgetStates.partIndex, 0)),
        )
    )[0]!;
  const runRow = async (id: string) =>
    (await t.db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]!;
  const signIn = (agent: 'claude' | 'pi') =>
    t.db
      .insert(schema.coderAccounts)
      .values({ workspaceId, ownerId: danaId, agent, authKind: 'subscription' })
      .onConflictDoUpdate({
        target: [
          schema.coderAccounts.workspaceId,
          schema.coderAccounts.ownerId,
          schema.coderAccounts.agent,
        ],
        set: { authKind: 'subscription', lastError: null },
      });
  const endAll = () =>
    t.db
      .update(schema.codingSessions)
      .set({ status: 'settled' })
      .where(eq(schema.codingSessions.botId, bot.id));

  it('seeds "Working in a repository" once per library and enables it for each new Bot', async () => {
    const res = await call(dana, 'POST', '/bots', { name: 'Second Bot', modelConfig: null });
    expect(res.status).toBe(201);
    const second = (await res.json()) as { id: string };
    const skills = await t.db.select().from(schema.skills).where(eq(schema.skills.ownerId, danaId));
    const builtin = skills.filter((s) => s.slug === 'working-in-a-repository');
    expect(builtin).toHaveLength(1);
    expect(builtin[0]).toMatchObject({ name: 'Working in a repository', source: 'manual' });
    for (const botId of [bot.id, second.id]) {
      const [enabled] = await t.db
        .select()
        .from(schema.botSkills)
        .where(
          and(eq(schema.botSkills.botId, botId), eq(schema.botSkills.skillId, builtin[0]!.id)),
        );
      expect(enabled?.enabled).toBe(true);
    }
  });

  describe('repositories', () => {
    it('reads https and ssh GitHub remotes as owner/name, and refuses the rest', () => {
      for (const url of [
        'https://github.com/acme/relay',
        'https://github.com/acme/relay.git',
        'git@github.com:acme/relay.git',
        'ssh://git@github.com/acme/relay.git',
      ]) {
        expect(parseRepoUrl(url)).toMatchObject({
          fullName: 'acme/relay',
          remoteUrl: 'https://github.com/acme/relay.git',
        });
      }
      expect(parseRepoUrl('https://gitlab.com/g/sub/proj').fullName).toBe('sub/proj');
      for (const bad of [
        'not a url',
        'ftp://github.com/a/b',
        'file:///etc/passwd',
        'https://github.com/acme',
        'https://github.com/acme/relay/tree/main',
        'https://x-access-token:ghp_secret@github.com/acme/relay',
      ]) {
        expect(() => parseRepoUrl(bad), bad).toThrow();
      }
    });

    it('adds by URL, clones onto the computer, and refuses duplicates and bad URLs', async () => {
      const res = await call(dana, 'POST', '/repos', {
        remoteUrl: 'git@github.com:acme/relay.git',
      });
      expect(res.status).toBe(201);
      const { repo } = (await res.json()) as {
        repo: { id: string; fullName: string; remoteUrl: string; checkout: { state: string } };
      };
      repoId = repo.id;
      expect(repo).toMatchObject({
        fullName: 'acme/relay',
        remoteUrl: 'https://github.com/acme/relay.git',
        defaultBranch: 'main',
        keepCloned: true,
        checkout: { state: 'cloning', path: '/home/bot/repos/acme/relay' },
      });
      const [comp] = await t.db.select().from(schema.computers);
      await until(() =>
        expect(jobs).toContainEqual({
          kind: 'checkout',
          repoId,
          computerId: comp!.id,
          action: 'clone',
          workspaceId,
        }),
      );
      const again = await call(dana, 'POST', '/repos', {
        remoteUrl: 'https://github.com/acme/relay',
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: 'REPO_EXISTS' });
      const bad = await call(dana, 'POST', '/repos', { remoteUrl: 'ftp://example.com/x/y' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ code: 'INVALID_REPO_URL' });

      const list = (await (await call(dana, 'GET', '/repos')).json()) as { repos: unknown[] };
      expect(list.repos).toHaveLength(1);
      expect(
        ((await (await call(eve, 'GET', '/repos')).json()) as { repos: unknown[] }).repos,
      ).toEqual([]);
      expect((await call(eve, 'POST', `/repos/${repoId}/update`)).status).toBe(404);
      expect((await call(eve, 'DELETE', `/repos/${repoId}`)).status).toBe(404);
      const update = await call(dana, 'POST', `/repos/${repoId}/update`);
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ repo: { checkout: { state: 'updating' } } });
    });

    it(`keeps at most ${DEFAULT_MAX_REPOS} repositories`, async () => {
      const eveId = await t.userId('eve@example.com');
      await t.db.insert(schema.repos).values(
        Array.from({ length: DEFAULT_MAX_REPOS }, (_, i) => ({
          workspaceId,
          ownerId: eveId,
          fullName: `eve/r${i}`,
          remoteUrl: `https://github.com/eve/r${i}.git`,
        })),
      );
      const res = await call(eve, 'POST', '/repos', { remoteUrl: 'https://github.com/eve/more' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'REPO_LIMIT' });
    });
  });

  describe('code_task', () => {
    it('lists the Bot its repositories and agents without starting anything', async () => {
      const context = await t.inOrganization(() =>
        coderContextFor(t.ownerDeps, owner(), { toolPolicy: {} }),
      );
      expect(context.repos).toEqual([
        expect.objectContaining({
          full_name: 'acme/relay',
          default_branch: 'main',
          state: 'updating',
        }),
      ]);
      expect(context.accounts.map((a) => [a.agent, a.authKind])).toEqual([
        ['claude', 'none'],
        ['codex', 'none'],
        ['pi', 'none'],
      ]);
      const narrowed = await t.inOrganization(() =>
        coderContextFor(t.ownerDeps, owner(), { toolPolicy: { coder: { allowedRepos: ['x/y'] } } }),
      );
      expect(narrowed.repos).toEqual([]);
    });

    it('asks for a sign-in when the agent is not signed in', async () => {
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'acme/relay',
          prompt: 'Fix it',
          mode: 'edit',
        }),
      );
      expect(started).toMatchObject({
        kind: 'coder_login',
        label: 'Waiting for sign-in: Claude Code',
      });
      const [message] = await t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, started.posted.messageId));
      const part = (message!.parts as MessagePart[])[0]!;
      expect(part).toMatchObject({ type: 'widget', kind: 'coder_login' });
      expect(message!.chatId).toBe(bot.chatId);
      expect((await widgetRow(message!.id)).state).toMatchObject({
        status: 'pending',
        waiting_runs: [run.id],
      });
      await until(() =>
        expect(jobs).toContainEqual({ kind: 'login', loginId: started.sessionId, workspaceId }),
      );
      await t.db.delete(schema.coderLogins);
    });

    it('posts the session widget with the run waiting, and enqueues the runner', async () => {
      await signIn('claude');
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'ACME/relay',
          prompt: 'Fix the reconnect loop in the relay',
          mode: 'pr',
        }),
      );
      expect(started).toMatchObject({
        kind: 'coding_session',
        label: 'Coding: relay with Claude Code',
        props: { agent: 'claude', repo: 'acme/relay', base: 'main', mode: 'pr' },
      });
      const row = await session(started.sessionId);
      expect(row).toMatchObject({
        status: 'queued',
        botId: bot.id,
        runId: run.id,
        chatId: bot.chatId,
        repoId,
        repoFullName: 'acme/relay',
        remoteUrl: 'https://github.com/acme/relay.git',
        base: 'main',
        mode: 'pr',
        messageId: started.posted.messageId,
        partIndex: 0,
      });
      expect(row.branch).toMatch(/^bot\/fix-the-reconnect-loop-in-[0-9a-f]{4}$/);
      const ws = await widgetRow(started.posted.messageId);
      expect(ws.pendingRunId).toBe(run.id);
      expect(ws.state).toMatchObject({ status: 'queued', feed: [], approvals: [] });
      await until(() =>
        expect(jobs).toContainEqual({ kind: 'session', sessionId: started.sessionId, workspaceId }),
      );

      // One session per Bot.
      const second = await waitingRun();
      await expect(
        t.inOrganization(async () =>
          (await services(second.id)).start({
            agent: 'claude',
            repo: 'acme/relay',
            prompt: 'Something else',
            mode: 'edit',
          }),
        ),
      ).rejects.toMatchObject({ code: 'CODER_BUSY' });
    });

    it('refuses a repository the owner has not added, and a bad branch', async () => {
      await endAll();
      const run = await waitingRun();
      const coder = await services(run.id);
      await expect(
        t.inOrganization(() =>
          coder.start({ agent: 'claude', repo: 'acme/other', prompt: 'x', mode: 'edit' }),
        ),
      ).rejects.toMatchObject({ code: 'REPO_UNKNOWN', message: expect.stringContaining('owner') });
      await expect(
        t.inOrganization(() =>
          coder.start({
            agent: 'claude',
            repo: 'acme/relay',
            prompt: 'x',
            mode: 'edit',
            branch: '-x',
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_BRANCH' });
      // Discard deletes a pushed session branch, so it is never one the repository relies on.
      for (const [branch, base] of [
        ['main', undefined],
        ['feature/x', undefined],
        ['bot/release', 'bot/release'],
      ] as const) {
        await expect(
          t.inOrganization(() =>
            coder.start({
              agent: 'claude',
              repo: 'acme/relay',
              prompt: 'x',
              mode: 'edit',
              branch,
              ...(base ? { base } : {}),
            }),
          ),
          branch,
        ).rejects.toMatchObject({ status: 400, code: 'BRANCH_NOT_ALLOWED' });
      }
      await expect(
        t.inOrganization(() =>
          coder.start({
            agent: 'claude',
            repo: 'acme/relay',
            prompt: 'x',
            mode: 'edit',
            branch: 'main',
          }),
        ),
      ).rejects.toMatchObject({ message: 'Session branches start with bot/' });
    });

    it("refuses a new session on a branch another of the owner's sessions holds", async () => {
      await endAll();
      const [other] = await t.db
        .insert(schema.codingSessions)
        .values({
          workspaceId,
          ownerId: danaId,
          botId: bot.id,
          agent: 'claude',
          repoFullName: 'acme/relay',
          branch: 'bot/taken',
          base: 'main',
          worktreePath: '/home/bot/repos/acme/relay/.worktrees/bot-taken',
          mode: 'edit',
          prompt: 'x',
          status: 'settled',
        })
        .returning();
      const run = await waitingRun();
      const coder = await services(run.id);
      const start = () =>
        t.inOrganization(() =>
          coder.start({
            agent: 'claude',
            repo: 'acme/relay',
            prompt: 'x',
            mode: 'edit',
            branch: 'bot/taken',
          }),
        );
      await expect(start()).rejects.toMatchObject({
        status: 409,
        code: 'BRANCH_IN_USE',
        message: expect.stringContaining(other!.id),
      });
      // Once that session is discarded, the branch is free on the server's side.
      await t.db
        .update(schema.codingSessions)
        .set({ worktreePath: null })
        .where(eq(schema.codingSessions.id, other!.id));
      const started = await start();
      expect((await session(started.sessionId)).branch).toBe('bot/taken');
    });

    it('continues an ended session on the same row and branch', async () => {
      await endAll();
      const [ended] = await t.db
        .update(schema.codingSessions)
        .set({
          vendorSessionId: 'vendor-1',
          worktreePath: '/home/bot/repos/acme/relay/.worktrees/w1',
        })
        .where(eq(schema.codingSessions.botId, bot.id))
        .returning();
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'codex',
          repo: 'acme/relay',
          prompt: 'Now add a test',
          mode: 'edit',
          session_id: ended!.id,
        }),
      );
      expect(started.sessionId).toBe(ended!.id);
      const row = await session(ended!.id);
      expect(row).toMatchObject({
        status: 'queued',
        prompt: 'Now add a test',
        runId: run.id,
        agent: 'claude',
        branch: ended!.branch,
        vendorSessionId: 'vendor-1',
        worktreePath: '/home/bot/repos/acme/relay/.worktrees/w1',
        messageId: started.posted.messageId,
      });
      expect(started.posted.messageId).not.toBe(ended!.messageId);
    });

    it('a continued session asks before pushing again, and still follows the repository policy', async () => {
      await endAll();
      const [ended] = await t.db
        .update(schema.codingSessions)
        .set({ pushAllowed: true })
        .where(eq(schema.codingSessions.botId, bot.id))
        .returning();
      const run = await waitingRun();
      await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'acme/relay',
          prompt: 'One more fix',
          mode: 'pr',
          session_id: ended!.id,
        }),
      );
      expect(await session(ended!.id)).toMatchObject({ status: 'queued', pushAllowed: false });

      await endAll();
      const before = (await botRow()).toolPolicy;
      await t.db
        .update(schema.bots)
        .set({ toolPolicy: { coder: { allowedRepos: ['acme/other'] } } })
        .where(eq(schema.bots.id, bot.id));
      try {
        const next = await waitingRun();
        await expect(
          t.inOrganization(async () =>
            (await services(next.id)).start({
              agent: 'claude',
              repo: 'acme/relay',
              prompt: 'Again',
              mode: 'edit',
              session_id: ended!.id,
            }),
          ),
        ).rejects.toMatchObject({ code: 'REPO_NOT_ALLOWED' });
        expect((await session(ended!.id)).status).toBe('settled');
      } finally {
        await t.db
          .update(schema.bots)
          .set({ toolPolicy: before })
          .where(eq(schema.bots.id, bot.id));
      }
    });

    it('names a branch from the first words of the prompt', () => {
      expect(sessionBranch('Fix: the relay, now!')).toMatch(/^bot\/fix-the-relay-now-[0-9a-f]{4}$/);
      expect(sessionBranch('!!!')).toMatch(/^bot\/task-[0-9a-f]{4}$/);
    });
  });

  describe('the session widget and its routes', () => {
    async function liveSession(status = 'running') {
      await endAll();
      await signIn('claude');
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'acme/relay',
          prompt: 'Fix it',
          mode: 'edit',
        }),
      );
      await t.db
        .update(schema.codingSessions)
        .set({ status })
        .where(eq(schema.codingSessions.id, started.sessionId));
      return { ...started, runId: run.id };
    }
    const act = (messageId: string, action: unknown, cookie = dana) =>
      call(cookie, 'POST', `/messages/${messageId}/widgets/0/action`, { action });

    it('keeps the run waiting through Open terminal', async () => {
      const s = await liveSession();
      expect((await act(s.posted.messageId, { type: 'open_terminal' })).status).toBe(200);
      expect((await widgetRow(s.posted.messageId)).pendingRunId).toBe(s.runId);
      expect((await runRow(s.runId)).status).toBe('waiting');
    });

    it('Stop publishes on the control channel and leaves the run to the runner', async () => {
      const s = await liveSession();
      controls.length = 0;
      const res = await call(dana, 'POST', `/coding-sessions/${s.sessionId}/stop`);
      expect(res.status).toBe(200);
      await until(() => expect(controls).toContainEqual({ type: 'stop', sessionId: s.sessionId }));
      expect((await widgetRow(s.posted.messageId)).pendingRunId).toBe(s.runId);
      expect((await widgetRow(s.posted.messageId)).state).toMatchObject({ status: 'stopped' });
      expect((await widgetRow(s.posted.messageId)).state).not.toHaveProperty('control');
      expect((await runRow(s.runId)).status).toBe('waiting');
    });

    it('Stop on a session nobody claimed yet stops it here and resumes its run', async () => {
      const s = await liveSession('queued');
      expect((await act(s.posted.messageId, { type: 'stop' })).status).toBe(200);
      expect((await session(s.sessionId)).status).toBe('stopped');
      const run = await runRow(s.runId);
      expect(run.status).toBe('queued');
      expect((run.state as RunState).resume?.output).toMatchObject({ status: 'stopped' });
    });

    it("Continue posts the owner's prompt to the Bot, which continues it with a run; Discard removes its worktree and log", async () => {
      const s = await liveSession('settled');
      await t.db
        .update(schema.widgetStates)
        .set({ state: { status: 'settled', feed: [], approvals: [], session_id: s.sessionId } })
        .where(eq(schema.widgetStates.messageId, s.posted.messageId));
      // No other run of the Bot is open in its transcript to take the message.
      await t.db
        .update(schema.runs)
        .set({ status: 'cancelled' })
        .where(and(eq(schema.runs.botId, bot.id), ne(schema.runs.id, s.runId)));
      const unhook = registerRunHooks();
      const ownerMessages = () =>
        t.db
          .select()
          .from(schema.messages)
          .where(
            and(eq(schema.messages.chatId, bot.chatId), eq(schema.messages.authorType, 'user')),
          )
          .orderBy(asc(schema.messages.seq));
      try {
        jobs.length = 0;
        // From the widget.
        expect(
          (await act(s.posted.messageId, { type: 'continue', prompt: 'And the docs' })).status,
        ).toBe(200);
        const [fromWidget] = await ownerMessages();
        expect(fromWidget).toMatchObject({
          authorId: danaId,
          threadRootId: null,
          parts: [{ type: 'text', text: `Continue coding session ${s.sessionId}: And the docs` }],
        });
        const runs = await t.db
          .select()
          .from(schema.runs)
          .where(and(eq(schema.runs.botId, bot.id), eq(schema.runs.status, 'queued')));
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ trigger: 'message', chatId: bot.chatId });
        // The row is the Bot's to reopen: same run, still ended, no job.
        expect(await session(s.sessionId)).toMatchObject({ status: 'settled', runId: s.runId });
        expect((await widgetRow(s.posted.messageId)).state).toMatchObject({ status: 'settled' });
        expect((await widgetRow(s.posted.messageId)).state).not.toHaveProperty('control');
        expect(jobs.filter((j) => j.kind === 'session')).toEqual([]);

        // From the API: the same, while the queued run takes it as steering.
        const res = await call(dana, 'POST', `/coding-sessions/${s.sessionId}/continue`, {
          prompt: 'And the changelog',
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          session: { id: s.sessionId, status: 'settled', runId: s.runId },
        });
        expect((await ownerMessages()).at(-1)!.parts).toEqual([
          { type: 'text', text: `Continue coding session ${s.sessionId}: And the changelog` },
        ]);
      } finally {
        unhook();
      }
      // Running again: Continue is refused.
      await t.db
        .update(schema.codingSessions)
        .set({ status: 'running' })
        .where(eq(schema.codingSessions.id, s.sessionId));
      expect(
        (await call(dana, 'POST', `/coding-sessions/${s.sessionId}/continue`, { prompt: 'x' }))
          .status,
      ).toBe(409);

      // The log is on the server, read while the computer may be off.
      const logPath = sessionLogPath(t.deps, s.sessionId);
      await mkdir(dirname(logPath), { recursive: true });
      await writeFile(logPath, `${'x'.repeat(10)}{"type":"done"}\n`);
      const log = await call(dana, 'GET', `/coding-sessions/${s.sessionId}/log`);
      expect(log.status).toBe(200);
      expect(await log.text()).toContain('{"type":"done"}');
      expect((await call(eve, 'GET', `/coding-sessions/${s.sessionId}/log`)).status).toBe(404);

      const worktree = '/home/bot/repos/acme/relay/.worktrees/bot-fix';
      await t.db
        .update(schema.codingSessions)
        .set({
          status: 'settled',
          worktreePath: worktree,
          vendorSessionId: '0b6f8a52-3c1e-4d7a-9f2b-5e8c1a4d7b90',
        })
        .where(eq(schema.codingSessions.id, s.sessionId));
      await t.db
        .update(schema.widgetStates)
        .set({ state: { status: 'settled', feed: [], approvals: [] } })
        .where(eq(schema.widgetStates.messageId, s.posted.messageId));

      const terminal = await call(dana, 'GET', `/coding-sessions/${s.sessionId}/terminal`);
      expect(await terminal.json()).toEqual({
        cwd: worktree,
        user: 'coder',
        preset: 'claude --resume 0b6f8a52-3c1e-4d7a-9f2b-5e8c1a4d7b90',
      });
      const before = coder.calls.length;
      const discard = await call(dana, 'POST', `/coding-sessions/${s.sessionId}/discard`);
      expect(discard.status).toBe(200);
      expect(await discard.json()).toMatchObject({ session: { worktreePath: null } });
      const sh = coder.calls.slice(before).find((c) => c.launch.command === 'sh')!;
      expect(sh.launch).toMatchObject({ user: 'coder' });
      expect(sh.launch.args).toEqual([
        '-c',
        expect.stringContaining('worktree remove --force'),
        '/home/bot/repos/acme/relay',
        worktree,
        expect.stringMatching(/^bot\//),
      ]);
      await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it("lists and reads only the owner's sessions", async () => {
      const list = (await (
        await call(dana, 'GET', `/coding-sessions?botId=${bot.id}&limit=5`)
      ).json()) as {
        sessions: { id: string; botId: string; changedFiles: unknown[]; createdAt: string }[];
      };
      expect(list.sessions.length).toBeGreaterThan(0);
      expect(list.sessions[0]).toMatchObject({ botId: bot.id, changedFiles: [], commits: [] });
      const id = list.sessions[0]!.id;
      expect((await call(dana, 'GET', `/coding-sessions/${id}`)).status).toBe(200);
      expect((await call(eve, 'GET', `/coding-sessions/${id}`)).status).toBe(404);
      expect((await call(eve, 'POST', `/coding-sessions/${id}/stop`)).status).toBe(404);
      expect(
        ((await (await call(eve, 'GET', '/coding-sessions')).json()) as { sessions: unknown[] })
          .sessions,
      ).toEqual([]);
      expect((await call('', 'GET', '/coding-sessions')).status).toBe(401);
    });
  });

  describe("the drawer: a session's transcript and the owner's own turns", () => {
    /** A session `code_task` started, now ended, with its prompt in the transcript. */
    async function endedSession(status = 'settled') {
      await endAll();
      await signIn('claude');
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'acme/relay',
          prompt: 'Fix the reconnect loop\nIt spins when the relay is down',
          mode: 'edit',
        }),
      );
      await t.db
        .update(schema.codingSessions)
        .set({ status, finishedAt: new Date() })
        .where(eq(schema.codingSessions.id, started.sessionId));
      await t.db
        .update(schema.widgetStates)
        .set({
          state: {
            status,
            feed: [],
            approvals: [],
            finished_at: new Date().toISOString(),
            error: 'Earlier error',
          },
          pendingRunId: null,
        })
        .where(eq(schema.widgetStates.messageId, started.posted.messageId));
      return { ...started, runId: run.id };
    }
    const turn = (sessionId: string, prompt: string, cookie = dana) =>
      call(cookie, 'POST', `/coding-sessions/${sessionId}/turns`, { prompt });
    const entries = async (sessionId: string, query = '') => {
      const res = await call(dana, 'GET', `/coding-sessions/${sessionId}/events${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { entries: CodingSessionEntry[]; hasMore: boolean };
    };

    it('pages the transcript after a seq, and names the session from its first prompt', async () => {
      const s = await endedSession();
      await t.inOrganization(async () => {
        for (const text of ['One', 'Two', 'Three']) {
          await recordEntry(t.ownerDeps, s.sessionId, { type: 'text', text });
        }
      });
      const first = await entries(s.sessionId, '?limit=2');
      expect(first.hasMore).toBe(true);
      expect(first.entries.map((e) => [e.seq, e.turn, e.event])).toEqual([
        [
          1,
          1,
          {
            type: 'prompt',
            text: 'Fix the reconnect loop\nIt spins when the relay is down',
            by: 'bot',
          },
        ],
        [2, 1, { type: 'text', text: 'One' }],
      ]);
      const rest = await entries(s.sessionId, '?after=2&limit=2');
      expect(rest).toMatchObject({ hasMore: false });
      expect(rest.entries.map((e) => e.seq)).toEqual([3, 4]);
      expect((await entries(s.sessionId)).entries).toHaveLength(4);
      expect(
        (await call(dana, 'GET', `/coding-sessions/${s.sessionId}/events?limit=501`)).status,
      ).toBe(400);
      expect((await call(eve, 'GET', `/coding-sessions/${s.sessionId}/events`)).status).toBe(404);

      const list = (await (await call(dana, 'GET', '/coding-sessions?limit=100')).json()) as {
        sessions: { id: string; title: string }[];
      };
      expect(list.sessions.find((x) => x.id === s.sessionId)?.title).toBe('Fix the reconnect loop');
    });

    it("queues the owner's prompt straight to the agent, with no run", async () => {
      const s = await endedSession();
      jobs.length = 0;
      events.length = 0;
      const res = await turn(s.sessionId, '  And the docs  ');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        session: {
          id: s.sessionId,
          status: 'queued',
          runId: null,
          title: 'Fix the reconnect loop',
        },
      });
      expect(await session(s.sessionId)).toMatchObject({
        status: 'queued',
        prompt: 'And the docs',
        runId: null,
        pushAllowed: false,
        error: null,
        finishedAt: null,
      });
      await until(() =>
        expect(jobs).toContainEqual({ kind: 'session', sessionId: s.sessionId, workspaceId }),
      );
      const { entries: all } = await entries(s.sessionId);
      expect(all.at(-1)).toMatchObject({
        seq: 2,
        turn: 2,
        event: { type: 'prompt', text: 'And the docs', by: 'owner' },
      });
      // The chat card follows: queued again, without the last turn's end.
      const state = (await widgetRow(s.posted.messageId)).state as Record<string, unknown>;
      expect(state).toMatchObject({ status: 'queued' });
      expect(state).not.toHaveProperty('finished_at');
      expect(state).not.toHaveProperty('error');
      expect((state.feed as { text: string }[]).at(-1)!.text).toBe('Continue: And the docs');
      // The prompt reaches the owner before the session's new status.
      const mine = events.filter(
        (e) => e.type === 'coding_session.events' || e.type === 'coding_session.updated',
      );
      expect(mine.map((e) => e.type)).toEqual(['coding_session.events', 'coding_session.updated']);
      expect(mine[1]).toMatchObject({
        user_id: danaId,
        workspace_id: workspaceId,
        payload: { session: { id: s.sessionId, status: 'queued', runId: null } },
      });
      // The earlier run was not resumed by this turn.
      expect((await runRow(s.runId)).status).toBe('waiting');

      // Live again: the next turn waits for this one.
      const again = await turn(s.sessionId, 'More');
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: 'SESSION_RUNNING' });
      expect((await turn(s.sessionId, 'x', eve)).status).toBe(404);
      expect((await turn(s.sessionId, '   ')).status).toBe(400);
    });

    it('stages owner attachments outside the worktree and rejects foreign or non-attachment files', async () => {
      const s = await endedSession();
      const owner = { id: danaId, workspaceId };
      const upload = (id: string, purpose: 'attachment' | 'artifact' = 'attachment') =>
        t.inOrganization(() =>
          storeFile(
            t.ownerDeps,
            { ...owner, id },
            {
              name: 'notes.txt',
              bytes: Buffer.from('reference text'),
              declaredMime: 'text/plain',
              purpose,
            },
          ),
        );
      const foreign = await upload(await t.userId('eve@example.com'));
      const own = await upload(danaId);
      const artifact = await upload(danaId, 'artifact');
      const post = (ids: string[]) =>
        call(dana, 'POST', `/coding-sessions/${s.sessionId}/turns`, {
          prompt: 'Use the reference',
          attachments: ids,
        });
      expect((await post([foreign.id])).status).toBe(404);
      expect((await post([artifact.id])).status).toBe(404);
      expect((await session(s.sessionId)).status).toBe('settled');
      expect((await post(Array(11).fill(own.id))).status).toBe(400);
      expect((await post([own.id, own.id])).status).toBe(200);
      const queued = await session(s.sessionId);
      expect(queued.prompt).toContain('Attached reference files');
      expect(queued.prompt).toContain(own.id);
      const staged = [...computer.agent.files.entries()].filter(([path]) => path.includes(own.id));
      expect(staged).toHaveLength(1);
      expect(staged[0]![0]).toMatch(/repos\/\.openbots-attachments-[^/]+\//);
      expect(Buffer.from(staged[0]![1]).toString()).toBe('reference text');
      const all = await entries(s.sessionId);
      expect(all.entries.at(-1)?.event).toMatchObject({
        type: 'prompt',
        text: queued.prompt,
        by: 'owner',
      });
    });

    it('refuses a turn while the Bot runs another session, or codes no more, or the agent is signed out', async () => {
      const s = await endedSession();
      const [other] = await t.db
        .insert(schema.codingSessions)
        .values({
          workspaceId,
          ownerId: danaId,
          botId: bot.id,
          agent: 'claude',
          repoId,
          repoFullName: 'acme/relay',
          mode: 'edit',
          prompt: 'Something else',
          status: 'running',
        })
        .returning();
      const busy = await turn(s.sessionId, 'And the docs');
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ code: 'CODER_BUSY' });
      await t.db
        .update(schema.codingSessions)
        .set({ status: 'settled' })
        .where(eq(schema.codingSessions.id, other!.id));

      const policy = (await botRow()).toolPolicy;
      await t.db
        .update(schema.bots)
        .set({ toolPolicy: { ...(policy as object), coder: { enabled: false } } })
        .where(eq(schema.bots.id, bot.id));
      try {
        const off = await turn(s.sessionId, 'And the docs');
        expect(off.status).toBe(403);
        expect(await off.json()).toMatchObject({ code: 'CODER_DISABLED' });
      } finally {
        await t.db
          .update(schema.bots)
          .set({ toolPolicy: policy })
          .where(eq(schema.bots.id, bot.id));
      }

      await t.db
        .update(schema.coderAccounts)
        .set({ authKind: 'none' })
        .where(eq(schema.coderAccounts.ownerId, danaId));
      const signedOut = await turn(s.sessionId, 'And the docs');
      expect(signedOut.status).toBe(409);
      expect(await signedOut.json()).toMatchObject({ code: 'NEEDS_LOGIN' });
      await signIn('claude');

      await t.db
        .update(schema.codingSessions)
        .set({ repoId: null })
        .where(eq(schema.codingSessions.id, s.sessionId));
      const forgotten = await turn(s.sessionId, 'And the docs');
      expect(forgotten.status).toBe(409);
      expect(await forgotten.json()).toMatchObject({ code: 'REPO_FORGOTTEN' });
      expect((await session(s.sessionId)).status).toBe('settled');
    });
  });

  describe('Settings > Coding agents', () => {
    it('lists every agent, reading the CLI version once while the computer runs', async () => {
      const list = async () => {
        const res = await call(dana, 'GET', '/coders');
        expect(res.status).toBe(200);
        return ((await res.json()) as { agents: Record<string, unknown>[] }).agents;
      };
      const versionCalls = () => coder.calls.filter((c) => c.launch.args?.includes('--version'));
      coder.agent = (io) => {
        if (io.call.launch.args?.includes('--version')) {
          const command = io.call.launch.command;
          io.stdout(
            command === 'claude'
              ? '2.1.0 (Claude Code)\n'
              : command === 'codex'
                ? 'codex-cli 0.166.0\n'
                : 'fake-pi 1.0.0\n',
          );
        }
        io.exit(0);
      };
      const computerStatus = async (status?: string) => {
        if (status) {
          await t.db
            .update(schema.computers)
            .set({ status })
            .where(eq(schema.computers.ownerId, danaId));
        }
        return (
          await t.db.select().from(schema.computers).where(eq(schema.computers.ownerId, danaId))
        )[0]!.status;
      };

      // Off: no version is read, and the computer is not started for it.
      const before = versionCalls().length;
      await computerStatus('stopped');
      expect((await list())[0]).toMatchObject({ agent: 'claude', version: null });
      expect(versionCalls()).toHaveLength(before);
      expect(await computerStatus()).toBe('stopped');
      await computerStatus('running');

      const agents = await list();
      expect(agents.map((a) => a.agent)).toEqual(['claude', 'codex', 'pi']);
      expect(agents[0]).toEqual({
        agent: 'claude',
        label: 'Claude Code',
        authKind: 'subscription',
        accountLabel: null,
        signedInAt: null,
        version: '2.1.0 (Claude Code)',
        lastError: null,
        lastErrorKind: null,
        providerId: null,
        available: true,
        needsSignIn: false,
        planProvider: 'anthropic',
        checkAvailable: true,
        signIn: 'link',
      });
      expect(agents[1]).toMatchObject({
        agent: 'codex',
        authKind: 'none',
        available: true,
        version: 'codex-cli 0.166.0',
        needsSignIn: true,
      });
      expect(agents[2]).toMatchObject({ agent: 'pi', version: 'fake-pi 1.0.0' });
      expect(
        versionCalls()
          .slice(before)
          .map((c) => [c.launch.command, c.launch.user]),
      ).toEqual([
        ['claude', 'coder'],
        ['codex', 'coder'],
        ['fake-pi', 'coder'],
      ]);
      const [stored] = await t.db
        .select()
        .from(schema.coderAccounts)
        .where(
          and(eq(schema.coderAccounts.ownerId, danaId), eq(schema.coderAccounts.agent, 'claude')),
        );
      expect(stored!.version).toBe('2.1.0 (Claude Code)');
      // Once: a second read runs nothing.
      await list();
      expect(versionCalls()).toHaveLength(before + 3);
      expect((await call('', 'GET', '/coders')).status).toBe(401);
    });

    it('asks to sign in again when the sign-in lapsed on the computer', async () => {
      await t.db
        .update(schema.coderAccounts)
        .set({ lastError: 'Claude Code is not signed in on the computer' })
        .where(
          and(eq(schema.coderAccounts.ownerId, danaId), eq(schema.coderAccounts.agent, 'claude')),
        );
      const { agents } = (await (await call(dana, 'GET', '/coders')).json()) as {
        agents: Record<string, unknown>[];
      };
      expect(agents[0]).toMatchObject({ authKind: 'subscription', needsSignIn: true });
      await t.db
        .update(schema.coderAccounts)
        .set({ lastError: null })
        .where(
          and(eq(schema.coderAccounts.ownerId, danaId), eq(schema.coderAccounts.agent, 'claude')),
        );
    });

    it("uses a provider's key, but not another owner's provider", async () => {
      // The test provider speaks the OpenAI protocol: Codex can use it, Claude Code cannot.
      const providerId = await t.providerId();
      expect((await call(dana, 'PUT', '/coders/claude/api-key', { providerId })).status).toBe(400);
      const res = await call(dana, 'PUT', '/coders/codex/api-key', { providerId });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ account: { authKind: 'api_key', providerId } });
      const own = await call(eve, 'POST', '/providers', {
        name: 'Eve Provider',
        protocol: 'openai_compatible',
        baseUrl: 'https://203.0.113.22/v1',
        apiKey: 'eve-key-0123456789',
        scope: 'account',
        models: [{ modelId: 'm' }],
      });
      expect(own.status).toBe(201);
      const eveProvider = ((await own.json()) as { id: string }).id;
      expect(
        (await call(dana, 'PUT', '/coders/codex/api-key', { providerId: eveProvider })).status,
      ).toBe(404);
      await t.db
        .delete(schema.coderAccounts)
        .where(
          and(eq(schema.coderAccounts.ownerId, danaId), eq(schema.coderAccounts.agent, 'codex')),
        );
    });

    it('signs out by emptying the config directory on the computer as coder', async () => {
      const before = coder.calls.length;
      const res = await call(dana, 'POST', '/coders/claude/sign-out');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ account: { authKind: 'none', providerId: null } });
      const clear = coder.calls.slice(before).find((c) => c.launch.command === 'node')!;
      expect(clear.launch).toMatchObject({ user: 'coder' });
      expect(clear.launch.args).toEqual([
        expect.stringMatching(/subscription-sign-out\.js$/),
        'claude',
      ]);
    });

    it('drives a sign-in: link, pasted code, signed in, and every waiting run resumed', async () => {
      await endAll();
      const first = await waitingRun();
      const second = await waitingRun();
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: first.id }),
      );
      const joined = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: second.id }),
      );
      expect(joined.login.id).toBe(asked.login.id);
      expect(joined.posted).toEqual(asked.posted);
      const messageId = asked.posted!.messageId;
      expect((await widgetRow(messageId)).state).toMatchObject({
        waiting_runs: [first.id, second.id],
      });

      coder.agent = async (io) => {
        if (io.call.launch.args?.includes('--version')) {
          io.stdout('fake-pi 1.2.3\n');
          io.exit(0);
          return;
        }
        io.stdout('\x1b[1mOpen https://pi.example/auth?state=abc\x1b[0m\r\n');
        io.stdout('Paste the code here: ');
        await until(() => expect(io.call.writes.join('')).toContain('good-code'));
        io.stdout('good-code\r\nSigned in as dan@example.com\r\n');
        io.exit(0);
      };
      const driving = t.inOrganization(() => runCoderLogin(t.deps, asked.login.id));
      const loginPath = `/coders/pi/login/${asked.login.id}`;
      await until(async () => {
        const { login } = (await (await call(dana, 'GET', loginPath)).json()) as {
          login: { status: string; url: string | null };
        };
        expect(login).toMatchObject({
          status: 'awaiting_code',
          url: 'https://pi.example/auth?state=abc',
        });
      });
      const launch = coder.calls.at(-1)!.launch;
      expect(launch).toMatchObject({
        session_id: asked.login.id,
        user: 'coder',
        pty: true,
        command: 'fake-pi',
        args: ['login'],
        git_credentials: false,
        env: { PI_CODING_AGENT_DIR: '/var/lib/openbots/coders/pi' },
      });
      expect((await call(eve, 'GET', loginPath)).status).toBe(404);
      expect((await call(dana, 'POST', `${loginPath}/code`, { code: 'good-code' })).status).toBe(
        200,
      );
      await driving;

      const { login } = (await (await call(dana, 'GET', loginPath)).json()) as {
        login: Record<string, unknown>;
      };
      expect(login).toMatchObject({ status: 'signed_in', accountLabel: 'dan@example.com' });
      expect(JSON.stringify(login)).not.toContain('good-code');
      const [account] = await t.db
        .select()
        .from(schema.coderAccounts)
        .where(and(eq(schema.coderAccounts.ownerId, danaId), eq(schema.coderAccounts.agent, 'pi')));
      expect(account).toMatchObject({
        authKind: 'subscription',
        accountLabel: 'dan@example.com',
        version: 'fake-pi 1.2.3',
        lastError: null,
      });
      expect((await widgetRow(messageId)).state).toMatchObject({
        status: 'signed_in',
        url: 'https://pi.example/auth?state=abc',
      });
      for (const run of [first, second]) {
        const row = await runRow(run.id);
        expect(row.status).toBe('queued');
        expect((row.state as RunState).resume?.output).toMatchObject({ signed_in: true });
      }
    });

    it("Can't sign in from the widget ends the sign-in and tells the waiting run", async () => {
      await t.db.delete(schema.coderAccounts).where(eq(schema.coderAccounts.agent, 'pi'));
      const run = await waitingRun();
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: run.id }),
      );
      controls.length = 0;
      const res = await call(
        dana,
        'POST',
        `/messages/${asked.posted!.messageId}/widgets/0/action`,
        {
          action: { type: 'cant' },
        },
      );
      expect(res.status).toBe(200);
      const [row] = await t.db
        .select()
        .from(schema.coderLogins)
        .where(eq(schema.coderLogins.id, asked.login.id));
      expect(row!.status).toBe('failed');
      await until(() =>
        expect(controls).toContainEqual({ type: 'stop', sessionId: asked.login.id }),
      );
      const resumed = await runRow(run.id);
      expect(resumed.status).toBe('queued');
      expect((resumed.state as RunState).resume?.output).toMatchObject({ signed_in: false });
      // No widget_action run starts for it.
      const runs = await t.db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.botId, bot.id), eq(schema.runs.trigger, 'widget_action')))
        .orderBy(asc(schema.runs.createdAt));
      expect(runs).toEqual([]);
    });
  });

  describe('sign-in links and the runs waiting on them', () => {
    const resetPi = async () => {
      await t.db.delete(schema.coderAccounts).where(eq(schema.coderAccounts.agent, 'pi'));
      await t.db.delete(schema.coderLogins);
    };
    const loginRow = async (id: string) =>
      (await t.db.select().from(schema.coderLogins).where(eq(schema.coderLogins.id, id)))[0]!;

    it('keeps the link on the row and the widget while the code is checked', async () => {
      await resetPi();
      const run = await waitingRun();
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: run.id }),
      );
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      coder.agent = async (io) => {
        if (io.call.launch.args?.includes('--version')) return io.exit(0);
        io.stdout('Open https://pi.example/auth?state=xyz\r\nPaste the code here: ');
        await until(() => expect(io.call.writes.join('')).toContain('good-code'));
        await released;
        io.stdout('Signed in as dan@example.com\r\n');
        io.exit(0);
      };
      const driving = t.inOrganization(() => runCoderLogin(t.deps, asked.login.id));
      const messageId = asked.posted!.messageId;
      await until(async () =>
        expect((await widgetRow(messageId)).state).toMatchObject({ status: 'awaiting_code' }),
      );
      const act = await call(dana, 'POST', `/messages/${messageId}/widgets/0/action`, {
        action: { type: 'code', code: 'good-code' },
      });
      expect(act.status).toBe(200);
      await until(async () => expect(coder.calls.at(-1)!.writes.join('')).toContain('good-code'));
      expect(await loginRow(asked.login.id)).toMatchObject({
        status: 'awaiting_code',
        url: 'https://pi.example/auth?state=xyz',
      });
      expect((await widgetRow(messageId)).state).toMatchObject({
        status: 'awaiting_code',
        url: 'https://pi.example/auth?state=xyz',
        code_submitted: true,
      });
      const { login } = (await (
        await call(dana, 'GET', `/coders/pi/login/${asked.login.id}`)
      ).json()) as { login: Record<string, unknown> };
      expect(login).toMatchObject({
        status: 'awaiting_code',
        url: 'https://pi.example/auth?state=xyz',
      });
      release();
      await driving;
      expect((await loginRow(asked.login.id)).status).toBe('signed_in');
    });

    it('never shows a link on a host the agent does not sign in on', async () => {
      await resetPi();
      const run = await waitingRun();
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: run.id }),
      );
      coder.agent = async (io) => {
        if (io.call.launch.args?.includes('--version')) return io.exit(0);
        io.stdout('Open https://pi.example.evil.test/auth\r\n');
        await io.signalled();
      };
      await t.inOrganization(() => runCoderLogin(t.deps, asked.login.id));
      const row = await loginRow(asked.login.id);
      expect(row).toMatchObject({ status: 'failed', url: null, error: UNEXPECTED_LOGIN_HOST });
      const state = (await widgetRow(asked.posted!.messageId)).state as Record<string, unknown>;
      expect(state).toMatchObject({ status: 'failed', error: UNEXPECTED_LOGIN_HOST });
      expect(state).not.toHaveProperty('url');
      expect((await runRow(run.id)).status).toBe('queued');
    });

    it('resumes a run that had not paused yet when the sign-in ended, once it pauses', async () => {
      await resetPi();
      // The run asked for the sign-in and is still running toward its pause.
      const [run] = await t.db
        .insert(schema.runs)
        .values({
          workspaceId,
          botId: bot.id,
          chatId: bot.chatId,
          trigger: 'message',
          status: 'running',
        })
        .returning();
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', { botId: bot.id, runId: run!.id }),
      );
      coder.agent = (io) => {
        if (!io.call.launch.args?.includes('--version')) {
          io.stdout('Open https://pi.example/auth\r\nSigned in as dan@example.com\r\n');
        }
        io.exit(0);
      };
      const driving = t.inOrganization(() => runCoderLogin(t.deps, asked.login.id));
      const messageId = asked.posted!.messageId;
      await until(async () =>
        expect((await widgetRow(messageId)).state).toMatchObject({ status: 'signed_in' }),
      );
      expect((await runRow(run!.id)).status).toBe('running');
      // Now it pauses, with the needs_login result it would otherwise resume on.
      await t.db
        .update(schema.runs)
        .set({
          status: 'waiting',
          state: {
            version: 1,
            messages: [],
            pending: { reason: 'widget', toolCallId: 'call-1', toolName: 'code_task', args: {} },
          },
        })
        .where(eq(schema.runs.id, run!.id));
      await driving;
      const row = await runRow(run!.id);
      expect(row.status).toBe('queued');
      expect((row.state as RunState).resume?.output).toEqual(
        widgetToolResult('coder_login', (await widgetRow(messageId)).state),
      );
      expect((row.state as RunState).resume?.output).toMatchObject({ signed_in: true });
    });

    it('moves a run waiting on its session widget to the sign-in, and resumes it once signed in', async () => {
      await resetPi();
      await endAll();
      await signIn('claude');
      // The session's run, paused on the coding_session widget as code_task leaves it.
      const run = await waitingRun();
      const started = await t.inOrganization(async () =>
        (await services(run.id)).start({
          agent: 'claude',
          repo: 'acme/relay',
          prompt: 'Fix it',
          mode: 'edit',
        }),
      );
      const pendingOn = (posted: { messageId: string; partIndex: number }, kind: string) => ({
        version: 1,
        messages: [],
        pending: {
          reason: 'widget',
          toolCallId: 'call-1',
          toolName: 'code_task',
          args: {},
          widget: { kind, props: started.props },
          label: started.label,
          ...posted,
          posted,
        },
      });
      await t.db
        .update(schema.runs)
        .set({ state: pendingOn(started.posted, 'coding_session') })
        .where(eq(schema.runs.id, run.id));
      // A second run still running when the runner asks; it pauses on its session widget after.
      const [late] = await t.db
        .insert(schema.runs)
        .values({
          workspaceId,
          botId: bot.id,
          chatId: bot.chatId,
          trigger: 'message',
          status: 'running',
        })
        .returning();

      // The runner finds the agent signed out.
      const asked = await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', {
          botId: bot.id,
          runId: run.id,
          chatId: bot.chatId,
        }),
      );
      await t.inOrganization(() =>
        startLogin(t.ownerDeps, owner(), 'pi', {
          botId: bot.id,
          runId: late!.id,
          chatId: bot.chatId,
        }),
      );
      const loginAt = asked.posted!;
      expect((await widgetRow(loginAt.messageId)).state).toMatchObject({
        waiting_runs: [run.id, late!.id],
      });
      const moved = (await runRow(run.id)).state as RunState;
      expect(moved.pending).toMatchObject({
        widget: { kind: 'coder_login' },
        messageId: loginAt.messageId,
        partIndex: 0,
        label: 'Waiting for sign-in: pi',
      });
      expect((await widgetRow(started.posted.messageId)).pendingRunId).toBeNull();

      // The late run pauses on the session widget: it waits on the sign-in instead.
      await t.db
        .update(schema.runs)
        .set({ status: 'waiting', state: pendingOn(started.posted, 'coding_session') })
        .where(eq(schema.runs.id, late!.id));
      await t.inOrganization(() =>
        resumeIfCoderWidgetDone(t.ownerDeps, late!.id, started.posted, 'coding_session'),
      );
      expect(((await runRow(late!.id)).state as RunState).pending).toMatchObject({
        widget: { kind: 'coder_login' },
        messageId: loginAt.messageId,
      });
      expect((await runRow(late!.id)).status).toBe('waiting');

      coder.agent = (io) => {
        if (!io.call.launch.args?.includes('--version')) {
          io.stdout('Open https://pi.example/auth\r\nSigned in as dan@example.com\r\n');
        }
        io.exit(0);
      };
      await t.inOrganization(() => runCoderLogin(t.deps, asked.login.id));
      const state = (await widgetRow(loginAt.messageId)).state;
      expect(state).toMatchObject({ status: 'signed_in' });
      for (const id of [run.id, late!.id]) {
        const row = await runRow(id);
        expect(row.status).toBe('queued');
        expect((row.state as RunState).resume?.output).toEqual(
          widgetToolResult('coder_login', state),
        );
      }
    });
  });

  describe('repositories after the clone', () => {
    it("keeps the default branch the runner found, not 'main'", async () => {
      await t.db
        .update(schema.repos)
        .set({ defaultBranch: 'trunk' })
        .where(eq(schema.repos.id, repoId));
      const repos = await t.inOrganization(() => listRepos(t.ownerDeps, owner()));
      expect(repos.find((r) => r.repo.id === repoId)!.repo.defaultBranch).toBe('trunk');
      const updated = await t.inOrganization(() => updateRepo(t.ownerDeps, owner(), repoId));
      expect(updated.repo.defaultBranch).toBe('trunk');
      const res = await call(dana, 'GET', '/repos');
      const { repos: views } = (await res.json()) as {
        repos: { id: string; defaultBranch: string }[];
      };
      expect(views.find((r) => r.id === repoId)!.defaultBranch).toBe('trunk');
      const [row] = await t.db.select().from(schema.repos).where(eq(schema.repos.id, repoId));
      expect(row!.defaultBranch).toBe('trunk');
      await t.db
        .update(schema.repos)
        .set({ defaultBranch: 'main' })
        .where(eq(schema.repos.id, repoId));
    });
  });

  describe('the terminal proxy', () => {
    it("passes cwd, user and preset only for the owner's own worktrees and checkouts", async () => {
      const worktree = '/home/bot/repos/acme/relay/.worktrees/bot-pty';
      await t.db
        .update(schema.codingSessions)
        .set({ worktreePath: worktree })
        .where(eq(schema.codingSessions.botId, bot.id));
      const params = (query: string, who = owner()) =>
        t.inOrganization(async () =>
          Object.fromEntries(await ptyParams(t.ownerDeps, who, new URLSearchParams(query))),
        );
      const q = (cwd: string, preset = 'claude --resume v') =>
        new URLSearchParams({ cols: '80', rows: '24', cwd, user: 'coder', preset }).toString();
      expect(await params(q(worktree))).toEqual({
        cols: '80',
        rows: '24',
        cwd: worktree,
        user: 'coder',
        preset: 'claude --resume v',
      });
      expect(await params(q('/home/bot/repos/acme/relay'))).toMatchObject({ user: 'coder' });
      // Anywhere else, or someone else's, opens the plain terminal.
      expect(await params(q('/var/lib/openbots'))).toEqual({ cols: '80', rows: '24' });
      expect(await params(q('relative/path'))).toEqual({ cols: '80', rows: '24' });
      const eveId = await t.userId('eve@example.com');
      expect(await params(q(worktree), { id: eveId, workspaceId })).toEqual({
        cols: '80',
        rows: '24',
      });
      expect(await params('user=coder')).toEqual({});
      // A preset too long to be a resume command is dropped.
      expect(await params(q(worktree, 'x'.repeat(501)))).not.toHaveProperty('preset');
    });
  });
});
