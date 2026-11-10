import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { FakeCoderSession } from '@openbots/computer/testing';
import {
  CODERS_QUEUE,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  EVENTS_CHANNEL,
  NEEDS_LOGIN,
  ToolPolicySchema,
  withAcceptEdits,
  type WsEvent,
} from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import {
  codexAppServer,
  coderWorld,
  defaultGit,
  defaultSystem,
  gitArgs,
  initLine,
  jsonl,
  REPO_PATH,
  resultLine,
  VENDOR_ID,
  type CoderIo,
  type CoderWorld,
} from './__fixtures__/coders/setup.js';
import { publishCoderControl } from './coder-control.js';
import { readEntries, recordEntry } from './coder-transcript.js';
import { enqueueCoderJob, type CoderJob } from './coder-jobs.js';
import {
  readSessionLog,
  removeSessionLog,
  SESSION_LOG_FULL,
  SESSION_LOG_MAX,
  sessionLogPath,
} from './coder-state.js';
import { CODEX_POSTURE, CODEX_SIGN_IN_REFUSED } from './coder-adapters/codex.js';
import { recoverInterruptedCoderSessions, RESTART_NOTE } from './coder-recovery.js';
import {
  createCoderWorker,
  keyRejectedText,
  needsLoginText,
  type CoderRunnerOptions,
} from './coder-runner.js';
import { leftoverCommitMessage } from './session-git.js';
import { FETCH_NEEDS_APP, PUSH_NEEDS_APPROVAL } from './git-credentials.js';
import { CONFIG_REFUSED } from './repos-checkout.js';
import type { RunState } from './runs.js';

// The coding session runner end to end, against a scripted `/coder` (the
// fake agent's own lands with the computer agent work): the job claims the
// session, makes the checkout and the worktree, runs the CLI, feeds the
// widget, answers prompts and credentials, settles and resumes the run.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/coders');
const WORKTREE = `${REPO_PATH}/.worktrees/bot-fix-reconnect`;

