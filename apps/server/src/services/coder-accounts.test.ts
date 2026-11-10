import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_HOME } from '@openbots/computer';
import { CODERS_QUEUE, ToolPolicySchema } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/client.js';
import { ptyParams } from '../ws/computer.js';
import { coderWorld, defaultGit, type CoderWorld } from './__fixtures__/coders/setup.js';
import { lastErrorKind, needsSignIn, planProviderOf, signInStyleOf } from './coder-accounts.js';
import { CODEX_SIGN_IN_REFUSED } from './coder-adapters/codex.js';
import { PI_SIGN_IN_INSTRUCTIONS } from './coder-adapters/pi.js';
import { type CoderJob } from './coder-jobs.js';
import { startLogin } from './coder-login.js';
import { runCoderLogin } from './coder-login-driver.js';
import { createCoderWorker } from './coder-runner.js';
import { coderServices } from './coder-tool.js';
import { DIFF_MAX_CHARS, DIFF_TRUNCATED } from './session-git.js';
import type { RunState } from './runs.js';

// The owner's coding agent accounts and what they mean for a session: the
// Bot's model override and an api_key account's provider key reach the CLI,
// the account's billing reaches the parser, a settled session's diff becomes
// an Artifact, the Bot's usage counts its coding sessions, pi signs in from
// the terminal, and the check route reads a sign-in back from the CLI.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/coders');

describe('accounts', () => {
  it('says which accounts need a sign-in, and what their last error is about', () => {
    const lapsed = 'Claude Code is not signed in on the computer';
    expect(needsSignIn({ authKind: 'subscription', lastError: lapsed })).toBe(true);
    expect(lastErrorKind({ authKind: 'subscription', lastError: lapsed })).toBe('sign_in');
    expect(lastErrorKind({ authKind: 'subscription', lastError: CODEX_SIGN_IN_REFUSED })).toBe(
      'sign_in',
    );
    const refused = 'The Anthropic key was rejected (401). Check it in Settings > Models.';
    expect(needsSignIn({ authKind: 'api_key', lastError: refused })).toBe(false);
    expect(lastErrorKind({ authKind: 'api_key', lastError: refused })).toBe('key');
    expect(needsSignIn({ authKind: 'api_key', lastError: lapsed })).toBe(false);
    expect(lastErrorKind({ authKind: 'api_key', lastError: lapsed })).toBe('key');
    expect(lastErrorKind({ authKind: 'subscription', lastError: 'The disk is full' })).toBe(
      'other',
    );
    expect(lastErrorKind({ authKind: 'subscription', lastError: null })).toBeNull();
  });

  it('says whose plan an account bills, and how each agent signs in', () => {
    expect(planProviderOf('claude', 'subscription', 'dana@example.com')).toBe('anthropic');
    expect(planProviderOf('codex', 'subscription', 'ChatGPT Plus')).toBe('openai');
    expect(planProviderOf('claude', 'api_key', null)).toBeNull();
    expect(planProviderOf('pi', 'none', null)).toBeNull();
    // pi: from the plans its check put in the label; a Claude plan comes first.
    expect(planProviderOf('pi', 'subscription', 'Anthropic (Claude Pro/Max)')).toBe('anthropic');
    expect(planProviderOf('pi', 'subscription', 'OpenAI (ChatGPT Plus/Pro)')).toBe('openai');
    expect(
      planProviderOf('pi', 'subscription', 'OpenAI (ChatGPT Plus/Pro), Anthropic (Claude Pro/Max)'),
    ).toBe('anthropic');
    expect(planProviderOf('pi', 'subscription', 'GitHub Copilot')).toBe('other');
    expect(planProviderOf('pi', 'api_key', 'API key through pi (Anthropic)')).toBeNull();
    expect(signInStyleOf('claude')).toBe('link');
    expect(signInStyleOf('codex')).toBe('device');
    expect(signInStyleOf('pi')).toBe('terminal');
  });
});