describe('coder runner', () => {
  let w: CoderWorld;
  let github: Server;
  const pulls: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const options: CoderRunnerOptions = { runWaitMs: 0, touchMs: 60_000, stopGraceMs: 20 };

  beforeAll(async () => {
    w = await coderWorld();
    github = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        pulls.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html_url: 'https://github.com/acme/relay/pull/7', number: 7 }));
      });
    });
    await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
    options.githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(createCoderWorker(w.t.deps, options), { concurrency: 4 });
    const res = await w.call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-runner-token' },
    });
    expect(res.status).toBe(201);
  });
  afterAll(async () => {
    await new Promise((resolve) => github.close(resolve));
    await w.close();
  });

  // Non-publishing tests deny publication; dedicated cases opt back into ask.
  const publishingPolicy = async (decision: 'ask' | 'deny') => {
    await w.t.db
      .update(schema.bots)
      .set({ toolPolicy: { coder: { actions: { push: decision, pr: decision } } } })
      .where(eq(schema.bots.id, w.bot.id));
  };
  beforeEach(() => publishingPolicy('deny'));
  const newPublishingSession = async (over: Parameters<CoderWorld['newSession']>[0]) => {
    await publishingPolicy('ask');
    return w.newSession(over);
  };

  const start = (sessionId: string) =>
    w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId }));

  const ended = (sessionId: string, status: string) =>
    w.until(async () => {
      const row = await w.session(sessionId);
      expect(row.status).toBe(status);
      return row;
    });

  /**
   * The output the waiting run was resumed with. The runner settles the
   * session before it resumes the run, so the run can still be waiting
   * when the session reads as ended.
   */
  const resumedWith = async (runId: string) => {
    const run = await w.until(async () => {
      const found = await w.run(runId);
      expect(found.status).toBe('queued');
      return found;
    });
    return (run.state as RunState).resume!.output as Record<string, unknown>;
  };

  it('runs a session to the end: worktree, feed, result, and the run resumed', async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId, runId } = await w.newSession();
    // As `startCodingSession` records it.
    await w.t.inOrganization(() =>
      recordEntry(w.t.deps, sessionId, {
        type: 'prompt',
        text: 'Fix the reconnect loop',
        by: 'bot',
      }),
    );
    await start(sessionId);
    const row = await ended(sessionId, 'settled');

    // The checkout was fetched with the fetch and push urls, then the worktree made.
    const git = w.coder.gitCalls();
    expect(git).toContainEqual([
      '-C',
      REPO_PATH,
      'config',
      'remote.origin.url',
      'https://fetch@github.com/acme/relay.git',
    ]);
    expect(git).toContainEqual([
      '-C',
      REPO_PATH,
      'config',
      'remote.origin.pushurl',
      'https://push@github.com/acme/relay.git',
    ]);
    expect(git).toContainEqual(['-C', REPO_PATH, 'fetch', '--prune', 'origin']);
    expect(git).toContainEqual([
      '-C',
      REPO_PATH,
      'worktree',
      'add',
      WORKTREE,
      '-b',
      'bot/fix-reconnect',
      'origin/main',
    ]);
    const [checkout] = await w.t.db
      .select()
      .from(schema.repoCheckouts)
      .where(eq(schema.repoCheckouts.repoId, w.repoId));
    // origin/main is two ahead of the local main; the .worktrees/ line is not dirt.
    expect(checkout).toMatchObject({
      path: REPO_PATH,
      state: 'behind',
      behind: 2,
      headSha: 'abc1234',
    });

    // The CLI ran as coder in the worktree, under the session's id.
    const [agent] = w.coder.agentCalls().slice(-1);
    expect(agent!.launch).toMatchObject({
      session_id: sessionId,
      user: 'coder',
      command: 'claude',
      cwd: WORKTREE,
      // git may work in the checkout and the worktree, and nowhere else another user owns.
      safe_directories: [REPO_PATH, WORKTREE],
    });
    // The permission relay waits on the owner as long as an approval lives.
    expect(agent!.launch.env?.OPENBOTS_APPROVAL_TTL_MS).toBe(String(24 * 60 * 60_000));
    // The Bot commits, as itself; the owner is credited as co-author (GH8).
    expect(agent!.launch.env).toMatchObject({
      GIT_AUTHOR_NAME: 'Relay Bot (OpenBots)',
      GIT_COMMITTER_NAME: 'Relay Bot (OpenBots)',
      GIT_AUTHOR_EMAIL: expect.stringMatching(/^[a-z0-9_-]+@openbots\.local$/),
    });
    expect(agent!.launch.env?.GIT_COMMITTER_EMAIL).toBe(agent!.launch.env?.GIT_AUTHOR_EMAIL);
    expect(agent!.launch.args?.at(-1)).toMatch(/Co-Authored-By: .+ <[^<>\s]+@[^<>\s]+>/);

    expect(row).toMatchObject({
      worktreePath: WORKTREE,
      vendorSessionId: '7f1c2a90-4b1e-4c55-9a7e-0d2f6c1b8e11',
      changedFiles: [{ path: 'src/link.ts', added: 3, removed: 1, kind: 'edit' }],
      commits: [{ sha: 'f00dfeed', title: 'Back off between relay reconnects' }],
      usage: { billed: 'subscription', output_tokens: 257 },
      error: null,
    });
    expect(row.summary).toContain('backs off');
    expect(row.finishedAt).not.toBeNull();
    expect(readFileSync(row.logPath!, 'utf8')).toContain('"type":"result"');

    const state = await w.widget(sessionId);
    expect(state.status).toBe('settled');
    expect(state.vendor_session_id).toBe('7f1c2a90-4b1e-4c55-9a7e-0d2f6c1b8e11');
    expect(state.result).toMatchObject({ branch: 'bot/fix-reconnect', base: 'main' });
    const feed = state.feed.map((l) => l.text);
    expect(feed[0]).toBe(`Started Claude Code in ${WORKTREE}`);
    expect(feed).toEqual(expect.arrayContaining(['Edited src/link.ts', '$ pnpm test']));

    const output = await resumedWith(runId);
    expect(output).toMatchObject({
      status: 'settled',
      branch: 'bot/fix-reconnect',
      commits: [{ sha: 'f00dfeed', title: 'Back off between relay reconnects' }],
    });
    // The widget no longer holds the run.
    const [ws] = await w.t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, row.messageId!));
    expect(ws!.pendingRunId).toBeNull();

    // The transcript: the prompt, the runner's note, then the agent's events in order (CA15).
    const { entries } = await readEntries(w.t.db, sessionId, { limit: 500 });
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(entries.every((e) => e.turn === 1)).toBe(true);
    expect(entries[0]!.event).toEqual({
      type: 'prompt',
      text: 'Fix the reconnect loop',
      by: 'bot',
    });
    expect(entries[1]!.event).toEqual({ type: 'text', text: `Started Claude Code in ${WORKTREE}` });
    const types = entries.map((e) => e.event.type);
    const firstText = types.indexOf('text', 2);
    const firstTool = types.indexOf('tool_use');
    expect(firstText).toBeGreaterThan(1);
    expect(firstTool).toBeGreaterThan(firstText);
    expect(types.indexOf('result')).toBeGreaterThan(firstTool);
    expect(entries.find((e) => e.event.type === 'result')!.event).toMatchObject({
      ok: true,
      summary: expect.stringContaining('backs off'),
    });
  });

  it("closes the CLI's stdin once it runs, and git's too", async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const before = w.coder.calls.length;
    const { sessionId } = await w.newSession();
    await start(sessionId);
    await ended(sessionId, 'settled');
    const calls = w.coder.calls.slice(before);
    const cli = calls.find((c) => c.launch.session_id === sessionId)!;
    // `claude -p` reads a piped stdin to its end before it starts.
    expect(cli.stdinEnded).toBe(true);
    expect(calls.filter((c) => c.launch.command === 'git').every((c) => c.stdinEnded)).toBe(true);
  });

  it('allows what the policy allows and asks the owner for the rest', async () => {
    let installAnswer: Promise<{ decision: string }> | undefined;
    let readAnswer: { decision: string } | undefined;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      // A script runner is no longer pre-allowed: it reaches the policy, `other`, auto.
      readAnswer = await io.permission('p-read', 'Bash', { command: 'pnpm run build' });
      installAnswer = io.permission('p-install', 'Bash', { command: 'pnpm add left-pad' });
      await installAnswer;
      io.stdout(jsonl(resultLine('Added left-pad')));
      io.exit(0);
    };
    const { sessionId, runId } = await w.newSession();
    await start(sessionId);

    const approval = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(row).toBeDefined();
      return row!;
    });
    expect(readAnswer).toMatchObject({ decision: 'allow' });
    expect(approval).toMatchObject({
      runId,
      toolName: 'Bash',
      actionClass: 'install',
      status: 'pending',
      reason: 'Run: pnpm add left-pad',
      args: { command: 'pnpm add left-pad' },
    });
    expect(approval.expiresAt).not.toBeNull();
    await w.until(async () => {
      expect((await w.session(sessionId)).status).toBe('waiting');
      const state = await w.widget(sessionId);
      expect(state.status).toBe('waiting');
      expect(state.approvals).toEqual([
        {
          id: approval.id,
          action_class: 'install',
          title: 'Run: pnpm add left-pad',
          status: 'pending',
        },
      ]);
    });
    // The owner's tray lists it, with its session, and deciding it answers the agent, not a run.
    const pending = await w.call('GET', '/approvals');
    expect(
      ((await pending.json()) as { items: { id: string; sessionId: string | null }[] }).items,
    ).toContainEqual(expect.objectContaining({ id: approval.id, sessionId }));
    // The transcript asks by the approval's id, which the drawer decides with.
    const asked = (await readEntries(w.t.db, sessionId, { limit: 500 })).entries.find(
      (e) => e.event.type === 'approval_request',
    );
    expect(asked?.event).toEqual({
      type: 'approval_request',
      request_id: approval.id,
      action_class: 'install',
      title: 'Run: pnpm add left-pad',
      tool_name: 'Bash',
    });
    const res = await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approval: { id: approval.id, status: 'approved' },
      resumedRunId: null,
    });
    expect(await installAnswer).toMatchObject({ decision: 'allow' });
    await ended(sessionId, 'settled');
    const state = await w.widget(sessionId);
    expect(state.approvals[0]!.status).toBe('approved');
    expect(state.feed.map((l) => l.text)).toEqual(
      expect.arrayContaining(['Allowed: Run: pnpm run build', 'The owner approved']),
    );
    expect((await resumedWith(runId)).status).toBe('settled');
    // Deciding it again is refused.
    expect(
      (await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' })).status,
    ).toBe(409);
  });

  it('serves fetch, refuses push until the owner approves, then pushes and opens the PR', async () => {
    const answers: unknown[] = [];
    const statuses: string[] = [];
    const unsubscribe = await w.t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type !== 'widget.updated') return;
      const { widget } = e.payload as { widget: { state: { status?: string } } };
      if (widget.state.status) statuses.push(widget.state.status);
    });
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      answers.push(
        await io.credential({ host: 'github.com', path: 'acme/relay.git', username: 'fetch' }),
      );
      answers.push(
        await io.credential({ host: 'github.com', path: 'acme/relay.git', username: 'push' }),
      );
      io.stdout(jsonl(resultLine('Fixed the loop.\nVerify a reconnect after a drop.')));
      io.exit(0);
    };
    const { sessionId, runId } = await newPublishingSession({ mode: 'pr' });
    await start(sessionId);
    const approval = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(
          and(eq(schema.approvals.sessionId, sessionId), eq(schema.approvals.actionClass, 'pr')),
        );
      expect(row).toBeDefined();
      return row!;
    });
    expect(answers).toEqual([
      // The connector token cannot be narrowed, so a session cannot fetch with it (GH7).
      { request_id: 'cred-1', denied: FETCH_NEEDS_APP },
      { request_id: 'cred-2', denied: PUSH_NEEDS_APPROVAL },
    ]);
    expect(approval.reason).toBe('Push and open a PR for bot/fix-reconnect');
    // Nothing was pushed before the approval.
    expect(w.coder.gitCalls().some((args) => args.includes('push'))).toBe(false);

    const res = await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    const row = await ended(sessionId, 'settled');
    expect(w.coder.gitCalls()).toContainEqual([
      '-C',
      WORKTREE,
      'push',
      'origin',
      'abc1234:refs/heads/bot/fix-reconnect',
    ]);
    expect(row).toMatchObject({
      pushAllowed: true,
      prUrl: 'https://github.com/acme/relay/pull/7',
      // What the runner pushed: the worktree's HEAD.
      pushedSha: 'abc1234',
      branchExisted: false,
    });
    expect(pulls.at(-1)).toMatchObject({
      url: '/repos/acme/relay/pulls',
      auth: 'Bearer ghp-runner-token',
      body: {
        title: 'Back off between relay reconnects',
        head: 'bot/fix-reconnect',
        base: 'main',
        body: expect.stringContaining('Opened by Relay Bot with OpenBots'),
      },
    });
    expect(await resumedWith(runId)).toMatchObject({
      pr_url: 'https://github.com/acme/relay/pull/7',
    });
    // After the approval the widget follows the row back to running before it settles.
    await unsubscribe();
    const lastWait = statuses.lastIndexOf('waiting');
    expect(statuses.slice(lastWait)).toEqual(expect.arrayContaining(['running', 'settled']));
    expect(statuses.slice(lastWait).indexOf('running')).toBeLessThan(
      statuses.slice(lastWait).indexOf('settled'),
    );
  });

  it('keeps the branch on the computer when the owner denies the PR', async () => {
    w.coder.agent = (io) => {
      io.stdout(jsonl(initLine(), resultLine('Done')));
      io.exit(0);
    };
    const { sessionId } = await newPublishingSession({ mode: 'pr' });
    await start(sessionId);
    const approval = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(row).toBeDefined();
      return row!;
    });
    const pushesBefore = w.coder.gitCalls().filter((a) => a.includes('push')).length;
    expect(
      (await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' })).status,
    ).toBe(200);
    const row = await ended(sessionId, 'settled');
    expect(row.prUrl).toBeNull();
    expect(row.pushAllowed).toBe(false);
    expect(row.summary).toContain('not approved');
    expect(w.coder.gitCalls().filter((a) => a.includes('push')).length).toBe(pushesBefore);
  });

  it('refuses the push when the session changed the checkout config, and fails', async () => {
    w.coder.agent = (io) => {
      io.stdout(jsonl(initLine(), resultLine('Done')));
      io.exit(0);
    };
    const { sessionId, runId } = await newPublishingSession({ mode: 'pr' });
    await start(sessionId);
    const approval = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(row).toBeDefined();
      return row!;
    });
    const before = w.coder.calls.length;
    // While the owner decides, the checkout's config gains a key the runner refuses.
    w.coder.git = (args) =>
      args.includes('--list')
        ? { code: 0, stdout: 'core.bare\nfalse\0core.hookspath\n/tmp/hooks\0' }
        : defaultGit(args);
    try {
      expect(
        (await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' })).status,
      ).toBe(200);
      const row = await ended(sessionId, 'failed');
      const message = `${CONFIG_REFUSED}: core.hookspath`;
      expect(row.error).toBe(message);
      const after = w.coder.calls.slice(before);
      expect(after.some((c) => gitArgs(c.launch.args).includes('push'))).toBe(false);
      // The guard's own commands ran as the runner, never as the coding agent.
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((c) => c.launch.user === 'runner')).toBe(true);
      expect(await resumedWith(runId)).toMatchObject({ status: 'failed', note: message });
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('fails with the CLI error when it exits without a result', async () => {
    w.coder.agent = (io) => {
      io.stderr('Error: something broke\n');
      io.exit(1);
    };
    const { sessionId, runId } = await w.newSession();
    await start(sessionId);
    const row = await ended(sessionId, 'failed');
    expect(row.error).toBe('Error: something broke');
    const state = await w.widget(sessionId);
    expect(state.status).toBe('failed');
    expect(state.feed.at(-1)).toMatchObject({ type: 'error', text: 'Error: something broke' });
    expect(await resumedWith(runId)).toMatchObject({
      status: 'failed',
      error: 'Error: something broke',
    });
  });

  /** The CLI is not signed in; its sign-in (`setup-token`) waits for the owner. */
  let signIn: CoderIo | null = null;
  const notSignedIn = (io: CoderIo) => {
    if (io.call.launch.args?.join(' ') === 'auth login --claudeai') {
      signIn = io;
      return;
    }
    io.stdout(readFileSync(path.join(FIXTURES, 'claude-not-logged-in.jsonl'), 'utf8'));
    io.exit(1);
  };

  it('marks the account needs_login and has the run wait on the sign-in', async () => {
    await w.t.db.insert(schema.coderAccounts).values({
      workspaceId: w.workspaceId,
      ownerId: w.ownerId,
      agent: 'claude',
      authKind: 'subscription',
    });
    w.coder.agent = notSignedIn;
    const { sessionId, runId } = await w.newSession();
    await start(sessionId);
    const row = await ended(sessionId, 'failed');
    // The row keeps the marker; the widget says what to do.
    expect(row.error).toBe(NEEDS_LOGIN);
    const state = await w.widget(sessionId);
    expect(state.error).toBe(needsLoginText('Claude Code'));
    expect(state.error).toBe(
      'Claude Code is not signed in on this computer. Sign in under Settings > Models, then ask again.',
    );
    const [account] = await w.t.db
      .select()
      .from(schema.coderAccounts)
      .where(eq(schema.coderAccounts.ownerId, w.ownerId));
    expect(account!.lastError).toContain('not signed in');
    // The sign-in is posted with the run among those waiting; the run is not resumed.
    const login = await w.until(async () => {
      const [found] = await w.t.db
        .select()
        .from(schema.coderLogins)
        .where(
          and(eq(schema.coderLogins.ownerId, w.ownerId), eq(schema.coderLogins.agent, 'claude')),
        );
      expect(found?.messageId).toBeTruthy();
      return found!;
    });
    const [loginWidget] = await w.t.db
      .select()
      .from(schema.widgetStates)
      .where(eq(schema.widgetStates.messageId, login.messageId!));
    expect((loginWidget!.state as { waiting_runs?: string[] }).waiting_runs).toContain(runId);
    expect((await w.run(runId)).status).toBe('waiting');
    // The sign-in ends (the owner gave up), so its job lets go of the worker.
    await w.until(() => expect(signIn).not.toBeNull());
    signIn!.exit(1);
  });

  it('tells the run at once when the sign-in cannot be started', async () => {
    w.coder.agent = notSignedIn;
    options.startLogin = () => Promise.reject(new Error('The computer is off'));
    try {
      const { sessionId, runId } = await w.newSession();
      await start(sessionId);
      const row = await ended(sessionId, 'failed');
      expect(row.error).toBe(NEEDS_LOGIN);
      const output = await resumedWith(runId);
      expect(output).toMatchObject({ status: 'failed', error: needsLoginText('Claude Code') });
      expect(output.note).toContain('Ask the owner to sign in');
    } finally {
      delete options.startLogin;
    }
  });

  it('asks the owner on their own turn, with no run', async () => {
    let installAnswer: Promise<{ decision: string }> | undefined;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      installAnswer = io.permission('p-install', 'Bash', { command: 'pnpm add left-pad' });
      await installAnswer;
      io.stdout(jsonl(resultLine('Added left-pad')));
      io.exit(0);
    };
    const { sessionId } = await newPublishingSession({ runId: null, mode: 'pr' });
    const pushes = () => w.coder.gitCalls().filter((args) => args.includes('push')).length;
    const pushesBefore = pushes();
    const requested: WsEvent[] = [];
    const unsubscribe = await w.t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type === 'approval.requested') requested.push(e);
    });
    try {
      await start(sessionId);
      const pending = (actionClass: string) =>
        w.until(async () => {
          const [row] = await w.t.db
            .select()
            .from(schema.approvals)
            .where(
              and(
                eq(schema.approvals.sessionId, sessionId),
                eq(schema.approvals.actionClass, actionClass),
              ),
            );
          expect(row).toBeDefined();
          return row!;
        });
      const install = await pending('install');
      expect(install).toMatchObject({ runId: null, sessionId, status: 'pending' });
      await w.until(async () => {
        const state = await w.widget(sessionId);
        expect(state.approvals).toContainEqual({
          id: install.id,
          action_class: 'install',
          title: 'Run: pnpm add left-pad',
          status: 'pending',
        });
      });
      const asked = (await readEntries(w.t.db, sessionId, { limit: 500 })).entries.find(
        (e) => e.event.type === 'approval_request',
      );
      expect(asked?.event).toMatchObject({ type: 'approval_request', request_id: install.id });
      // With no run, the event is scoped to the session's Bot and its owner.
      await w.until(() =>
        expect(
          requested.find(
            (e) => (e.payload as { approval: { id: string } }).approval.id === install.id,
          ),
        ).toMatchObject({
          user_id: w.ownerId,
          workspace_id: w.workspaceId,
          bot_id: expect.any(String),
        }),
      );
      // The decision reaches the agent over the control channel.
      const res = await w.call('POST', `/approvals/${install.id}/decide`, { decision: 'approve' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ approval: { runId: null }, resumedRunId: null });
      expect(await installAnswer).toMatchObject({ decision: 'allow' });

      // `pr` mode asks again before the push, and pushes after the approval.
      const pr = await pending('pr');
      expect(pr.runId).toBeNull();
      // Nothing was pushed before the approval.
      expect(pushes()).toBe(pushesBefore);
      expect(
        (await w.call('POST', `/approvals/${pr.id}/decide`, { decision: 'approve' })).status,
      ).toBe(200);
      const row = await ended(sessionId, 'settled');
      expect(pushes()).toBe(pushesBefore + 1);
      expect(w.coder.gitCalls()).toContainEqual([
        '-C',
        WORKTREE,
        'push',
        'origin',
        'abc1234:refs/heads/bot/fix-reconnect',
      ]);
      expect(row).toMatchObject({
        runId: null,
        pushAllowed: true,
        prUrl: 'https://github.com/acme/relay/pull/7',
      });
    } finally {
      await unsubscribe();
    }
  });

  it("fails an owner's turn that finds the agent signed out, without a sign-in", async () => {
    w.coder.agent = notSignedIn;
    let asked = false;
    options.startLogin = async () => {
      asked = true;
      throw new Error('not expected');
    };
    try {
      const { sessionId } = await w.newSession({ runId: null });
      await start(sessionId);
      const row = await ended(sessionId, 'failed');
      expect(row.error).toBe(NEEDS_LOGIN);
      expect((await w.widget(sessionId)).error).toBe(needsLoginText('Claude Code'));
      expect(asked).toBe(false);
    } finally {
      delete options.startLogin;
    }
  });

  it('fails with the reason when the repository is gone', async () => {
    const { sessionId, runId } = await w.newSession({ repoId: null });
    await start(sessionId);
    const row = await ended(sessionId, 'failed');
    expect(row.error).toContain('no longer remembered');
    expect((await resumedWith(runId)).status).toBe('failed');
  });

  it('stops when the owner says stop', async () => {
    w.coder.agent = async (io) => {
      io.stdout(
        jsonl(initLine(), {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Working' }] },
        }),
      );
      const signal = await io.signalled();
      expect(signal).toBe('SIGTERM');
      io.exit(null, 'SIGTERM');
    };
    const { sessionId, runId } = await w.newSession();
    await start(sessionId);
    await w.until(async () => expect((await w.session(sessionId)).status).toBe('running'));
    await w.until(() => expect(w.coder.agentCalls().at(-1)?.launch.session_id).toBe(sessionId));
    await publishCoderControl(w.t.deps, { type: 'stop', sessionId });
    await ended(sessionId, 'stopped');
    expect((await w.widget(sessionId)).status).toBe('stopped');
    expect((await resumedWith(runId)).status).toBe('stopped');
  });

  it('fails sessions an interrupted process left behind, and queues the queued ones again', async () => {
    const { sessionId, runId } = await w.newSession({ status: 'running' });
    const recovered = await w.t.inOrganization(() => recoverInterruptedCoderSessions(w.t.deps));
    expect(recovered).toBeGreaterThanOrEqual(1);
    const row = await w.session(sessionId);
    expect(row).toMatchObject({ status: 'failed', error: RESTART_NOTE });
    expect(await resumedWith(runId)).toMatchObject({ status: 'failed', error: RESTART_NOTE });
    // A job for a session no worker runs any more does the same.
    const second = await w.newSession({ status: 'waiting' });
    await start(second.sessionId);
    await ended(second.sessionId, 'failed');
  });

  it('applies a decision that arrives while the request is still being announced', async () => {
    let answer: Promise<{ decision: string }> | undefined;
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      answer = io.permission('p-early', 'Bash', { command: 'pnpm add left-pad' });
      await answer;
      io.stdout(jsonl(resultLine('Added it')));
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    // The decision comes the moment `approval.requested` is out, before the
    // runner's askOwner has returned.
    const unsubscribe = await w.t.deps.infra.bus.subscribe<WsEvent>(EVENTS_CHANNEL, (e) => {
      if (e.type !== 'approval.requested') return;
      const { approval } = e.payload as { approval: { id: string } };
      void publishCoderControl(w.t.deps, {
        type: 'approval',
        sessionId,
        approvalId: approval.id,
        decision: 'approved',
      });
    });
    try {
      await start(sessionId);
      await w.until(() => expect(answer).toBeDefined());
      expect(await answer).toMatchObject({ decision: 'allow' });
      await ended(sessionId, 'settled');
    } finally {
      await unsubscribe();
    }
  });

  it('expires the requests still pending when the session ends', async () => {
    w.coder.agent = (io) => {
      io.stdout(jsonl(initLine(), resultLine('Done')));
      io.exit(0);
    };
    const { sessionId } = await newPublishingSession({ mode: 'pr' });
    await start(sessionId);
    const approval = await w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(row).toBeDefined();
      return row!;
    });
    // Stop while the pull request waits on the owner.
    await publishCoderControl(w.t.deps, { type: 'stop', sessionId });
    await ended(sessionId, 'stopped');
    const [after] = await w.t.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval.id));
    expect(after!.status).toBe('expired');
    const pending = (await (await w.call('GET', '/approvals')).json()) as {
      items: { id: string }[];
    };
    expect(pending.items.map((i) => i.id)).not.toContain(approval.id);
    const [audited] = await w.t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetId, approval.id),
          eq(schema.auditLog.action, 'approval.expired'),
        ),
      );
    expect(audited).toBeDefined();
  });

  it('caps the session log on the server with one marker line', async () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession();
    const file = sessionLogPath(w.t.deps, sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'x'.repeat(SESSION_LOG_MAX - 600));
    await start(sessionId);
    await ended(sessionId, 'settled');
    const { size } = await stat(file);
    expect(size).toBeLessThanOrEqual(SESSION_LOG_MAX + SESSION_LOG_FULL.length + 1);
    const tail = await readSessionLog(w.t.deps, { id: sessionId }, 2_000);
    expect(tail.endsWith(`${SESSION_LOG_FULL}\n`)).toBe(true);
    expect(tail.split(SESSION_LOG_FULL)).toHaveLength(2);
    await removeSessionLog(w.t.deps, { id: sessionId });
  });

  it('removes logs whose session is gone at recovery', async () => {
    const orphan = sessionLogPath(w.t.deps, '0badc0de-0000-4000-8000-000000000999');
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, 'left behind\n');
    await w.t.inOrganization(() => recoverInterruptedCoderSessions(w.t.deps));
    await expect(stat(orphan)).rejects.toThrow();
  });

  it('holds the account to its concurrent sessions, counting and claiming under one lock', async () => {
    w.coder.agent = async (io) => {
      io.stdout(jsonl(initLine()));
      await io.signalled();
      io.exit(null, 'SIGTERM');
    };
    const sessions: Awaited<ReturnType<CoderWorld['newSession']>>[] = [];
    for (let i = 0; i <= DEFAULT_MAX_CONCURRENT_SESSIONS; i++) sessions.push(await w.newSession());
    await Promise.all(sessions.map((s) => start(s.sessionId)));
    const live = await w.until(async () => {
      const rows = await Promise.all(sessions.map((s) => w.session(s.sessionId)));
      const claimed = rows.filter((r) => r.status !== 'queued');
      expect(claimed).toHaveLength(DEFAULT_MAX_CONCURRENT_SESSIONS);
      const fed = await w.widget(rows.find((r) => r.status === 'queued')!.id);
      expect(fed.feed.map((l) => l.text)).toContain('Waiting for another coding session to finish');
      return rows;
    });
    // The one left waiting is withdrawn, the others stopped.
    const waiting = live.find((r) => r.status === 'queued')!;
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'stopped' })
      .where(eq(schema.codingSessions.id, waiting.id));
    for (const row of live.filter((r) => r.id !== waiting.id)) {
      await w.until(async () =>
        expect(['running', 'starting']).toContain((await w.session(row.id)).status),
      );
      await w.until(() =>
        expect(w.coder.agentCalls().some((c) => c.launch.session_id === row.id)).toBe(true),
      );
      await publishCoderControl(w.t.deps, { type: 'stop', sessionId: row.id });
      await ended(row.id, 'stopped');
    }
  }, 30_000);

  it("uses the remote's default branch when the stored one is wrong", async () => {
    w.coder.git = (args) =>
      args.includes('symbolic-ref')
        ? { code: 0, stdout: 'refs/remotes/origin/master\n' }
        : defaultGit(args);
    w.coder.agent = (io) => {
      io.stdout(jsonl(initLine(), resultLine('Done')));
      io.exit(0);
    };
    try {
      const { sessionId } = await w.newSession({ base: 'main' });
      await start(sessionId);
      const row = await ended(sessionId, 'settled');
      expect(row.base).toBe('master');
      expect(w.coder.gitCalls()).toContainEqual([
        '-C',
        REPO_PATH,
        'remote',
        'set-head',
        'origin',
        '--auto',
      ]);
      expect(w.coder.gitCalls()).toContainEqual([
        '-C',
        REPO_PATH,
        'worktree',
        'add',
        WORKTREE,
        '-b',
        'bot/fix-reconnect',
        'origin/master',
      ]);
      const [repo] = await w.t.db.select().from(schema.repos).where(eq(schema.repos.id, w.repoId));
      expect(repo!.defaultBranch).toBe('master');
    } finally {
      w.coder.git = defaultGit;
      await w.t.db
        .update(schema.repos)
        .set({ defaultBranch: 'main' })
        .where(eq(schema.repos.id, w.repoId));
    }
  });
});

// The same runner against the fake agent from @openbots/computer/testing:
// every process is a real `WS /coder` socket the fake agent's coderScript
// plays, so the frames (start, stdin, answer, credential) are the protocol's.
type CoderClientMessage = FakeCoderSession['frames'][number];
type CoderStart = FakeCoderSession['start'];

describe('coder runner over the fake agent', () => {
  let w: CoderWorld;
  let github: Server;
  const pulls: { url: string; auth: string | undefined }[] = [];
  const credentials: { username: string; answer: CoderClientMessage }[] = [];
  let claudeStart: CoderStart | undefined;
  let stdinEnd: CoderClientMessage | undefined;
  let permissionAnswer: CoderClientMessage | undefined;

  beforeAll(async () => {
    w = await coderWorld('fake-agent@example.com', { fakeAgent: true });
    github = createServer((req: IncomingMessage, res) => {
      req.resume();
      req.on('end', () => {
        pulls.push({ url: `${req.method} ${req.url}`, auth: req.headers.authorization });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html_url: 'https://github.com/acme/relay/pull/9', number: 9 }));
      });
    });
    await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
    const githubApi = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(createCoderWorker(w.t.deps, { runWaitMs: 0, githubApi }), { concurrency: 4 });
    const res = await w.call('POST', '/connectors', {
      catalogId: 'github_builtin',
      secrets: { GITHUB_TOKEN: 'ghp-fake-agent-token' },
    });
    expect(res.status).toBe(201);

    w.computer.agent.coderScript = async (session) => {
      const { start } = session;
      session.send({
        type: 'started',
        pid: 7,
        session_dir: `/tmp/openbots/coders/${start.session_id}`,
      });
      if (start.command === 'git') {
        const args = start.args;
        for (const username of ['fetch', 'push']) {
          if (!args.includes(username)) continue;
          session.send({
            type: 'credential_request',
            request_id: `cred-${username}`,
            protocol: 'https',
            host: 'github.com',
            path: 'acme/relay.git',
            username,
          });
          credentials.push({ username, answer: await session.next('credential') });
        }
        const answer = args.includes('log')
          ? { code: 0, stdout: 'f00d\tBack off reconnects\n' }
          : defaultGit(args);
        if (answer.stdout) session.send({ type: 'stdout', data: answer.stdout });
        session.send({ type: 'exit', code: answer.code, signal: null });
        session.close();
        return;
      }
      // The runner's own chmod and stat around a checkout (repos-checkout.ts `lockDown`).
      const system = defaultSystem(start.command, start.args ?? []);
      if (system) {
        if (system.stdout) session.send({ type: 'stdout', data: system.stdout });
        session.send({ type: 'exit', code: system.code, signal: null });
        session.close();
        return;
      }
      claudeStart = start;
      stdinEnd = await session.next('stdin');
      session.send({ type: 'stdout', data: jsonl(initLine()) });
      session.send({
        type: 'permission_request',
        request_id: 'p1',
        tool_name: 'Bash',
        input: { command: 'pnpm add left-pad' },
      });
      permissionAnswer = await session.next('answer');
      session.send({ type: 'stdout', data: jsonl(resultLine('Backed off the reconnects.')) });
      session.send({ type: 'exit', code: 0, signal: null });
      session.close();
    };
  });
  afterAll(async () => {
    await new Promise((resolve) => github.close(resolve));
    await w.close();
  });

  const approvalOf = (sessionId: string, actionClass: string) =>
    w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.sessionId, sessionId),
            eq(schema.approvals.actionClass, actionClass),
          ),
        );
      expect(row).toBeDefined();
      return row!;
    });

  it('runs a pr session end to end: prompt, credentials, push and pull request', async () => {
    const { sessionId, runId } = await w.newSession({ mode: 'pr' });
    await w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId }));

    const install = await approvalOf(sessionId, 'install');
    expect(install.status).toBe('pending');
    expect(claudeStart).toMatchObject({ cwd: WORKTREE, user: 'coder', command: 'claude' });
    expect(claudeStart!.args).toEqual(
      expect.arrayContaining([
        '-p',
        'stream-json',
        '--permission-prompt-tool',
        '--disallowedTools',
      ]),
    );
    expect(stdinEnd).toMatchObject({ type: 'stdin', end: true });
    await w.until(async () => {
      expect((await w.session(sessionId)).status).toBe('waiting');
      const state = await w.widget(sessionId);
      expect(state.approvals).toEqual([
        expect.objectContaining({ id: install.id, status: 'pending' }),
      ]);
    });
    // The checkout's fetch was served the token.
    expect(credentials.find((c) => c.username === 'fetch')?.answer).toMatchObject({
      type: 'credential',
      request_id: 'cred-fetch',
      password: 'ghp-fake-agent-token',
    });

    const decided = await w.call('POST', `/approvals/${install.id}/decide`, {
      decision: 'approve',
    });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ resumedRunId: null });
    await w.until(() =>
      expect(permissionAnswer).toMatchObject({
        type: 'answer',
        request_id: 'p1',
        decision: 'allow',
      }),
    );

    const pr = await approvalOf(sessionId, 'pr');
    expect(pulls).toHaveLength(0);
    expect(
      (await w.call('POST', `/approvals/${pr.id}/decide`, { decision: 'approve' })).status,
    ).toBe(200);
    await w.until(() =>
      expect(pulls).toEqual([
        { url: 'POST /repos/acme/relay/pulls', auth: 'Bearer ghp-fake-agent-token' },
      ]),
    );
    expect(credentials.find((c) => c.username === 'push')?.answer).toMatchObject({
      type: 'credential',
      request_id: 'cred-push',
      password: 'ghp-fake-agent-token',
    });
    const row = await w.until(async () => {
      const found = await w.session(sessionId);
      expect(found.status).toBe('settled');
      return found;
    });
    expect(row).toMatchObject({ pushAllowed: true, prUrl: 'https://github.com/acme/relay/pull/9' });
    expect((await w.widget(sessionId)).result?.pr_url).toBe('https://github.com/acme/relay/pull/9');
    // The runner resumes the run after it settles the session: wait for it.
    await w.until(async () => {
      const run = await w.run(runId);
      expect(run.status).toBe('queued');
      expect((run.state as RunState).resume!.output).toMatchObject({
        status: 'settled',
        pr_url: 'https://github.com/acme/relay/pull/9',
      });
    });
  });
});