describe('coding agent accounts and their sessions', () => {
  let w: CoderWorld;

  beforeAll(async () => {
    w = await coderWorld('phase3-owner@example.com');
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(createCoderWorker(w.t.deps, { runWaitMs: 0, touchMs: 60_000, stopGraceMs: 20 }), {
        concurrency: 2,
      });
  });
  afterAll(async () => {
    await w.close();
  });

  const run = async (sessionId: string) => {
    // Account tests do not authorize publishing. Completion must respect this denial.
    const [bot] = await w.t.db.select().from(schema.bots).where(eq(schema.bots.id, w.bot.id));
    const policy = ToolPolicySchema.parse(bot!.toolPolicy ?? {});
    await w.t.db
      .update(schema.bots)
      .set({
        toolPolicy: {
          ...policy,
          coder: {
            ...policy.coder,
            actions: { ...policy.coder?.actions, push: 'deny', pr: 'deny' },
          },
        },
      })
      .where(eq(schema.bots.id, w.bot.id));
    return w.runToEnd(sessionId);
  };
  const setAccount: CoderWorld['setAccount'] = (agent, set) => w.setAccount(agent, set);
  const claudeSuccess = () => {
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'claude-success.jsonl'), 'utf8'));
      io.exit(0);
    };
  };
  const lastLaunch = (sessionId: string) =>
    w.coder.agentCalls().find((c) => c.launch.session_id === sessionId)!.launch;

  it("gives the CLI the Bot's model and an api_key account's provider key, nothing else", async () => {
    await w.t.db
      .update(schema.bots)
      .set({ toolPolicy: { coder: { models: { claude: 'claude-opus-4-5' } } } })
      .where(eq(schema.bots.id, w.bot.id));
    const created = await w.call('POST', '/providers', {
      presetId: 'anthropic',
      apiKey: 'sk-ant-coder-secret',
      slug: 'anthropic-coder',
      name: 'Anthropic for coding',
    });
    expect(created.status).toBe(201);
    const providerId = ((await created.json()) as { id: string }).id;
    const put = await w.call('PUT', '/coders/claude/api-key', { providerId });
    expect(put.status).toBe(200);
    const account = ((await put.json()) as { account: Record<string, unknown> }).account;
    expect(account).toMatchObject({ authKind: 'api_key', needsSignIn: false, available: true });

    claudeSuccess();
    const keyed = await w.newSession();
    expect((await run(keyed.sessionId)).status).toBe('settled');
    const launch = lastLaunch(keyed.sessionId);
    expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-coder-secret');
    const at = launch.args!.indexOf('--model');
    expect(launch.args![at + 1]).toBe('claude-opus-4-5');

    // A plan sign-in: no key in the environment.
    await setAccount('claude', { authKind: 'subscription', providerId: null });
    const plan = await w.newSession();
    expect((await run(plan.sessionId)).status).toBe('settled');
    expect(lastLaunch(plan.sessionId).env).not.toHaveProperty('ANTHROPIC_API_KEY');

    // A lapsed-looking error does not make an api_key account sign in again.
    await setAccount('claude', {
      authKind: 'api_key',
      providerId,
      lastError: 'Claude Code is not signed in on the computer',
    });
    const cards = (await (await w.call('GET', '/coders')).json()) as {
      agents: { agent: string; needsSignIn: boolean }[];
    };
    expect(cards.agents.find((a) => a.agent === 'claude')!.needsSignIn).toBe(false);
    // An api_key account bills no plan; every card says how it signs in and whether Check works.
    expect(cards.agents.find((a) => a.agent === 'claude')).toMatchObject({
      planProvider: null,
      checkAvailable: true,
      signIn: 'link',
    });
    expect(cards.agents.find((a) => a.agent === 'pi')).toMatchObject({
      checkAvailable: true,
      signIn: 'terminal',
    });
    await setAccount('claude', { authKind: 'subscription', providerId: null, lastError: null });
    await w.t.db.update(schema.bots).set({ toolPolicy: {} }).where(eq(schema.bots.id, w.bot.id));
  });

  it('refuses a provider the agent cannot use, with the reason', async () => {
    const created = await w.call('POST', '/providers', {
      presetId: 'openai',
      apiKey: 'sk-openai-coder',
      slug: 'openai-coder',
      name: 'OpenAI for coding',
    });
    expect(created.status).toBe(201);
    const providerId = ((await created.json()) as { id: string }).id;
    await setAccount('claude', { authKind: 'api_key', providerId });
    claudeSuccess();
    const { sessionId } = await w.newSession();
    const row = await run(sessionId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/Claude Code cannot use the OpenAI for coding key/);
    expect(row.error).not.toContain('sk-openai-coder');
    await setAccount('claude', { authKind: 'subscription', providerId: null, lastError: null });
  });

  it('settles a Codex session on a plan with usage billed to it', async () => {
    await setAccount('codex', { authKind: 'subscription', accountLabel: 'ChatGPT' });
    w.coder.agent = (io) => {
      io.stdout(readFileSync(path.join(FIXTURES, 'codex-success.jsonl'), 'utf8'));
      io.exit(0);
    };
    const { sessionId } = await w.newSession({ agent: 'codex' });
    const row = await run(sessionId);
    expect(row.status).toBe('settled');
    expect(lastLaunch(sessionId).command).toBe('codex');
    expect(row.usage).toMatchObject({ billed: 'subscription' });
  });

  it("puts a settled session's diff in an Artifact, which Discard leaves", async () => {
    const patch = 'diff --git a/src/link.ts b/src/link.ts\n+  delay = 500;\n';
    w.coder.git = (args) =>
      args.includes('diff') && args.includes('origin/main...HEAD') && args.length === 4
        ? { code: 0, stdout: patch }
        : defaultGit(args);
    claudeSuccess();
    const { sessionId } = await w.newSession();
    const row = await run(sessionId);
    expect(row.status).toBe('settled');
    expect(row.diffArtifactId).toEqual(expect.any(String));
    const state = await w.widget(sessionId);
    expect(state.result?.diff_artifact_id).toBe(row.diffArtifactId);
    const view = (await (await w.call('GET', `/coding-sessions/${sessionId}`)).json()) as {
      session: { diffArtifactId: string | null };
    };
    expect(view.session.diffArtifactId).toBe(row.diffArtifactId);
    const [artifact] = await w.t.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, row.diffArtifactId!));
    expect(artifact).toMatchObject({
      title: 'Diff: bot/fix-reconnect',
      kind: 'code',
      botId: w.bot.id,
      ownerId: w.ownerId,
    });
    const content = await w.call('GET', `/artifacts/${row.diffArtifactId}/versions/1/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(patch);

    expect((await w.call('POST', `/coding-sessions/${sessionId}/discard`)).status).toBeLessThan(
      300,
    );
    const [kept] = await w.t.db
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, row.diffArtifactId!));
    expect(kept).toBeDefined();
    w.coder.git = defaultGit;
  });

  it('cuts a diff past 1 MB with a marker', async () => {
    const big = 'x'.repeat(DIFF_MAX_CHARS + 10);
    w.coder.git = (args) =>
      args.includes('diff') && args.length === 4 ? { code: 0, stdout: big } : defaultGit(args);
    claudeSuccess();
    const { sessionId } = await w.newSession();
    const row = await run(sessionId);
    const [version] = await w.t.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, row.diffArtifactId!));
    expect(version!.size).toBe(DIFF_MAX_CHARS + Buffer.byteLength(DIFF_TRUNCATED));
    w.coder.git = defaultGit;
  });

  it("counts the Bot's coding sessions in its usage, plan sessions apart", async () => {
    const insert = (usage: typeof schema.codingSessions.$inferInsert.usage) =>
      w.t.db.insert(schema.codingSessions).values({
        workspaceId: w.workspaceId,
        ownerId: w.ownerId,
        botId: w.bot.id,
        agent: 'codex',
        mode: 'edit',
        prompt: 'x',
        status: 'settled',
        usage,
      });
    const usage = async () =>
      (
        (await (await w.call('GET', `/bots/${w.bot.id}/usage`)).json()) as {
          coding: Record<string, number | null>;
        }
      ).coding;
    const before = await usage();
    await insert({ input_tokens: 100, output_tokens: 10, cost_usd: 0.25, billed: 'api' });
    await insert({ input_tokens: 50, output_tokens: 5, cost_usd: 1, billed: 'subscription' });
    await insert(null);
    const after = await usage();
    expect(after.sessions! - before.sessions!).toBe(3);
    expect(after.inputTokens! - before.inputTokens!).toBe(150);
    expect(after.outputTokens! - before.outputTokens!).toBe(15);
    expect(after.onPlanSessions! - before.onPlanSessions!).toBe(1);
    expect(after.costUsd! - (before.costUsd ?? 0)).toBeCloseTo(0.25);
  });

  it('sends pi to the terminal to sign in, and lets that terminal open', async () => {
    const res = await w.call('POST', '/coders/pi/login');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'CODER_LOGIN_IN_TERMINAL',
      message: PI_SIGN_IN_INSTRUCTIONS,
      terminal: { cwd: COMPUTER_HOME, user: 'coder', preset: 'pi' },
    });
    const [login] = await w.t.db
      .select()
      .from(schema.coderLogins)
      .where(eq(schema.coderLogins.agent, 'pi'));
    expect(login).toBeUndefined();
    const params = await ptyParams(
      { db: w.t.db },
      { id: w.ownerId, workspaceId: w.workspaceId },
      new URLSearchParams({ cwd: COMPUTER_HOME, user: 'coder', preset: 'pi' }),
    );
    expect(Object.fromEntries(params)).toEqual({ cwd: COMPUTER_HOME, user: 'coder', preset: 'pi' });
  });

  it('checks a sign-in with the CLI and records it', async () => {
    const asked: string[][] = [];
    w.coder.agent = (io) => {
      const { command, args = [], env = {} } = io.call.launch;
      asked.push([
        command,
        ...args,
        env.CODEX_HOME ?? env.PI_CODING_AGENT_DIR ?? env.CLAUDE_CONFIG_DIR ?? '',
      ]);
      if (command === 'claude' && args.join(' ') === 'auth status') {
        io.stdout(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }, null, 2)}\n`);
      } else if (command === 'codex' && args.join(' ') === 'login status') {
        io.stdout('Logged in using ChatGPT\n');
      } else if (command === 'pi' && args[0] === 'auth') {
        const id = args[args.indexOf('--provider') + 1];
        io.stdout(
          JSON.stringify(
            id === 'anthropic'
              ? { status: 'ready', provider: id, authType: 'oauth' }
              : { status: 'not_ready', provider: id, reason: 'credentials_not_configured' },
          ),
        );
        io.exit(id === 'anthropic' ? 0 : 1);
        return;
      } else if (args.includes('--version')) {
        io.stdout(`${command} 9.9.9\n`);
      }
      io.exit(0);
    };
    // Claude Code answers `claude auth status` with JSON.
    const claude = await w.call('POST', '/coders/claude/check');
    expect(claude.status).toBe(200);
    expect(((await claude.json()) as { account: unknown }).account).toMatchObject({
      agent: 'claude',
      authKind: 'subscription',
      accountLabel: 'Claude account',
    });
    expect(asked).toContainEqual(['claude', 'auth', 'status', expect.stringMatching(/claude$/)]);

    await setAccount('codex', { authKind: 'none', lastError: 'Codex is not signed in' });
    const codex = await w.call('POST', '/coders/codex/check');
    expect(codex.status).toBe(200);
    expect(((await codex.json()) as { account: unknown }).account).toMatchObject({
      agent: 'codex',
      authKind: 'subscription',
      accountLabel: 'ChatGPT',
      lastError: null,
      needsSignIn: false,
      signedInAt: expect.any(String),
    });
    expect(asked).toContainEqual(['codex', 'login', 'status', expect.stringMatching(/codex$/)]);

    const pi = await w.call('POST', '/coders/pi/check');
    expect(pi.status).toBe(200);
    expect(((await pi.json()) as { account: unknown }).account).toMatchObject({
      agent: 'pi',
      authKind: 'subscription',
      accountLabel: 'Anthropic (Claude Pro/Max)',
    });
    expect(asked).toContainEqual([
      'pi',
      'auth',
      'check',
      '--provider',
      'anthropic',
      '--json',
      expect.stringMatching(/pi$/),
    ]);
    const [stored] = await w.t.db
      .select()
      .from(schema.coderAccounts)
      .where(
        and(eq(schema.coderAccounts.ownerId, w.ownerId), eq(schema.coderAccounts.agent, 'pi')),
      );
    expect(stored).toMatchObject({ authKind: 'subscription', lastError: null });
  });

  it('marks a negative subscription check as requiring reconnect without enabling API billing', async () => {
    await setAccount('codex', { authKind: 'subscription', lastError: null });
    w.coder.agent = (io) => {
      io.stdout('Not logged in\n');
      io.exit(1);
    };
    const response = await w.call('POST', '/coders/codex/check');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { account: unknown }).account).toMatchObject({
      authKind: 'subscription',
      needsSignIn: true,
      lastErrorKind: 'sign_in',
    });
  });

  it('does not switch a selected subscription to API billing when Check finds an API login instead', async () => {
    await setAccount('codex', { authKind: 'subscription', lastError: null });
    w.coder.agent = (io) => {
      io.stdout('Logged in using an API key');
      io.exit(0);
    };
    const response = await w.call('POST', '/coders/codex/check');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { account: unknown }).account).toMatchObject({
      authKind: 'subscription',
      needsSignIn: true,
    });
  });

  it("signs each agent out of its own config directory and resumes with the adapter's command", async () => {
    w.coder.agent = (io) => io.exit(0);
    const before = w.coder.calls.length;
    expect((await w.call('POST', '/coders/codex/sign-out')).status).toBe(200);
    const signOut = w.coder.calls.slice(before).find((c) => c.launch.command === 'node')!;
    expect(signOut.launch.args).toEqual([
      expect.stringMatching(/subscription-sign-out\.js$/),
      'codex',
    ]);
    const { sessionId } = await w.newSession({
      agent: 'codex',
      worktreePath: '/home/bot/repos/acme/relay/.worktrees/x',
      vendorSessionId: '01a1ad70-3c2e-7a41-9b0d-5e8f2c4a6b10',
      status: 'settled',
    });
    const res = await w.call('GET', `/coding-sessions/${sessionId}/terminal`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preset: string }).preset).toBe(
      'codex resume 01a1ad70-3c2e-7a41-9b0d-5e8f2c4a6b10',
    );
  });

  const waitingRun = async () => {
    const [run] = await w.t.db
      .insert(schema.runs)
      .values({
        workspaceId: w.workspaceId,
        botId: w.bot.id,
        chatId: w.bot.chatId,
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
  };
  const botRow = async () =>
    (await w.t.db.select().from(schema.bots).where(eq(schema.bots.id, w.bot.id)))[0]!;
  const widgetState = async (messageId: string) =>
    (
      await w.t.db
        .select()
        .from(schema.widgetStates)
        .where(eq(schema.widgetStates.messageId, messageId))
    )[0]!.state as Record<string, unknown>;
  /** pi on the computer: `ready` for the providers in `ready`, with their auth type. */
  const piChecks = (ready: Record<string, string>) => {
    w.coder.agent = (io) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'pi' && args[0] === 'auth') {
        const id = args[args.indexOf('--provider') + 1]!;
        const authType = ready[id];
        io.stdout(
          `${JSON.stringify(authType ? { status: 'ready', provider: id, authType } : { status: 'not_ready', provider: id, reason: 'credentials_not_configured' })}\n`,
        );
        io.exit(authType ? 0 : 1);
        return;
      }
      if (args.includes('--version')) io.stdout('pi 0.80.0\n');
      io.exit(0);
    };
  };

  it("asks the owner in the transcript when a Bot's code_task needs pi signed in, and Check resumes it", async () => {
    await setAccount('pi', { authKind: 'none', accountLabel: null, lastError: null });
    const run = await waitingRun();
    const before = w.coder.calls.length;
    const started = await w.t.inOrganization(async () =>
      coderServices(w.t.ownerDeps, {
        bot: await botRow(),
        runId: run.id,
        chatId: w.bot.chatId,
        source: 'owner',
      }).start({ agent: 'pi', repo: 'acme/relay', prompt: 'Fix it', mode: 'edit' }),
    );
    expect(started).toMatchObject({ kind: 'coder_login', label: 'Waiting for sign-in: pi' });
    const [login] = await w.t.db
      .select()
      .from(schema.coderLogins)
      .where(eq(schema.coderLogins.id, started.sessionId));
    expect(login).toMatchObject({ agent: 'pi', status: 'pending', url: null, deviceCode: null });
    const [message] = await w.t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, started.posted.messageId));
    expect(message!.chatId).toBe(w.bot.chatId);
    expect((message!.parts as { props: unknown }[])[0]!.props).toMatchObject({
      login_id: login!.id,
      agent: 'pi',
      instructions:
        'pi signs in from its own terminal. Open the Computer page, run pi, type /login and choose a provider. Then press Check under Settings > Models.',
    });
    expect(await widgetState(message!.id)).toMatchObject({
      status: 'pending',
      waiting_runs: [run.id],
    });
    // Nothing runs on the computer for it: the owner signs in in the terminal.
    await w.t.inOrganization(() => runCoderLogin(w.t.deps, login!.id));
    expect(w.coder.calls.slice(before).filter((c) => c.launch.pty)).toEqual([]);
    expect((await w.run(run.id)).status).toBe('waiting');

    // Settings still answers the terminal for pi.
    expect((await w.call('POST', '/coders/pi/login')).status).toBe(409);

    piChecks({ anthropic: 'oauth' });
    const checked = await w.call('POST', '/coders/pi/check');
    expect(checked.status).toBe(200);
    const [ended] = await w.t.db
      .select()
      .from(schema.coderLogins)
      .where(eq(schema.coderLogins.id, login!.id));
    expect(ended).toMatchObject({
      status: 'signed_in',
      accountLabel: 'Anthropic (Claude Pro/Max)',
    });
    expect(await widgetState(message!.id)).toMatchObject({ status: 'signed_in' });
    const resumed = await w.run(run.id);
    expect(resumed.status).toBe('queued');
    expect((resumed.state as RunState).resume?.output).toMatchObject({ signed_in: true });
  });

  it("stores pi's own API key as api_key, with no provider and no key text", async () => {
    await setAccount('pi', { authKind: 'none', accountLabel: null, lastError: null });
    piChecks({ openai: 'api_key' });
    const res = await w.call('POST', '/coders/pi/check');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { account: unknown }).account).toMatchObject({
      authKind: 'api_key',
      providerId: null,
      accountLabel: 'API key through pi (OpenAI)',
      needsSignIn: false,
      lastErrorKind: null,
    });
  });

  it("stores Codex's API key login as api_key without the status line", async () => {
    w.coder.agent = (io) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'codex' && args.join(' ') === 'login status') {
        io.stdout('Logged in using an API key - sk-proj-***WXYZ\n');
      }
      io.exit(0);
    };
    const res = await w.call('POST', '/coders/codex/check');
    expect(res.status).toBe(200);
    const { account } = (await res.json()) as { account: Record<string, unknown> };
    expect(account).toMatchObject({
      authKind: 'api_key',
      providerId: null,
      accountLabel: 'API key through Codex',
    });
    expect(JSON.stringify(account)).not.toContain('WXYZ');
  });

  it('takes only the provider keys an agent can use', async () => {
    const add = async (body: Record<string, unknown>) => {
      const res = await w.call('POST', '/providers', body);
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const google = await add({
      presetId: 'google',
      apiKey: 'google-coder-key',
      slug: 'google-coder',
      name: 'Google for coding',
    });
    const custom = await add({
      name: 'Local OpenAI',
      protocol: 'openai_compatible',
      baseUrl: 'https://203.0.113.40/v1',
      apiKey: 'local-key-0123456789',
      slug: 'local-openai',
      models: [{ modelId: 'm' }],
    });
    const put = (agent: string, providerId: string) =>
      w.call('PUT', `/coders/${agent}/api-key`, { providerId });

    expect((await put('pi', google)).status).toBe(200);
    const refused = await put('pi', custom);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      code: 'CODER_PROVIDER_UNSUPPORTED',
      title:
        'pi can use Anthropic, OpenAI, Google and xAI keys; custom endpoints are not supported yet',
    });
    expect((await put('codex', custom)).status).toBe(200);
    expect((await put('codex', google)).status).toBe(400);
    expect((await put('claude', custom)).status).toBe(400);
    expect((await put('claude', google)).status).toBe(400);
    await setAccount('pi', { authKind: 'none', providerId: null });
    await setAccount('codex', { authKind: 'none', providerId: null });
  });

  it('words a refused Codex sign-in plainly and logs what Codex said', async () => {
    const warn = vi.spyOn(w.t.deps.logger, 'warn');
    const raw = 'Error: unexpected status 401 Unauthorized: Missing bearer or basic authentication';
    w.coder.agent = (io) => {
      if (io.call.launch.args?.includes('--version')) return io.exit(0);
      io.stdout(`${raw}\r\n`);
      io.exit(1);
    };
    const asked = await w.t.inOrganization(() =>
      startLogin(w.t.ownerDeps, { id: w.ownerId, workspaceId: w.workspaceId }, 'codex'),
    );
    await w.t.inOrganization(() => runCoderLogin(w.t.deps, asked.login.id));
    const [row] = await w.t.db
      .select()
      .from(schema.coderLogins)
      .where(eq(schema.coderLogins.id, asked.login.id));
    expect(row).toMatchObject({ status: 'failed', error: CODEX_SIGN_IN_REFUSED });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ loginId: asked.login.id, output: expect.stringContaining('401') }),
      expect.any(String),
    );
    warn.mockRestore();
  });
});