// Across agents and accounts (docs/plans/TECHNICAL_PLAN.md 22.13): Codex can commit through its sandbox, the runner
// commits what a session left, a refused API key is not a sign-in, the key
// never reaches what is kept, and a continued session keeps one diff Artifact.
describe('coder runner, across agents and accounts', () => {
  let w: CoderWorld;
  const options: CoderRunnerOptions = {
    runWaitMs: 0,
    touchMs: 60_000,
    stopGraceMs: 20,
    // No sign-in is driven here: a session that needs one tells its run at once.
    startLogin: () => Promise.reject(new Error('not in these tests')),
    rateLimitWaitMs: 20,
  };

  beforeAll(async () => {
    w = await coderWorld('coder-phase3@example.com');
    // Publication is covered separately; keep account and sandbox tests focused on their gates.
    await w.t.db
      .update(schema.bots)
      .set({ toolPolicy: { coder: { actions: { push: 'deny', pr: 'deny' } } } })
      .where(eq(schema.bots.id, w.bot.id));
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(createCoderWorker(w.t.deps, options), { concurrency: 4 });
  });
  afterAll(async () => {
    await w.close();
  });

  const withEdits = async (test: () => Promise<void>) => {
    const [bot] = await w.t.db.select().from(schema.bots).where(eq(schema.bots.id, w.bot.id));
    await w.t.db
      .update(schema.bots)
      .set({
        toolPolicy: withAcceptEdits(ToolPolicySchema.parse(bot!.toolPolicy), true),
      })
      .where(eq(schema.bots.id, w.bot.id));
    try {
      await test();
    } finally {
      await w.t.db
        .update(schema.bots)
        .set({ toolPolicy: bot!.toolPolicy })
        .where(eq(schema.bots.id, w.bot.id));
    }
  };
  const run = (sessionId: string) => w.runToEnd(sessionId);
  const setAccount: CoderWorld['setAccount'] = (agent, set) => w.setAccount(agent, set);
  const account = async (agent: string) =>
    (
      await w.t.db
        .select()
        .from(schema.coderAccounts)
        .where(
          and(eq(schema.coderAccounts.ownerId, w.ownerId), eq(schema.coderAccounts.agent, agent)),
        )
    )[0]!;
  const logins = (agent: string) =>
    w.t.db
      .select()
      .from(schema.coderLogins)
      .where(and(eq(schema.coderLogins.ownerId, w.ownerId), eq(schema.coderLogins.agent, agent)));
  const provider = async (presetId: string, apiKey: string, name: string) => {
    const created = await w.call('POST', '/providers', {
      presetId,
      apiKey,
      slug: name.toLowerCase().replace(/\W+/g, '-'),
      name,
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  };
  const launchOf = (sessionId: string) =>
    w.coder.agentCalls().find((c) => c.launch.session_id === sessionId)!.launch;
  const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
  const codexSuccess = () => {
    w.coder.agent = (io) => codexAppServer(io, fixture('codex-success.jsonl'));
  };
  const callOf = (sessionId: string) =>
    w.coder.agentCalls().find((c) => c.launch.session_id === sessionId)!;
  /** What the runner wrote to a Codex session's stdin, one protocol message each. */
  const framesOf = (sessionId: string) =>
    callOf(sessionId).writes.map((data) => {
      expect(data.endsWith('\n')).toBe(true);
      return JSON.parse(data) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
      };
    });
  const CODEX_THREAD = '01a1ad70-3c2e-7a41-9b0d-5e8f2c4a6b10';

  it('launches an unset edit policy read-only, matching Ask before edits', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    codexSuccess();
    const { sessionId } = await w.newSession({ agent: 'codex' });
    expect((await run(sessionId)).status).toBe('settled');
    expect(launchOf(sessionId).args).toContain('sandbox_mode="read-only"');
    expect(
      framesOf(sessionId).find((frame) => frame.method === 'thread/start')?.params?.sandbox,
    ).toBe('read-only');
  });

  it('runs with the model kept on the session (CA9)', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    codexSuccess();
    const { sessionId } = await w.newSession({ agent: 'codex', model: 'gpt-5.3-codex' });
    expect((await run(sessionId)).status).toBe('settled');
    expect(
      framesOf(sessionId).find((frame) => frame.method === 'thread/start')?.params?.model,
    ).toBe('gpt-5.3-codex');
  });

  it('runs Codex on app-server: the handshake in order, .git writable, and its posture', () =>
    withEdits(async () => {
      await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
      codexSuccess();
      const { sessionId } = await w.newSession({ agent: 'codex' });
      const row = await run(sessionId);
      expect(row).toMatchObject({ status: 'settled', vendorSessionId: CODEX_THREAD });
      const { command, args } = launchOf(sessionId);
      expect(command).toBe('codex');
      expect(args!.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
      expect(args).toContain(`sandbox_workspace_write.writable_roots=["${REPO_PATH}/.git"]`);
      expect(args).toContain('approval_policy="on-request"');
      expect(args).toContain('model_provider="openai"');
      // initialize, initialized, thread/start, turn/start, then EOF after the result.
      const frames = framesOf(sessionId);
      expect(frames.map((f) => f.method)).toEqual([
        'initialize',
        'initialized',
        'thread/start',
        'turn/start',
      ]);
      expect(frames.map((f) => f.id)).toEqual([1, undefined, 2, 3]);
      expect(frames[0]!.params).toMatchObject({
        clientInfo: { name: 'openbots', title: 'OpenBots' },
      });
      expect(frames[2]!.params).toEqual({
        cwd: WORKTREE,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      });
      const turn = frames[3]!.params as { threadId: string; input: { text: string }[] };
      expect(turn.threadId).toBe(CODEX_THREAD);
      expect(turn.input[0]!.text.endsWith('\n\nFix the reconnect loop')).toBe(true);
      expect(callOf(sessionId).stdinEnded).toBe(true);
      const state = await w.widget(sessionId);
      const feed = state.feed.map((l) => l.text);
      expect(feed.slice(0, 2)).toEqual([`Started Codex in ${WORKTREE}`, CODEX_POSTURE]);
      expect(feed.some((t) => t.includes('npm test'))).toBe(true);
      expect(row.usage).toMatchObject({ input_tokens: 48213, output_tokens: 1874 });

      // Claude Code's sessions get no such line.
      w.coder.agent = (io) => {
        io.stdout(fixture('claude-success.jsonl'));
        io.exit(0);
      };
      const claude = await w.newSession();
      expect((await run(claude.sessionId)).status).toBe('settled');
      expect((await w.widget(claude.sessionId)).feed.map((l) => l.text)).not.toContain(
        CODEX_POSTURE,
      );
    }));

  it('logs resumed Codex startup details without repeating them in the conversation', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    codexSuccess();
    const { sessionId } = await w.newSession({ agent: 'codex' });
    expect((await run(sessionId)).status).toBe('settled');
    const before = (await readEntries(w.t.db, sessionId, { limit: 500 })).entries;
    await w.t.db
      .update(schema.codingSessions)
      .set({ status: 'queued' })
      .where(eq(schema.codingSessions.id, sessionId));
    const row = await run(sessionId);
    expect(row.status).toBe('settled');
    const feed = (await w.widget(sessionId)).feed.map((line) => line.text);
    expect(feed.filter((text) => text === CODEX_POSTURE)).toHaveLength(1);
    expect(feed.some((text) => text.startsWith('Continued Codex in '))).toBe(false);
    const after = (await readEntries(w.t.db, sessionId, { limit: 500 })).entries;
    const added = JSON.stringify(after.filter((entry) => entry.seq > before.at(-1)!.seq));
    expect(added).not.toContain('Continued Codex in ');
    expect(added).not.toContain(CODEX_POSTURE);
    const log = readFileSync(row.logPath!, 'utf8');
    expect(log).toContain(`Continued Codex in ${WORKTREE}`);
    expect(log).toContain(CODEX_POSTURE);
  });

  /** The session's one `approvals` row, once it is there. */
  const approvalOf = (sessionId: string) =>
    w.until(async () => {
      const [row] = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(row).toBeDefined();
      return row!;
    });

  it('asks the owner when Codex asks, and answers app-server with accept', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    w.coder.agent = (io) => codexAppServer(io, fixture('codex-approval.jsonl'));
    const { sessionId, runId } = await w.newSession({ agent: 'codex' });
    await w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId }));
    const approval = await approvalOf(sessionId);
    // An install asks; Codex's reason is the detail.
    expect(approval).toMatchObject({
      runId,
      toolName: 'commandExecution',
      actionClass: 'install',
      status: 'pending',
      reason: 'Run: npm install --save-dev vitest',
      args: {
        command: 'npm install --save-dev vitest',
        cwd: WORKTREE,
        reason: 'Install vitest from the npm registry, which needs the network',
      },
    });
    await w.until(async () => {
      const state = await w.widget(sessionId);
      expect(state.status).toBe('waiting');
      expect(state.approvals).toEqual([
        expect.objectContaining({ id: approval.id, action_class: 'install', status: 'pending' }),
      ]);
    });
    // Nothing is answered before the owner decides.
    expect(framesOf(sessionId).some((f) => f.id === 0)).toBe(false);
    const res = await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'approve' });
    expect(res.status).toBe(200);
    const row = await w.until(async () => {
      const done = await w.session(sessionId);
      expect(done.status).toBe('settled');
      return done;
    });
    expect(framesOf(sessionId).filter((f) => f.id === 0)).toEqual([
      { id: 0, result: { decision: 'accept' } },
    ]);
    // Over the protocol, never the agent socket.
    expect(callOf(sessionId).answers).toEqual([]);
    expect(row.summary).toContain('Installed vitest as a dev dependency.');
    const state = await w.widget(sessionId);
    expect(state.approvals[0]!.status).toBe('approved');
    expect(state.feed.map((l) => l.text)).toEqual(
      expect.arrayContaining(['Asks: Run: npm install --save-dev vitest', 'The owner approved']),
    );
  });

  it('answers app-server with decline when the owner says no', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    w.coder.agent = (io) => codexAppServer(io, fixture('codex-approval.jsonl'));
    const { sessionId } = await w.newSession({ agent: 'codex' });
    await w.t.inOrganization(() => enqueueCoderJob(w.t.deps, { kind: 'session', sessionId }));
    const approval = await approvalOf(sessionId);
    const res = await w.call('POST', `/approvals/${approval.id}/decide`, { decision: 'deny' });
    expect(res.status).toBe(200);
    await w.until(async () => expect((await w.session(sessionId)).status).toBe('settled'));
    expect(framesOf(sessionId).filter((f) => f.id === 0)).toEqual([
      { id: 0, result: { decision: 'decline' } },
    ]);
    expect((await w.widget(sessionId)).feed.map((l) => l.text)).toContain('The owner said no');
  });

  it('answers an auto class at once, without an approval row', () =>
    withEdits(async () => {
      await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
      const transcript = fixture('codex-approval.jsonl')
        .split('\n')
        .map((line) =>
          line.includes('requestApproval')
            ? JSON.stringify({
                id: 0,
                method: 'item/commandExecution/requestApproval',
                params: {
                  threadId: CODEX_THREAD,
                  turnId: 't',
                  itemId: 'call_1',
                  command: 'pnpm run build',
                },
              })
            : line,
        )
        .join('\n');
      w.coder.agent = (io) => codexAppServer(io, transcript);
      const { sessionId } = await w.newSession({ agent: 'codex' });
      expect((await run(sessionId)).status).toBe('settled');
      expect(framesOf(sessionId).filter((f) => f.id === 0)).toEqual([
        { id: 0, result: { decision: 'accept' } },
      ]);
      const rows = await w.t.db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      expect(rows).toEqual([]);
      expect((await w.widget(sessionId)).feed.map((l) => l.text)).toContain(
        'Allowed: Run: pnpm run build',
      );
    }));

  it('commits what an edit session left uncommitted, as the Bot, and reports the commit', async () => {
    let committed = false;
    w.coder.git = (args) => {
      if (args.includes('status') && args.includes(WORKTREE)) {
        // What the agent touched (src/link.ts), and what a command it ran left.
        return {
          code: 0,
          stdout: committed ? '' : ' M src/link.ts\0?? notes.md\0?? .env.local\0',
        };
      }
      if (args.includes('commit')) {
        committed = true;
        return { code: 0 };
      }
      if (args.includes('log') && args.includes(WORKTREE)) {
        return {
          code: 0,
          stdout: `${committed ? 'c0ffee11\tCodex: changes from an OpenBots session\n' : ''}f00dfeed\tBack off between relay reconnects\n`,
        };
      }
      return defaultGit(args);
    };
    codexSuccess();
    try {
      const before = w.coder.calls.length;
      const { sessionId } = await w.newSession({ agent: 'codex' });
      const row = await run(sessionId);
      expect(row.status).toBe('settled');
      const calls = w.coder.calls.slice(before).filter((c) => c.launch.command === 'git');
      const add = calls.find((c) => gitArgs(c.launch.args).includes('-A'))!;
      const commit = calls.find((c) => gitArgs(c.launch.args).includes('commit'))!;
      // Only what the agent changed is staged; the rest stays, and the summary says so.
      expect(gitArgs(add.launch.args)).toEqual([
        '-C',
        WORKTREE,
        'add',
        '-A',
        '--',
        ':(literal)src/link.ts',
      ]);
      expect(row.summary).toContain('Left uncommitted: notes.md, .env.local');
      const commitArgs = gitArgs(commit.launch.args);
      expect(commitArgs).toEqual(
        expect.arrayContaining([
          'user.name=Relay Bot (OpenBots)',
          expect.stringMatching(/^user\.email=[a-z0-9_-]+@openbots\.local$/),
          leftoverCommitMessage('Codex'),
          'Co-Authored-By: coder-phase3 <coder-phase3@example.com>',
        ]),
      );
      expect(commitArgs.slice(commitArgs.indexOf('-C'), commitArgs.indexOf('-C') + 3)).toEqual([
        '-C',
        WORKTREE,
        'commit',
      ]);
      // As the runner, after the checkout was checked, never as the agent.
      expect(add.launch.user).toBe('runner');
      expect(commit.launch.user).toBe('runner');
      const configCheck = calls.findIndex((c) => gitArgs(c.launch.args).includes('--list'));
      expect(configCheck).toBeGreaterThanOrEqual(0);
      expect(configCheck).toBeLessThan(calls.indexOf(add));
      expect(row.commits).toEqual([
        { sha: 'c0ffee11', title: 'Codex: changes from an OpenBots session' },
        { sha: 'f00dfeed', title: 'Back off between relay reconnects' },
      ]);

      // A plan session leaves the tree as it is.
      committed = false;
      const planBefore = w.coder.calls.length;
      const plan = await w.newSession({ agent: 'codex', mode: 'plan' });
      expect((await run(plan.sessionId)).status).toBe('settled');
      const planGit = w.coder.calls
        .slice(planBefore)
        .filter((c) => c.launch.command === 'git')
        .map((c) => gitArgs(c.launch.args));
      expect(planGit.some((a) => a.includes('commit') || a.includes('-A'))).toBe(false);
    } finally {
      w.coder.git = defaultGit;
    }
    // A clean tree gets no commit either (the default worktree is clean).
    const cleanBefore = w.coder.calls.length;
    const clean = await w.newSession({ agent: 'codex' });
    expect((await run(clean.sessionId)).status).toBe('settled');
    expect(
      w.coder.calls.slice(cleanBefore).some((c) => gitArgs(c.launch.args).includes('commit')),
    ).toBe(false);
  });

  it('fails a Codex api_key session whose key is refused, without a sign-in', async () => {
    const providerId = await provider('openai', 'sk-oa-refused', 'OpenAI for Codex');
    await setAccount('codex', { authKind: 'api_key', providerId, lastError: null });
    w.coder.agent = (io) => codexAppServer(io, fixture('codex-needs-login.jsonl'));
    const { sessionId, runId } = await w.newSession({ agent: 'codex' });
    const row = await run(sessionId);
    const message = keyRejectedText('OpenAI for Codex', 'Codex');
    expect(message).toBe(
      'The OpenAI for Codex API key for Codex was rejected. Check it under Settings > Models.',
    );
    expect(row).toMatchObject({ status: 'failed', error: message });
    expect((await w.widget(sessionId)).error).toBe(message);
    expect(await account('codex')).toMatchObject({ authKind: 'api_key', lastError: message });
    expect(await logins('codex')).toEqual([]);
    expect(await resumedWith(runId)).toMatchObject({ status: 'failed', note: message });
  });

  it('marks a Codex plan sign-in that lapsed as needs_login', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    w.coder.agent = (io) => codexAppServer(io, fixture('codex-needs-login.jsonl'));
    const { sessionId } = await w.newSession({ agent: 'codex' });
    const row = await run(sessionId);
    // A turn that completed `failed` on OpenAI's 401, app-server's own words.
    expect(row).toMatchObject({ status: 'failed', error: NEEDS_LOGIN });
    // The owner reads plain words; OpenAI's own 401 text is in the log only.
    const state = await w.widget(sessionId);
    expect(state.error).toBe(CODEX_SIGN_IN_REFUSED);
    expect(JSON.stringify(state)).not.toContain('401 Unauthorized');
    expect(readFileSync(row.logPath!, 'utf8')).toContain('401 Unauthorized');
    expect(await account('codex')).toMatchObject({
      authKind: 'subscription',
      lastError: 'Codex is not signed in on the computer',
    });
  });

  it('fails a pi api_key session whose key is refused, and marks a pi sign-in that is missing', async () => {
    const providerId = await provider('anthropic', 'sk-ant-refused', 'Anthropic for pi');
    await setAccount('pi', { authKind: 'api_key', providerId, lastError: null });
    w.coder.agent = (io) => {
      // pi exits 0 with the provider's 401 in the stream.
      io.stdout(fixture('pi-invalid-key.jsonl'));
      io.exit(0);
    };
    const keyed = await w.newSession({ agent: 'pi' });
    const message = keyRejectedText('Anthropic for pi', 'pi');
    expect(await run(keyed.sessionId)).toMatchObject({ status: 'failed', error: message });
    expect(await account('pi')).toMatchObject({ authKind: 'api_key', lastError: message });
    expect(await logins('pi')).toEqual([]);

    await setAccount('pi', { authKind: 'subscription', providerId: null, lastError: null });
    w.coder.agent = (io) => {
      io.stdout(fixture('pi-needs-login.jsonl'));
      io.stderr('No API key found for the selected model.\n\nUse /login to log into a provider.\n');
      io.exit(1);
    };
    const plan = await w.newSession({ agent: 'pi' });
    expect(await run(plan.sessionId)).toMatchObject({ status: 'failed', error: NEEDS_LOGIN });
    expect((await account('pi')).authKind).toBe('subscription');
  });

  it("never reads a sign-in from the model's own summary", async () => {
    await setAccount('pi', { authKind: 'subscription', providerId: null, lastError: null });
    const session = '0b0e0f00-1111-4222-8333-444455556666';
    w.coder.agent = (io) => {
      io.stdout(
        jsonl(
          { type: 'session', id: session, cwd: WORKTREE },
          { type: 'agent_start' },
          {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'The client now retries on a 401 Unauthorized' }],
              usage: { input: 10, output: 5 },
              stopReason: 'length',
            },
          },
          { type: 'agent_end' },
        ),
      );
      io.exit(0);
    };
    const { sessionId } = await w.newSession({ agent: 'pi' });
    const row = await run(sessionId);
    expect(row.status).toBe('settled');
    expect(row.error).toBe("The reply reached the model's output limit");
    expect((await account('pi')).lastError).toBeNull();
  });

  it('masks the provider key in stderr, feed, log and error', async () => {
    const secret = 'sk-oa-echoed-0123456789';
    const providerId = await provider('openai', secret, 'OpenAI echo');
    await setAccount('codex', { authKind: 'api_key', providerId, lastError: null });
    w.coder.agent = (io) => {
      const key = io.call.launch.env!.OPENAI_API_KEY!;
      const turn = { threadId: CODEX_THREAD, turnId: 't-1' };
      // Split across chunks, so only a whole line can be masked.
      io.stderr(`using ${key.slice(0, 8)}`);
      io.stderr(`${key.slice(8)} now\nfatal: bad key ${key}`);
      return codexAppServer(
        io,
        jsonl(
          { id: 1, result: { userAgent: 'openbots/0.166.0', codexHome: '/x' } },
          { id: 2, result: { thread: { id: CODEX_THREAD } } },
          { id: 3, result: { turn: { id: 't-1', status: 'inProgress' } } },
          {
            method: 'item/completed',
            params: { ...turn, item: { type: 'agentMessage', id: 'm', text: `My key is ${key}` } },
          },
          {
            method: 'turn/completed',
            params: {
              threadId: CODEX_THREAD,
              turn: {
                id: 't-1',
                status: 'failed',
                error: { message: `Incorrect API key provided: ${key}`, codexErrorInfo: null },
              },
            },
          },
        ),
      );
    };
    const { sessionId } = await w.newSession({ agent: 'codex' });
    const row = await run(sessionId);
    const launched = launchOf(sessionId);
    expect(launched.env?.OPENAI_API_KEY).toBe(secret);
    // The key is read from the environment by a provider the session names, never argv.
    expect(launched.args).toContain('model_provider="openbots"');
    expect(launched.args!.join(' ')).not.toContain(secret);
    expect(row.error).toBe('Incorrect API key provided: [key]');
    const log = readFileSync(row.logPath!, 'utf8');
    expect(log).toContain('My key is [key]');
    expect(log).toContain('[stderr] using [key] now');
    const state = await w.widget(sessionId);
    const shown = JSON.stringify({ state, row });
    expect(shown).not.toContain(secret);
    expect(log).not.toContain(secret);
    expect(state.feed.map((l) => l.text)).toContain('My key is [key]');
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
  });

  it('keeps one diff Artifact across settles, and clears it when there is no diff', async () => {
    let patch = 'diff --git a/src/link.ts b/src/link.ts\n+  delay = 500;\n';
    let commits = true;
    w.coder.git = (args) => {
      if (args.includes('diff') && args.includes('origin/main...HEAD') && args.length === 4) {
        return { code: 0, stdout: patch };
      }
      if (args.includes('log') && args.includes(WORKTREE) && !commits) return { code: 0 };
      return defaultGit(args);
    };
    w.coder.agent = (io) => {
      io.stdout(fixture('claude-success.jsonl'));
      io.exit(0);
    };
    try {
      const { sessionId } = await w.newSession();
      const first = await run(sessionId);
      expect(first.diffArtifactId).toEqual(expect.any(String));

      // Continued: the same Artifact gets the new diff as its next version.
      patch = 'diff --git a/src/link.ts b/src/link.ts\n+  delay = 750;\n';
      await w.t.db
        .update(schema.codingSessions)
        .set({ status: 'queued', vendorSessionId: VENDOR_ID, worktreePath: WORKTREE })
        .where(eq(schema.codingSessions.id, sessionId));
      const second = await run(sessionId);
      expect(second.status).toBe('settled');
      expect(second.diffArtifactId).toBe(first.diffArtifactId);
      const versions = await w.t.db
        .select()
        .from(schema.artifactVersions)
        .where(eq(schema.artifactVersions.artifactId, first.diffArtifactId!));
      expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
      const content = await w.call('GET', `/artifacts/${first.diffArtifactId}/versions/2/content`);
      expect(await content.text()).toBe(patch);
      const owned = await w.t.db
        .select({ id: schema.artifacts.id })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.title, 'Diff: bot/fix-reconnect'));
      expect(owned.filter((a) => a.id === first.diffArtifactId)).toHaveLength(1);

      // Continued again with nothing on the branch: row and widget both say none.
      commits = false;
      await w.t.db
        .update(schema.codingSessions)
        .set({ status: 'queued' })
        .where(eq(schema.codingSessions.id, sessionId));
      const third = await run(sessionId);
      expect(third.status).toBe('settled');
      expect(third.diffArtifactId).toBeNull();
      expect((await w.widget(sessionId)).result?.diff_artifact_id).toBeUndefined();
    } finally {
      w.coder.git = defaultGit;
    }
  });

  /** The output the waiting run was resumed with, once the runner resumes it. */
  const resumedWith = async (runId: string) => {
    const r = await w.until(async () => {
      const found = await w.run(runId);
      expect(found.status).toBe('queued');
      return found;
    });
    return (r.state as RunState).resume!.output as Record<string, unknown>;
  };

  it('records an approved push by the agent only when the remote head is a commit the session made', async () => {
    const sha = 'a'.repeat(40);
    let pushedNow = false;
    let made = `${sha}\n`;
    w.coder.agent = (io) => {
      pushedNow = true;
      io.stdout(fixture('claude-success.jsonl'));
      io.exit(0);
    };
    w.coder.git = (args) => {
      if (args.includes('ls-remote')) {
        // Not on the remote when the worktree is made; the agent pushes it.
        return pushedNow
          ? { code: 0, stdout: `${sha}\trefs/heads/bot/fix-reconnect\n` }
          : { code: 2 };
      }
      if (args.includes('rev-list') && args.includes('origin/main..HEAD')) {
        return { code: 0, stdout: made };
      }
      return defaultGit(args);
    };
    try {
      const pushed = await w.newSession({ pushAllowed: true });
      expect(await run(pushed.sessionId)).toMatchObject({ pushedSha: sha, branchExisted: false });
      // The remote head is not one of the session's commits: not recorded.
      pushedNow = false;
      made = `${'c'.repeat(40)}\n`;
      const moved = await w.newSession({ pushAllowed: true });
      expect((await run(moved.sessionId)).pushedSha).toBeNull();
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('refuses a new session on a branch that is already on the remote', async () => {
    let launched = false;
    w.coder.agent = (io) => {
      launched = true;
      io.exit(0);
    };
    w.coder.git = (args) =>
      args.includes('ls-remote')
        ? { code: 0, stdout: `${'d'.repeat(40)}\trefs/heads/bot/fix-reconnect\n` }
        : defaultGit(args);
    try {
      const { sessionId } = await w.newSession();
      const row = await run(sessionId);
      expect(row).toMatchObject({ status: 'failed', branchExisted: null, worktreePath: null });
      expect(row.error).toContain('The branch bot/fix-reconnect already exists on GitHub');
      expect(launched).toBe(false);
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('discards a pushed bot/ branch on the remote only while its head is what the session pushed', async () => {
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    w.coder.agent = (io) => io.exit(0);
    let remoteHead = sha;
    w.coder.git = (args) => {
      if (!args.includes('ls-remote')) return defaultGit(args);
      const ref = args.at(-1)!;
      // A longer ref that a pattern would also match comes first.
      return {
        code: 0,
        stdout: `${other}\trefs/heads/x/${ref.slice('refs/heads/'.length)}\n${remoteHead}\t${ref}\n`,
      };
    };
    const settledSession = async (
      branch: string,
      prUrl: string | null,
      pushedSha: string | null = sha,
      branchExisted: boolean | null = false,
    ) => {
      const s = await w.newSession({
        status: 'settled',
        branch,
        worktreePath: `${REPO_PATH}/.worktrees/${branch.replace('/', '-')}`,
        pushAllowed: true,
        pushedSha,
        branchExisted,
        prUrl,
      });
      await w.t.db
        .update(schema.widgetStates)
        .set({ state: { status: 'settled', feed: [], approvals: [] } })
        .where(eq(schema.widgetStates.messageId, s.messageId));
      // The widget names its own session, as `code_task` posts it.
      const [message] = await w.t.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, s.messageId));
      const parts = message!.parts as { props: Record<string, unknown> }[];
      parts[0]!.props = { ...parts[0]!.props, session_id: s.sessionId, branch };
      await w.t.db
        .update(schema.messages)
        .set({ parts: parts as (typeof schema.messages.$inferSelect)['parts'] })
        .where(eq(schema.messages.id, s.messageId));
      return s.sessionId;
    };
    const discard = async (sessionId: string) => {
      const before = w.coder.calls.length;
      expect((await w.call('POST', `/coding-sessions/${sessionId}/discard`)).status).toBe(200);
      // The worktree goes after the action is stored.
      await w.until(async () => expect((await w.session(sessionId)).worktreePath).toBeNull());
      return w.coder.calls
        .slice(before)
        .filter((c) => c.launch.command === 'git')
        .map((c) => ({ args: gitArgs(c.launch.args), user: c.launch.user }));
    };
    const feed = async (sessionId: string) =>
      (await w.widget(sessionId)).feed.map((line) => line.text);
    const deletes = (git: { args: string[] }[]) => git.some((g) => g.args.includes('--delete'));
    try {
      const pushed = await settledSession('bot/gone', null);
      const git = await discard(pushed);
      expect(git).toContainEqual({
        args: [
          '-C',
          REPO_PATH,
          'push',
          'origin',
          '--delete',
          `--force-with-lease=refs/heads/bot/gone:${sha}`,
          'bot/gone',
        ],
        user: 'runner',
      });
      expect(await feed(pushed)).toContain('Deleted the pushed branch bot/gone on GitHub');

      // Someone pushed on it since: it stays, and the feed says why.
      remoteHead = other;
      const moved = await settledSession('bot/moved', null);
      expect(deletes(await discard(moved))).toBe(false);
      expect(await feed(moved)).toContain(
        'The branch bot/moved stays on GitHub: it has commits the session did not push',
      );
      remoteHead = sha;

      // From before the bot/ rule, or with no record of the push: it stays.
      const old = await settledSession('main', null);
      expect(deletes(await discard(old))).toBe(false);
      expect(await feed(old)).toContain(
        'The branch main stays on GitHub: only bot/ branches are deleted',
      );
      const unrecorded = await settledSession('bot/unrecorded', null, null);
      expect(deletes(await discard(unrecorded))).toBe(false);

      // On the remote before the session (another session's, or an earlier push): it stays.
      const before = await settledSession('bot/before', null, sha, true);
      expect(deletes(await discard(before))).toBe(false);
      expect(await feed(before)).toContain(
        'The branch bot/before stays on GitHub: it was there before the session',
      );
      const older = await settledSession('bot/older', null, sha, null);
      expect(deletes(await discard(older))).toBe(false);

      const url = 'https://github.com/acme/relay/pull/7';
      const kept = await settledSession('bot/kept', url);
      const keptGit = await discard(kept);
      expect(deletes(keptGit)).toBe(false);
      expect(await feed(kept)).toContain(
        `The branch bot/kept stays on GitHub with its pull request ${url}`,
      );
    } finally {
      w.coder.git = defaultGit;
    }
  });

  it('waits out a vendor rate limit once, then fails if it holds', async () => {
    await setAccount('codex', { authKind: 'subscription', providerId: null, lastError: null });
    const limited =
      'ERROR: unexpected status 429 Too Many Requests: rate_limit_exceeded. Please try again in 20s';
    let launches = 0;
    w.coder.agent = (io) => {
      launches++;
      if (launches === 1) {
        io.stderr(`${limited}\n`);
        return io.exit(1);
      }
      io.stdout(fixture('codex-success.jsonl'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession({ agent: 'codex' });
    const row = await run(sessionId);
    expect(launches).toBe(2);
    expect(row.status).toBe('settled');
    const feed = (await w.widget(sessionId)).feed.map((line) => line.text);
    expect(
      feed.some((text) => /Codex is rate limited .*trying again in 1 second$/.test(text)),
    ).toBe(true);

    w.coder.agent = (io) => {
      io.stderr(`${limited}\n`);
      io.exit(1);
    };
    const again = await w.newSession({ agent: 'codex' });
    const failed = await run(again.sessionId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Codex hit the vendor's rate limit again after waiting: .*429/);
  });
});
