import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CoderExit, CoderPermissionRequest, CoderProcess } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  CoderActionClassSchema,
  coderActionDecision,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_MAX_TURNS,
  DEFAULT_SESSION_MINUTES,
  resolveToolPolicy,
  type CoderActionClass,
  type CoderAgent,
  type CoderChangedFile,
  type CoderCommit,
  type CoderControl,
  type CoderEvent,
  type CoderMode,
  type CodingSessionStatus,
  type JobHandler,
  type PolicyDecision,
  type RunSource,
} from '@openbots/shared';
import {
  widgetToolResult,
  type CodingSessionState,
  type CodingSessionStateResult,
} from '@openbots/widgets';
import { and, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { GITHUB_API } from '../builtins/github.js';
import { DomainError } from '../errors.js';
import {
  announceApproval,
  approvalTtlMs,
  audit,
  expireSessionApprovals,
  type ApprovalRow,
} from './approvals.js';
import { adapterFor, type CoderAdapter } from './coder-adapters/index.js';
import type { CoderSessionSpec } from './coder-adapters/types.js';
import { subscribeCoderControl } from './coder-control.js';
import { enqueueCoderJob, type CoderJob } from './coder-jobs.js';
import { runCoderLogin, signInErrorForOwner, startLogin } from './coder-login.js';
import {
  appendFeed,
  applyEvent,
  feedLine,
  flushFeed,
  SESSION_LOG_FULL,
  SESSION_LOG_MAX,
  sessionLogPath,
  setApproval,
  setApprovalStatus,
  setSessionStatus,
  settleSession,
  type CodingSessionRow,
} from './coder-state.js';
import { createArtifact, writeArtifact } from './artifacts.js';
import { agentFor, EXEC_TOUCH_MS, startComputer, touchComputer } from './computer.js';
import { pullRequestToken, resolveGitCredential } from './git-credentials.js';
import { runSource } from './policy.js';
import { providerConfig, type ProviderRow } from './providers.js';
import {
  assertRunnable,
  ensureCheckout,
  ensureWorktree,
  remoteOf,
  runGit,
  type GitContext,
  type RepoRow,
} from './repos-checkout.js';
import { reconcileComputer, refreshStates, runRescueJob, scanComputer } from './repos-jobs.js';
import { resumeRun, type RunRow } from './runs.js';

// The coding session runner (I12): the `coders` queue's one handler. A
// `session` job is one coding session, start to end, like a run job is one
// run: it claims the row (queued to starting), makes the checkout current
// and the session's worktree, starts the adapter's CLI in the computer over
// WS /coder as the `coder` user, and turns its output into the widget's feed
// (coder-state.ts) and a log file. The agent's permission prompts are
// answered from the Bot's coder policy: `auto` at once, `deny` at once, and
// `ask` through an `approvals` row the owner decides like any other, whose
// decision comes back on openbots:coder-control (coder-control.ts). git's
// credential requests are answered by git-credentials.ts, which serves a push
// only once the owner approved one. When the CLI exits the runner reads the
// branch's commits and changes from git, in `pr` mode asks once to push and
// open the pull request and does both itself, settles the session and
// resumes the run that waits on the widget with the outcome.
//
// While a session runs the computer is marked used every minute, so the idle
// sweep leaves it up, and the session stops at its time limit. Sessions an
// interrupted process leaves behind fail with a note at the next start
// (`recoverInterruptedCoderSessions`); the owner continues them.
//
// `checkout` jobs make a checkout current (repos-checkout.ts) and `login`
// jobs drive a vendor sign-in (coder-login.ts).

export const RESTART_NOTE =
  'The server restarted during the session; continue it to pick up where it left off';
/** `coding_sessions.error` when the CLI is not signed in: the machine-readable marker. */
export const NEEDS_LOGIN = 'needs_login';
/** What the widget says instead of NEEDS_LOGIN. */
export const needsLoginText = (label: string) =>
  `${label} is not signed in on this computer. Sign in under Settings > Coding agents, then ask again.`;
/** The pull request approval's tool name. */
export const PR_TOOL = 'open_pull_request';

/** The statuses a session runs in; a job finding one it does not run treats it as interrupted. */
const LIVE: CodingSessionStatus[] = ['starting', 'running', 'waiting'];
/** How long a stopped CLI has between SIGTERM and the socket closing. */
const STOP_GRACE_MS = 5_000;
/** How long the runner waits for the run to finish pausing before it resumes it. */
const RUN_WAIT_MS = 30_000;
/** A session over the account's limit tries again after this long. */
const BUSY_RETRY_MS = 30_000;
/** The stderr kept for an error message. */
const STDERR_MAX = 16 * 1024;
/** What a provider key reads as wherever the session's output is kept or shown. */
export const KEY_MASK = '[key]';
/** The feed line a Codex session starts with: it gets no OpenBots approvals. */
export const CODEX_POSTURE =
  'Codex works inside its own sandbox and does not ask for approvals; OpenBots still gates pushes.';
/** `coding_sessions.error` and the account's `last_error` when an `api_key` account's key is refused. */
export const keyRejectedText = (provider: string, label: string) =>
  `The ${provider} API key for ${label} was rejected. Check it under Settings > Models.`;
/** What a provider answers a key it does not take with. */
const KEY_REFUSED = /\b401\b|unauthori[sz]ed/i;
/** The commit message of what a session left uncommitted. */
export const leftoverCommitMessage = (label: string) =>
  `${label}: changes from an OpenBots session`;

export interface CoderRunnerOptions {
  /** How often a running session marks the computer used; EXEC_TOUCH_MS by default. */
  touchMs?: number;
  /** The session's time limit; DEFAULT_SESSION_MINUTES by default. */
  sessionMinutes?: number;
  stopGraceMs?: number;
  runWaitMs?: number;
  /** The GitHub REST API base, for the pull request; tests stand in a fake. */
  githubApi?: string;
  /** Starts the vendor sign-in a session that is not signed in waits on; tests stand in a fake. */
  startLogin?: typeof startLogin;
}

/** A session this process runs: how the control channel reaches it. */
interface LiveSession {
  workspaceId: string;
  computerId: string | null;
  control(msg: CoderControl): void;
}

export type LiveSessions = Map<string, LiveSession>;

/** The `coders` queue handler; `startWorkers` registers one per process. */
export function createCoderWorker(
  deps: AppDeps,
  options: CoderRunnerOptions = {},
): JobHandler<CoderJob> {
  const live: LiveSessions = new Map();
  let subscribed: Promise<unknown> | null = null;
  const listen = () =>
    (subscribed ??= subscribeCoderControl(deps, (msg) => {
      if (msg.type === 'stop_all') {
        for (const [sessionId, session] of live) {
          if (session.computerId === msg.computerId) session.control({ type: 'stop', sessionId });
        }
        return;
      }
      live.get(msg.sessionId)?.control(msg);
    }));
  return async (job) => {
    await listen();
    const data = job.data;
    switch (data.kind) {
      case 'session':
        return runSession(deps, data.sessionId, { live, options });
      case 'checkout':
        await ensureCheckout(deps, data.repoId, data.computerId, data.action);
        return;
      case 'login':
        return runCoderLogin(deps, data.loginId);
      case 'scan':
        await scanComputer(deps, data.computerId);
        return;
      case 'reconcile':
        await reconcileComputer(deps, data.computerId);
        return;
      case 'refresh':
        await refreshStates(deps, data.computerId);
        return;
      case 'rescue':
        return runRescueJob(deps, data);
    }
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new session's branch when `code_task` named none: `bot/<words of the prompt>-<id>`. */
export function defaultBranch(session: Pick<CodingSessionRow, 'id' | 'prompt'>): string {
  const words = session.prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `bot/${words || 'session'}-${session.id.slice(0, 6)}`;
}

/** The policy's decision for every action class, for the adapter's pre-allowed tools. */
function decisions(
  policy: ReturnType<typeof resolveToolPolicy>,
  source: RunSource,
): Record<CoderActionClass, PolicyDecision> {
  return Object.fromEntries(
    CoderActionClassSchema.options.map((action) => [
      action,
      coderActionDecision(policy, source, action),
    ]),
  ) as Record<CoderActionClass, PolicyDecision>;
}

/**
 * One coding session, start to end. Exits at once when the session is not
 * `queued` (another job has it, or it ended); one left running by a process
 * that is gone fails with the restart note.
 */
export async function runSession(
  deps: AppDeps,
  sessionId: string,
  { live = new Map(), options = {} }: { live?: LiveSessions; options?: CoderRunnerOptions } = {},
): Promise<void> {
  const [existing] = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId));
  if (!existing) return;
  if (existing.status !== 'queued') {
    if (LIVE.includes(existing.status as CodingSessionStatus) && !live.has(sessionId)) {
      await interruptSession(deps, existing, options);
    }
    return;
  }
  // The account's sessions at once (DEFAULT_MAX_CONCURRENT_SESSIONS): the next one waits.
  // The count and the claim hold the owner's lock, so two jobs cannot both
  // see room for one more.
  const claim = await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`coder-owner:${existing.ownerId}`}))`,
    );
    const [busy] = await tx
      .select({ n: count() })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.ownerId, existing.ownerId),
          inArray(schema.codingSessions.status, LIVE),
          ne(schema.codingSessions.id, sessionId),
        ),
      );
    if ((busy?.n ?? 0) >= DEFAULT_MAX_CONCURRENT_SESSIONS) return 'busy' as const;
    const [row] = await tx
      .update(schema.codingSessions)
      .set({ status: 'starting', error: null, finishedAt: null, updatedAt: new Date() })
      .where(
        and(eq(schema.codingSessions.id, sessionId), eq(schema.codingSessions.status, 'queued')),
      )
      .returning();
    return row ?? null;
  });
  if (claim === 'busy') {
    appendFeed(deps, sessionId, feedLine('text', 'Waiting for another coding session to finish'));
    await enqueueCoderJob(deps, { kind: 'session', sessionId }, { delayMs: BUSY_RETRY_MS });
    return;
  }
  const claimed = claim;
  if (!claimed) return;
  const runner = new SessionRunner(deps, claimed, options);
  live.set(sessionId, {
    workspaceId: claimed.workspaceId,
    get computerId() {
      return runner.computerId;
    },
    control: (msg) => {
      inWorkspace(claimed.workspaceId, () => runner.control(msg)).catch((error: unknown) =>
        deps.logger.warn({ err: error, sessionId }, 'coder control failed'),
      );
    },
  });
  try {
    await runner.run();
  } finally {
    live.delete(sessionId);
  }
}

/** A session left running by a process that is gone: failed with the note, its run told. */
async function interruptSession(
  deps: AppDeps,
  row: CodingSessionRow,
  options: CoderRunnerOptions = {},
) {
  await expireSessionApprovals(deps, row.id);
  const state = await settleSession(deps, row.id, { status: 'failed', error: RESTART_NOTE });
  if (row.runId) {
    await resumeWaitingRun(deps, row.runId, widgetToolResult('coding_session', state), {
      waitMs: options.runWaitMs ?? 0,
    });
  }
}

/**
 * Sessions an interrupted process left behind, at worker start (in-memory
 * infra, as `recoverInterruptedRuns`): a session that was running fails
 * with RESTART_NOTE and its run resumes with that (its log stays, since the
 * owner can continue it); a queued one, whose job died with the process, is
 * queued again. Logs whose session is gone are removed.
 */
export async function recoverInterruptedCoderSessions(deps: AppDeps): Promise<number> {
  const rows = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(inArray(schema.codingSessions.status, [...LIVE, 'queued']));
  for (const row of rows) {
    if (row.status === 'queued') {
      await enqueueCoderJob(deps, { kind: 'session', sessionId: row.id });
    } else {
      await interruptSession(deps, row);
    }
  }
  await removeOrphanLogs(deps).catch((error: unknown) =>
    deps.logger.warn({ err: error }, 'coding session logs not swept'),
  );
  return rows.length;
}

/** Session logs on the server whose `coding_sessions` row is gone. */
export async function removeOrphanLogs(deps: AppDeps): Promise<number> {
  const dir = path.join(deps.config.filesDir, 'coders');
  const names = await readdir(dir).catch(() => [] as string[]);
  const ids = names
    .map((name) => /^([0-9a-f-]{36})\.log$/i.exec(name)?.[1])
    .filter((id): id is string => !!id);
  if (!ids.length) return 0;
  const known = new Set(
    (
      await deps.db
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(inArray(schema.codingSessions.id, ids))
    ).map((row) => row.id),
  );
  let removed = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    await rm(path.join(dir, `${id}.log`), { force: true });
    removed++;
  }
  return removed;
}

/**
 * Resumes the run waiting on a session's widget with `output`. `code_task`
 * pauses its run after it posts the widget, so a session that ends quickly
 * can beat the pause: the run is given `waitMs` to get there.
 */
export async function resumeWaitingRun(
  deps: Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>,
  runId: string,
  output: unknown,
  { waitMs = RUN_WAIT_MS }: { waitMs?: number } = {},
): Promise<RunRow | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [run] = await deps.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    if (run?.status === 'waiting') {
      return resumeRun(deps, runId, output).catch((error: unknown) => {
        deps.logger.info({ err: error, runId }, 'coding session outcome not resumed');
        return null;
      });
    }
    if (!run || (run.status !== 'running' && run.status !== 'queued') || Date.now() >= deadline) {
      deps.logger.info({ runId, status: run?.status }, 'no run waits on the coding session');
      return null;
    }
    await sleep(250);
  }
}

/**
 * For the services: a run that paused on a session which had already
 * ended (the race `resumeWaitingRun` waits out, past its wait) resumes now.
 */
export async function resumeIfSessionEnded(deps: AppDeps, sessionId: string): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId));
  if (!row?.runId || !['settled', 'failed', 'stopped'].includes(row.status)) return;
  if (!row.messageId || row.partIndex === null) return;
  const [stored] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, row.messageId),
        eq(schema.widgetStates.partIndex, row.partIndex),
      ),
    );
  if (!stored) return;
  await resumeWaitingRun(
    deps,
    row.runId,
    widgetToolResult('coding_session', stored.state as CodingSessionState),
    { waitMs: 0 },
  );
}

type ResultEvent = Extract<CoderEvent, { type: 'result' }>;

type AccountRow = typeof schema.coderAccounts.$inferSelect;

/** How a session's tokens are billed, from its account's `auth_kind`. */
export function accountBilling(
  account: Pick<AccountRow, 'authKind'> | null | undefined,
): 'subscription' | 'api' | 'unknown' {
  if (account?.authKind === 'subscription') return 'subscription';
  if (account?.authKind === 'api_key') return 'api';
  return 'unknown';
}

/** The provider fields the launch env is made from; `apiKey` is the opened secret. */
export type CoderProvider = Pick<ProviderRow, 'kind' | 'protocol' | 'name'> & {
  baseUrl: string | null;
  apiKey: string | null;
};

const notUsable = (label: string, provider: Pick<CoderProvider, 'name'>, why: string) =>
  new DomainError(
    400,
    'CODER_PROVIDER_UNSUPPORTED',
    `${label} cannot use the ${provider.name} key: ${why}. Pick another provider under Settings > Coding agents, or sign in with a plan.`,
  );

/**
 * The variables that hand an \`api_key\` account's provider key to the CLI,
 * in the vendor's names: Claude Code reads ANTHROPIC_API_KEY (and
 * ANTHROPIC_BASE_URL), Codex OPENAI_API_KEY or CODEX_API_KEY (and
 * OPENAI_BASE_URL), pi one variable per provider (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY) and no base URL, since pi
 * takes a custom endpoint only from its own models.json. Anything the CLI
 * cannot use is refused with the reason. The values go only into that
 * session's process; never log them.
 */
export function coderProviderEnv(
  agent: CoderAgent,
  provider: CoderProvider,
): Record<string, string> {
  const label = CODER_AGENT_LABELS[agent];
  const key = provider.apiKey?.trim();
  if (!key) throw notUsable(label, provider, 'the provider has no API key');
  const baseUrl = provider.baseUrl?.trim() || null;
  const { kind, protocol } = provider;
  const anthropic =
    protocol === 'anthropic_compatible' || (protocol === 'native' && kind === 'anthropic');
  const openai = protocol === 'openai_compatible' || (protocol === 'native' && kind === 'openai');
  switch (agent) {
    case 'claude':
      if (!anthropic) throw notUsable(label, provider, 'Claude Code takes an Anthropic key only');
      return { ANTHROPIC_API_KEY: key, ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}) };
    case 'codex':
      if (!openai) throw notUsable(label, provider, 'Codex takes an OpenAI key only');
      return {
        OPENAI_API_KEY: key,
        CODEX_API_KEY: key,
        ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
      };
    case 'pi': {
      if (protocol !== 'native') {
        throw notUsable(label, provider, 'pi does not take a custom endpoint from the environment');
      }
      const names: Partial<Record<typeof kind, string>> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GEMINI_API_KEY',
        xai: 'XAI_API_KEY',
      };
      const name = names[kind];
      if (!name) throw notUsable(label, provider, 'pi has no variable for this provider');
      return { [name]: key };
    }
  }
}

/** The most of a branch's diff that goes into its Artifact. */
export const DIFF_MAX_CHARS = 1024 * 1024;
export const DIFF_TRUNCATED = '\n[openbots] The diff is longer than 1 MB; the rest is not shown\n';

/** One session's job: everything it holds while the CLI runs. */
/** A name fit for a git identity or trailer: one line, no angle brackets. */
const oneLine = (text: string) =>
  text
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

class SessionRunner {
  computerId: string | null = null;
  private session: CodingSessionRow;
  private proc: CoderProcess | null = null;
  private exited: Promise<CoderExit> | null = null;
  private pushAllowed: boolean;
  private stopped = false;
  private timedOut = false;
  /** Pending permission prompts by approval id: the agent's request id. */
  private prompts = new Map<string, string>();
  /** Approvals the runner itself waits on (the pull request), by approval id. */
  private waiters = new Map<string, (decision: 'approved' | 'denied' | 'expired') => void>();
  /** Decisions that came before their approval was registered, by approval id. */
  private early = new Map<string, 'approved' | 'denied'>();
  /** The session is settling: late decisions are ignored. */
  private ending = false;
  private result: ResultEvent | null = null;
  private errors: string[] = [];
  private stderr = '';
  /** Stderr after its last newline: logged once the line is whole, so a key is never split. */
  private stderrPartial = '';
  /** The provider key in the session's environment, masked out of everything kept (`scrub`). */
  private secret: string | null = null;
  /** The `api_key` account's provider, for the launch and a refused key's message. */
  private keyProvider: { kind: string; name: string } | null = null;
  /** The Bot's git identity and the owner's trailer, for the runner's own commit. */
  private identity: Pick<CoderSessionSpec, 'gitIdentity' | 'coAuthor'> = {};
  /** Events and prompts in arrival order. */
  private chain: Promise<unknown> = Promise.resolve();
  private logChain: Promise<unknown> = Promise.resolve();
  private logPath: string | null = null;
  /** The log's size; at SESSION_LOG_MAX it gets one marker line and nothing more. */
  private logBytes = 0;
  private logFull = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private touch: ReturnType<typeof setInterval> | null = null;
  private git: GitContext | null = null;
  private bot: typeof schema.bots.$inferSelect | null = null;
  private repo: RepoRow | null = null;
  /** The checkout the session's worktree is in: `assertRunnable` checks it before runner git. */
  private repoPath: string | null = null;
  private adapter: CoderAdapter | null = null;
  /** The owner's `coder_accounts` row for the session's agent, if any. */
  private account: AccountRow | null = null;
  private policy: ReturnType<typeof resolveToolPolicy> = resolveToolPolicy({});
  private source: RunSource = 'owner';

  constructor(
    private deps: AppDeps,
    session: CodingSessionRow,
    private options: CoderRunnerOptions,
  ) {
    this.session = session;
    this.pushAllowed = session.pushAllowed;
  }

  private get id() {
    return this.session.id;
  }

  private get owner() {
    return { id: this.session.ownerId, workspaceId: this.session.workspaceId };
  }

  async run(): Promise<void> {
    const { deps } = this;
    try {
      await setSessionStatus(deps, this.id, 'starting');
      await this.prepare();
      if (this.stopped) return await this.finish({ code: null, signal: 'SIGTERM' });
      const exit = await this.launch();
      await this.finish(exit);
    } catch (error) {
      deps.logger.warn({ err: error, sessionId: this.id }, 'coding session failed');
      await this.fail(errorText(error));
    } finally {
      for (const timer of this.timers) clearTimeout(timer);
      if (this.touch) clearInterval(this.touch);
      await this.proc?.close().catch(() => {});
    }
  }

  /** The Bot, the policy, the computer, the checkout and the worktree. */
  private async prepare() {
    const { deps, session } = this;
    const [bot] = await deps.db.select().from(schema.bots).where(eq(schema.bots.id, session.botId));
    if (!bot) throw new Error('The Bot is gone');
    this.bot = bot;
    this.policy = resolveToolPolicy(bot.toolPolicy);
    const [run] = session.runId
      ? await deps.db.select().from(schema.runs).where(eq(schema.runs.id, session.runId))
      : [];
    this.source = run ? runSource(run) : 'owner';
    this.adapter = adapterFor(session.agent as CoderAgent);
    const [account] = await deps.db
      .select()
      .from(schema.coderAccounts)
      .where(
        and(
          eq(schema.coderAccounts.ownerId, session.ownerId),
          eq(schema.coderAccounts.workspaceId, session.workspaceId),
          eq(schema.coderAccounts.agent, session.agent),
        ),
      );
    this.account = account ?? null;
    const [repo] = session.repoId
      ? await deps.db.select().from(schema.repos).where(eq(schema.repos.id, session.repoId))
      : [];
    if (!repo) throw new Error('The repository is no longer remembered; add it again first');
    this.repo = repo;

    const { computer } = await startComputer(deps, this.owner, { type: 'bot', id: bot.id });
    this.computerId = computer.id;
    this.git = {
      deps,
      agent: agentFor(deps, computer),
      owner: this.owner,
      repoFullName: remoteOf(repo).fullName,
    };

    const continuing = !!(session.vendorSessionId && session.worktreePath && session.branch);
    const branch = session.branch ?? defaultBranch(session);
    let worktree = session.worktreePath;
    const checkout = await ensureCheckout(deps, repo.id, computer.id, 'update');
    this.repoPath = checkout.path;
    // A base that is the stored default branch was a placeholder: the remote's own wins.
    const base =
      !session.base || session.base === repo.defaultBranch ? checkout.defaultBranch : session.base;
    if (!continuing || !worktree) {
      worktree = await ensureWorktree(this.git, checkout.path, branch, base);
    }
    this.logPath = sessionLogPath(deps, this.id);
    await mkdir(path.dirname(this.logPath), { recursive: true });
    this.logBytes = await stat(this.logPath).then(
      (info) => info.size,
      () => 0,
    );
    this.logFull = this.logBytes >= SESSION_LOG_MAX;
    const startedAt = session.startedAt ?? new Date();
    await setSessionStatus(deps, this.id, 'running', {
      worktreePath: worktree,
      branch,
      base,
      startedAt,
      logPath: this.logPath,
    });
    this.session = { ...session, worktreePath: worktree, branch, base, startedAt };
    const label = CODER_AGENT_LABELS[session.agent as CoderAgent] ?? session.agent;
    appendFeed(
      deps,
      this.id,
      feedLine('text', `${continuing ? 'Continued' : 'Started'} ${label} in ${worktree}`),
    );
    if (session.agent === 'codex') appendFeed(deps, this.id, feedLine('text', CODEX_POSTURE));
  }

  /** Starts the CLI and resolves when it ends. */
  private async launch(): Promise<CoderExit> {
    const { deps, session } = this;
    const adapter = this.adapter!;
    const agent = session.agent as CoderAgent;
    const model = this.policy.coder.models?.[agent];
    const keyEnv = await this.providerEnv();
    this.identity = await this.gitIdentity();
    const plan = adapter.launch({
      sessionId: session.id,
      agent: session.agent as CoderAgent,
      mode: session.mode as CoderMode,
      prompt: session.prompt,
      worktreePath: session.worktreePath!,
      ...(this.repoPath ? { repoPath: this.repoPath } : {}),
      repoFullName: remoteOf(this.repo!).fullName,
      branch: session.branch!,
      base: session.base!,
      ...(session.vendorSessionId ? { resumeId: session.vendorSessionId } : {}),
      ...(model ? { model } : {}),
      ...(this.keyProvider ? { apiKeyProvider: this.keyProvider.kind } : {}),
      maxTurns: DEFAULT_MAX_TURNS,
      actions: decisions(this.policy, this.source),
      ...this.identity,
    });
    const parser = adapter.parser({
      billing: accountBilling(this.account),
      worktreePath: session.worktreePath!,
    });
    let partial = '';
    let resolveExit!: (exit: CoderExit) => void;
    const exited = new Promise<CoderExit>((resolve) => (resolveExit = resolve));
    this.exited = exited;
    const onLine = (raw: string) => {
      // The key is masked before the line is logged or parsed, so no feed
      // line, result or error made from it can carry it.
      const line = this.scrub(raw);
      this.log(line);
      for (const event of parser.line(line)) this.enqueue(() => this.onEvent(event));
    };
    const onStderr = (data: string, flush = false) => {
      const text = this.stderrPartial + data;
      const cut = flush ? text.length : text.lastIndexOf('\n') + 1;
      this.stderrPartial = text.slice(cut);
      const whole = this.scrub(text.slice(0, cut));
      if (!whole) return;
      this.log(`[stderr] ${whole.replace(/\n$/, '')}`);
      this.stderr = (this.stderr + whole).slice(-STDERR_MAX);
    };
    this.proc = await this.git!.agent.coder(
      {
        session_id: session.id,
        user: 'coder',
        command: plan.command,
        args: plan.args,
        // The provider key goes to this process only, never into a log line.
        env: { ...plan.env, ...keyEnv },
        cwd: session.worktreePath!,
        pty: plan.pty ?? false,
        git_credentials: true,
      },
      {
        stdout: (data) => {
          partial += data;
          const lines = partial.split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) onLine(line);
        },
        stderr: (data) => onStderr(data),
        permissionRequest: (request) => this.enqueue(() => this.onPermission(request)),
        credentialRequest: (request) => {
          resolveGitCredential(deps, {
            ownerId: session.ownerId,
            workspaceId: session.workspaceId,
            host: request.host,
            path: request.path,
            username: request.username,
            sessionId: session.id,
            session: { pushAllowed: this.pushAllowed, repoFullName: remoteOf(this.repo!).fullName },
          })
            .then((answer) => this.proc?.credential({ request_id: request.request_id, ...answer }))
            .catch((error: unknown) => {
              deps.logger.warn({ err: error, sessionId: session.id }, 'git credential failed');
              this.safely(() =>
                this.proc?.credential({ request_id: request.request_id, denied: 'No credential' }),
              );
            });
        },
        error: (message) => this.errors.push(this.scrub(message)),
        exit: (info) => resolveExit(info),
      },
    );
    // Once it runs: the plan's stdin, then EOF, since `claude -p` and `codex
    // exec` read a piped stdin to its end before they start. A terminal keeps its input.
    const proc = this.proc;
    void proc.started
      .then(() => {
        if (plan.stdin !== undefined) this.safely(() => proc.write(plan.stdin!));
        if (!plan.pty) this.safely(() => proc.end());
      })
      .catch(() => {
        // It never started; the exit says why.
      });
    this.touch = setInterval(() => {
      if (!this.computerId) return;
      touchComputer(deps, this.computerId).catch((error: unknown) =>
        deps.logger.warn({ err: error, sessionId: session.id }, 'marking the computer used failed'),
      );
    }, this.options.touchMs ?? EXEC_TOUCH_MS);
    this.touch.unref?.();
    const minutes = this.options.sessionMinutes ?? DEFAULT_SESSION_MINUTES;
    const limit = setTimeout(() => {
      this.timedOut = true;
      this.stopProcess();
    }, minutes * 60_000);
    limit.unref?.();
    this.timers.push(limit);

    const exit = await exited;
    if (partial.trim()) onLine(partial);
    if (this.stderrPartial) onStderr('', true);
    for (const event of parser.end()) this.enqueue(() => this.onEvent(event));
    await this.chain;
    await this.logChain;
    return exit;
  }

  /**
   * An \`api_key\` account's provider key in the CLI's variables
   * (`coderProviderEnv`); nothing for a plan sign-in. The provider must
   * still be the owner's or the instance's.
   */
  private async providerEnv(): Promise<Record<string, string>> {
    const account = this.account;
    if (account?.authKind !== 'api_key') return {};
    const label = CODER_AGENT_LABELS[this.session.agent as CoderAgent];
    const [row] = account.providerId
      ? await this.deps.db
          .select()
          .from(schema.providers)
          .where(
            and(
              eq(schema.providers.id, account.providerId),
              eq(schema.providers.workspaceId, this.session.workspaceId),
              or(
                isNull(schema.providers.ownerId),
                eq(schema.providers.ownerId, this.session.ownerId),
              ),
            ),
          )
      : [];
    if (!row) {
      throw new DomainError(
        400,
        'CODER_PROVIDER_MISSING',
        `${label} is set to use an API key, but its provider is gone. Pick one under Settings > Coding agents.`,
      );
    }
    const { apiKey, baseUrl } = providerConfig(this.deps, row);
    const env = coderProviderEnv(this.session.agent as CoderAgent, {
      kind: row.kind,
      protocol: row.protocol,
      name: row.name,
      baseUrl,
      apiKey,
    });
    this.secret = apiKey?.trim() || null;
    this.keyProvider = { kind: row.kind, name: row.name };
    return env;
  }

  /** Text with the session's provider key masked: everything kept or shown passes through this. */
  private scrub(text: string): string {
    const key = this.secret;
    return key && text.includes(key) ? text.split(key).join(KEY_MASK) : text;
  }

  /**
   * Who the commits are by (GH8): the Bot as author and committer,
   * `<Bot name> (OpenBots)` at `<bot handle>@openbots.local`, and the owner
   * credited as co-author, with their name and address.
   */
  private async gitIdentity(): Promise<
    Required<Pick<CoderSessionSpec, 'gitIdentity'>> & Pick<CoderSessionSpec, 'coAuthor'>
  > {
    const bot = this.bot!;
    const [owner] = await this.deps.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, this.session.ownerId))
      .catch(() => []);
    const gitIdentity = {
      name: `${oneLine(bot.name)} (OpenBots)`,
      email: `${bot.handle}@openbots.local`,
    };
    const name = owner ? oneLine(owner.name) || owner.email : '';
    return owner?.email && !/[<>\s]/.test(owner.email)
      ? { gitIdentity, coAuthor: { name, email: owner.email } }
      : { gitIdentity };
  }

  private enqueue(fn: () => Promise<unknown>) {
    this.chain = this.chain
      .then(fn)
      .catch((error: unknown) =>
        this.deps.logger.warn({ err: error, sessionId: this.id }, 'coding session event failed'),
      );
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (error) {
      this.deps.logger.info({ err: error, sessionId: this.id }, 'the session process had ended');
    }
  }

  private log(line: string) {
    const file = this.logPath;
    if (!file || this.logFull) return;
    let text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.logBytes + bytes > SESSION_LOG_MAX) {
      this.logFull = true;
      text = `${SESSION_LOG_FULL}\n`;
    }
    this.logBytes += Buffer.byteLength(text);
    this.logChain = this.logChain
      .then(() => appendFile(file, text))
      .catch((error: unknown) =>
        this.deps.logger.warn({ err: error, sessionId: this.id }, 'session log not written'),
      );
  }

  private async onEvent(event: CoderEvent) {
    // Kept as the CLI said it, for `finish` to read.
    if (event.type === 'result') this.result = event;
    if (event.type === 'error') this.errors.push(event.message);
    // A plan sign-in's refusal reads as plain words in the feed and widget;
    // the vendor's own text stays in the session log.
    if (this.account?.authKind !== 'api_key') {
      const plain = (text: string) => signInErrorForOwner(this.session.agent as CoderAgent, text);
      if (event.type === 'error') event = { ...event, message: plain(event.message) };
      else if (event.type === 'result' && !event.ok) {
        event = {
          ...event,
          summary: plain(event.summary),
          ...(event.error ? { error: plain(event.error) } : {}),
        };
      }
    }
    await applyEvent(this.deps, this.id, event);
  }

  private answer(requestId: string, decision: 'allow' | 'deny', message?: string) {
    this.safely(() =>
      this.proc?.answer({ request_id: requestId, decision, ...(message ? { message } : {}) }),
    );
  }

  private async onPermission(request: CoderPermissionRequest) {
    const { deps } = this;
    const classed = this.adapter!.classify(request.tool_name, request.input, {
      worktreePath: this.session.worktreePath!,
    });
    const decision = coderActionDecision(this.policy, this.source, classed.action);
    if (decision === 'auto') {
      this.answer(request.request_id, 'allow');
      appendFeed(deps, this.id, feedLine('approval_request', `Allowed: ${classed.title}`));
      return;
    }
    if (decision === 'deny' || !this.session.runId) {
      this.answer(
        request.request_id,
        'deny',
        "The owner's settings for this Bot do not allow this. Carry on without it.",
      );
      appendFeed(deps, this.id, feedLine('approval_request', `Not allowed: ${classed.title}`));
      return;
    }
    await this.askOwner(
      {
        action: classed.action,
        title: classed.title,
        ...(classed.detail ? { detail: classed.detail } : {}),
        toolName: request.tool_name,
        input: request.input,
      },
      (approvalId) => this.prompts.set(approvalId, request.request_id),
    );
  }

  /**
   * An `approvals` row for the session (I13), as a paused run's would be:
   * the audit entry, `approval.requested`, the expiry job, and the request
   * on the widget. `register` maps the row to whatever waits on it right
   * after the insert, before anyone can see the request, so no decision
   * finds nothing waiting; the session is `waiting` from then too.
   */
  private async askOwner(
    input: {
      action: CoderActionClass;
      title: string;
      detail?: string;
      toolName: string;
      input: unknown;
    },
    register: (approvalId: string) => void,
  ): Promise<ApprovalRow> {
    const { deps, session } = this;
    const args =
      typeof input.input === 'object' && input.input !== null && !Array.isArray(input.input)
        ? input.input
        : { input: input.input ?? null };
    const [row] = await deps.db
      .insert(schema.approvals)
      .values({
        workspaceId: session.workspaceId,
        runId: session.runId!,
        messageId: session.messageId,
        toolName: input.toolName,
        args: args as object,
        reason: input.title,
        sessionId: session.id,
        actionClass: input.action,
        expiresAt: new Date(Date.now() + approvalTtlMs(deps.config)),
      })
      .returning();
    register(row!.id);
    await setSessionStatus(deps, this.id, 'waiting');
    await audit(deps.db, {
      workspaceId: session.workspaceId,
      actorType: 'bot',
      actorId: session.botId,
      action: 'approval.requested',
      targetType: 'approval',
      targetId: row!.id,
      metadata: {
        runId: session.runId,
        sessionId: session.id,
        toolName: input.toolName,
        actionClass: input.action,
        reason: input.title,
      },
    });
    await setApproval(deps, session.id, {
      id: row!.id,
      action_class: input.action,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      status: 'pending',
    });
    appendFeed(deps, session.id, feedLine('approval_request', `Asks: ${input.title}`));
    await announceApproval(deps, row!);
    const early = this.early.get(row!.id);
    if (early) {
      this.early.delete(row!.id);
      await this.decide(row!.id, early);
    }
    return row!;
  }

  /** A message on the control channel for this session. */
  async control(msg: CoderControl): Promise<void> {
    const { deps } = this;
    switch (msg.type) {
      case 'stop':
        this.stopped = true;
        appendFeed(deps, this.id, feedLine('text', 'Stopped by the owner'));
        this.stopProcess();
        for (const resolve of this.waiters.values()) resolve('denied');
        return;
      case 'approval': {
        if (this.ending) return;
        if (await this.decide(msg.approvalId, msg.decision)) return;
        // Nothing waits on it yet: keep the decision when the row is this
        // session's and decided, for askOwner to apply once it registers.
        const [row] = await deps.db
          .select({ sessionId: schema.approvals.sessionId, status: schema.approvals.status })
          .from(schema.approvals)
          .where(eq(schema.approvals.id, msg.approvalId));
        if (row?.sessionId === this.id && row.status !== 'pending') {
          this.early.set(msg.approvalId, msg.decision);
        }
        return;
      }
      case 'push_allowed':
        this.pushAllowed = true;
        await deps.db
          .update(schema.codingSessions)
          .set({ pushAllowed: true, updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, this.id));
        return;
      case 'stdin':
        this.safely(() => this.proc?.write(msg.data));
        return;
      case 'stop_all':
        return;
    }
  }

  /**
   * Applies the owner's decision to what waits on the approval: the pull
   * request's wait, or the agent's prompt. False when nothing does.
   */
  private async decide(approvalId: string, decision: 'approved' | 'denied'): Promise<boolean> {
    const { deps } = this;
    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      this.waiters.delete(approvalId);
      waiter(decision);
      return true;
    }
    const requestId = this.prompts.get(approvalId);
    if (!requestId) return false;
    this.prompts.delete(approvalId);
    const approved = decision === 'approved';
    this.answer(
      requestId,
      approved ? 'allow' : 'deny',
      approved ? undefined : 'The owner said no. Carry on without it, or explain what you need.',
    );
    await setApprovalStatus(deps, this.id, approvalId, decision);
    appendFeed(
      deps,
      this.id,
      feedLine('approval_request', approved ? 'The owner approved' : 'The owner said no'),
    );
    if (!this.prompts.size && !this.stopped) await setSessionStatus(deps, this.id, 'running');
    return true;
  }

  /** SIGTERM, then the socket closes, which kills the process group. */
  private stopProcess() {
    const proc = this.proc;
    if (!proc) return;
    this.safely(() => proc.signal('SIGTERM'));
    const later = setTimeout(
      () => void proc.close().catch(() => {}),
      this.options.stopGraceMs ?? STOP_GRACE_MS,
    );
    later.unref?.();
    this.timers.push(later);
  }

  /**
   * Null when the runner may run git in the checkout again, else why not.
   * The session could write the checkout's `.git` while it ran, so every
   * runner git call after it ends is preceded by this (`assertRunnable`).
   */
  private async refusal(): Promise<string | null> {
    if (!this.git || !this.repoPath || !this.repo) return 'The checkout is not known';
    try {
      await assertRunnable(this.git, this.repoPath, this.repo);
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  /** The checkout was refused after the session: it fails with the reason, and the run hears it. */
  private async refused(message: string) {
    appendFeed(this.deps, this.id, feedLine('error', message));
    const state = await this.settle('failed', message);
    await this.resume(state, { note: message });
  }

  /** What the branch has against its base, from git; empty when git cannot say. */
  private async branchResult(): Promise<{ files: CoderChangedFile[]; commits: CoderCommit[] }> {
    const wt = this.session.worktreePath;
    const base = this.session.base;
    if (!this.git || !wt || !base) return { files: [], commits: [] };
    const range = `origin/${base}...HEAD`;
    const [numstat, names, log] = await Promise.all([
      runGit(this.git, ['-C', wt, 'diff', '--numstat', range]),
      runGit(this.git, ['-C', wt, 'diff', '--name-status', '--no-renames', range]),
      runGit(this.git, ['-C', wt, 'log', '--format=%H%x09%s', `origin/${base}..HEAD`]),
    ]);
    const kinds = new Map<string, CoderChangedFile['kind']>();
    if (names.code === 0) {
      for (const line of names.stdout.split('\n')) {
        const [status, file] = line.split('\t');
        if (!status || !file) continue;
        kinds.set(file, status === 'A' ? 'create' : status === 'D' ? 'delete' : 'edit');
      }
    }
    const files: CoderChangedFile[] = [];
    if (numstat.code === 0) {
      for (const line of numstat.stdout.split('\n')) {
        const [added, removed, ...rest] = line.split('\t');
        const file = rest.join('\t');
        if (!file) continue;
        files.push({
          path: file,
          // Binary files show `-`.
          added: Number(added) || 0,
          removed: Number(removed) || 0,
          kind: kinds.get(file) ?? 'edit',
        });
      }
    }
    const commits: CoderCommit[] = [];
    if (log.code === 0) {
      for (const line of log.stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        commits.push({ sha: line.slice(0, tab), title: line.slice(tab + 1) });
      }
    }
    return { files, commits };
  }

  /** The CLI ended: the outcome, the pull request in `pr` mode, the settle and the resume. */
  private async finish(exit: CoderExit) {
    const { deps, session } = this;
    const adapter = this.adapter;
    const label = CODER_AGENT_LABELS[session.agent as CoderAgent] ?? session.agent;
    // The CLI's own words only: the result's error, error events and
    // stderr. The model's summary is never read, since the model can write
    // anything there (a session about 401 handling, say).
    const said = [this.result?.ok ? '' : this.result?.error, this.stderr, ...this.errors]
      .filter(Boolean)
      .join('\n');
    const refusedOrSignedOut =
      !this.stopped &&
      !this.result?.ok &&
      !!said &&
      ((adapter?.needsLogin?.(said) ?? false) || KEY_REFUSED.test(said));
    // An `api_key` account is not signed in to anything: its provider
    // refused the key. That is the owner's to fix on the Models page; no
    // sign-in is posted and the account stays `api_key`.
    if (refusedOrSignedOut && this.account?.authKind === 'api_key') {
      const message = keyRejectedText(this.keyProvider?.name ?? 'provider', label);
      await deps.db
        .update(schema.coderAccounts)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(schema.coderAccounts.id, this.account.id));
      appendFeed(deps, this.id, feedLine('error', message));
      const state = await this.settle('failed', message);
      await this.resume(state, { note: message });
      return;
    }
    const needsLogin = refusedOrSignedOut && (adapter?.needsLogin?.(said) ?? false);
    if (needsLogin) {
      await deps.db
        .update(schema.coderAccounts)
        .set({ lastError: `${label} is not signed in on the computer`, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coderAccounts.ownerId, session.ownerId),
            eq(schema.coderAccounts.workspaceId, session.workspaceId),
            eq(schema.coderAccounts.agent, session.agent),
          ),
        );
      appendFeed(deps, this.id, feedLine('error', `${label} is not signed in on the computer`));
      // The run waits on the sign-in, which resumes it when it ends; without
      // one (no adapter, the computer off) it hears now.
      const waits = await this.askToSignIn(label);
      // A vendor 401 on a plan sign-in in plain words (Codex); else the sign-in hint.
      const refused = signInErrorForOwner(session.agent as CoderAgent, said);
      const shown = refused !== said ? refused : needsLoginText(label);
      const state = await this.settle('failed', NEEDS_LOGIN, undefined, shown);
      if (!waits) {
        await this.resume(state, {
          note: `${label} is not signed in on the computer. Ask the owner to sign in to ${label}, then continue the session with code_task and its session_id.`,
        });
      }
      return;
    }
    const failedExit = !this.result && !this.stopped && !this.timedOut && exit.code !== 0;
    if (failedExit) {
      const tail = this.stderr.trim().split('\n').filter(Boolean).slice(-3);
      for (const line of tail) appendFeed(deps, this.id, feedLine('error', line));
    }
    const before = await this.refusal();
    if (before) return this.refused(before);
    await this.commitLeftovers(label);
    const { files, commits } = await this.branchResult().catch((error: unknown) => {
      deps.logger.warn({ err: error, sessionId: this.id }, 'branch result unreadable');
      return { files: [] as CoderChangedFile[], commits: [] as CoderCommit[] };
    });
    let status: 'settled' | 'failed' | 'stopped' = this.stopped
      ? 'stopped'
      : failedExit
        ? 'failed'
        : 'settled';
    let error: string | null = null;
    if (this.timedOut) {
      const minutes = this.options.sessionMinutes ?? DEFAULT_SESSION_MINUTES;
      error = `The session reached its ${minutes} minute limit and was stopped`;
    } else if (failedExit) {
      error = this.scrub(
        exit.error ??
          this.stderr.trim().split('\n').filter(Boolean).pop() ??
          `${label} exited with code ${exit.code}`,
      );
    } else if (this.result && !this.result.ok) {
      error = this.result.error ?? this.result.summary;
    }
    const diffArtifactId = commits.length ? await this.diffArtifact() : null;
    let summary = this.result?.summary ?? '';
    let prUrl: string | undefined;
    if (status === 'settled' && session.mode === 'pr' && commits.length && !this.timedOut) {
      const pr = await this.pullRequest(summary, commits);
      if (pr.refused) return this.refused(pr.refused);
      prUrl = pr.url;
      if (pr.note) summary = summary ? `${summary}\n\n${pr.note}` : pr.note;
      if (this.stopped) status = 'stopped';
    }
    const [row] = await deps.db
      .select({ usage: schema.codingSessions.usage })
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, this.id));
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const result: CodingSessionStateResult = {
      summary,
      changed_files: files,
      commits,
      branch: session.branch ?? '',
      base: session.base ?? '',
      worktree_path: session.worktreePath ?? '',
      ...(prUrl ? { pr_url: prUrl } : {}),
      ...(row?.usage ? { usage: row.usage } : {}),
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(diffArtifactId ? { diff_artifact_id: diffArtifactId } : {}),
    };
    const state = await this.settle(status, error, result);
    await this.resume(state);
  }

  /**
   * The safety net under every `edit` and `pr` session, whatever the agent:
   * what it left uncommitted is committed by the runner (`git add -A`, then
   * one commit by the Bot with the owner's trailer), so the branch, its diff
   * and a pull request carry it. Runs after `assertRunnable`; nothing when
   * the tree is clean or the session only planned. A failure is logged and
   * left: the changes stay in the worktree.
   */
  private async commitLeftovers(label: string): Promise<void> {
    const { session } = this;
    const wt = session.worktreePath;
    if (!this.git || !wt || session.mode === 'plan') return;
    try {
      const status = await runGit(this.git, ['-C', wt, 'status', '--porcelain']);
      if (status.code !== 0 || !status.stdout.trim()) return;
      const added = await runGit(this.git, ['-C', wt, 'add', '-A']);
      if (added.code !== 0) throw new Error(added.stderr.trim() || `git add exited ${added.code}`);
      const { gitIdentity, coAuthor } = this.identity;
      const who = gitIdentity
        ? ['-c', `user.name=${gitIdentity.name}`, '-c', `user.email=${gitIdentity.email}`]
        : [];
      const trailer = coAuthor
        ? ['-m', `Co-Authored-By: ${coAuthor.name} <${coAuthor.email}>`]
        : [];
      const committed = await runGit(this.git, [
        ...who,
        '-C',
        wt,
        'commit',
        '--no-verify',
        '-m',
        leftoverCommitMessage(label),
        ...trailer,
      ]);
      if (committed.code !== 0) {
        throw new Error(committed.stderr.trim() || `git commit exited ${committed.code}`);
      }
      appendFeed(
        this.deps,
        this.id,
        feedLine('text', `Committed the changes ${label} left uncommitted`),
      );
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId: this.id }, 'leftover changes not committed');
    }
  }

  /**
   * CA5 View diff: `git diff origin/<base>...HEAD` in the worktree (at most
   * DIFF_MAX_CHARS, then a marker) as a code Artifact of the owner's, by the
   * session's Bot. A continued session's settle writes a new version of the
   * Artifact its last settle made, so they do not pile up; a new one only
   * when that is gone. Null when git or the store says no; the session
   * settles either way. Discard leaves the Artifact.
   */
  private async diffArtifact(): Promise<string | null> {
    const { deps, session } = this;
    const wt = session.worktreePath;
    if (!this.git || !wt || !session.base || !session.branch) return null;
    try {
      const diff = await runGit(this.git, ['-C', wt, 'diff', `origin/${session.base}...HEAD`], {
        headChars: DIFF_MAX_CHARS,
      });
      if (diff.code !== 0 && !diff.truncated) return null;
      const content = diff.truncated ? `${diff.stdout}${DIFF_TRUNCATED}` : diff.stdout;
      const author = session.runId ? { runId: session.runId } : { userId: session.ownerId };
      const previous = session.diffArtifactId;
      if (previous) {
        const updated = await writeArtifact(deps, this.owner, previous, { content }, author).catch(
          (error: unknown) => {
            deps.logger.info({ err: error, sessionId: this.id }, 'the last diff Artifact is gone');
            return null;
          },
        );
        if (updated) return updated.artifact.id;
      }
      const { artifact } = await createArtifact(
        deps,
        this.owner,
        {
          title: `Diff: ${session.branch}`,
          kind: 'code',
          botId: session.botId,
          chatId: session.chatId,
          content,
        },
        author,
      );
      return artifact.id;
    } catch (error) {
      deps.logger.warn({ err: error, sessionId: this.id }, 'the diff Artifact was not made');
      return null;
    }
  }

  /**
   * The vendor sign-in, with the session's run among those it resumes
   * (coder-login.ts merges it into one pending for the owner and agent).
   * False when it could not be started.
   */
  private async askToSignIn(label: string): Promise<boolean> {
    const { deps, session } = this;
    if (!session.runId) return false;
    try {
      await (this.options.startLogin ?? startLogin)(deps, this.owner, session.agent as CoderAgent, {
        botId: session.botId,
        runId: session.runId,
        ...(session.chatId ? { chatId: session.chatId } : {}),
      });
      appendFeed(
        deps,
        this.id,
        feedLine('text', `Asked the owner to sign in to ${label}; the Bot carries on after that`),
      );
      return true;
    } catch (error) {
      deps.logger.info({ err: error, sessionId: this.id }, 'coder sign-in not started');
      return false;
    }
  }

  /**
   * `pr` mode (I12): one approval to push and open the pull request, then
   * both, by the runner. Returns the pull request's url, or a note on why
   * there is none.
   */
  private async pullRequest(
    summary: string,
    commits: CoderCommit[],
  ): Promise<{ url?: string; note?: string; refused?: string }> {
    const { deps, session } = this;
    if (!session.runId)
      return { note: 'No run to ask the owner in, so the branch was not pushed.' };
    const branch = session.branch!;
    let decide!: (decision: 'approved' | 'denied' | 'expired') => void;
    const decided = new Promise<'approved' | 'denied' | 'expired'>((resolve) => (decide = resolve));
    const approval = await this.askOwner(
      {
        action: 'pr',
        title: `Push and open a PR for ${branch}`,
        detail: `${commits.length} commit${commits.length === 1 ? '' : 's'} on ${branch}, against ${session.base}`,
        toolName: PR_TOOL,
        input: { branch, base: session.base, commits: commits.length },
      },
      (approvalId) => this.waiters.set(approvalId, decide),
    );
    // Stopped while it asked: Stop answered the waiters it found then.
    if (this.stopped) decide('denied');
    const ttl = approvalTtlMs(deps.config);
    // The expiry job answers `denied` when the time is up; this is the backstop.
    const timer = setTimeout(() => decide('expired'), ttl + 60_000);
    timer.unref?.();
    this.timers.push(timer);
    const decision = await decided;
    this.waiters.delete(approval.id);
    await setApprovalStatus(deps, this.id, approval.id, decision);
    if (decision !== 'approved') {
      return {
        note: `The owner did not approve the push, so ${branch} is only on the computer.`,
      };
    }
    // The approval took a while: the checkout is checked again right before the push.
    const refused = await this.refusal();
    if (refused) return { refused };
    this.pushAllowed = true;
    await setSessionStatus(deps, this.id, 'running', { pushAllowed: true });
    appendFeed(deps, this.id, feedLine('command', `$ git push -u origin ${branch}`));
    const pushed = await runGit(
      this.git!,
      ['-C', session.worktreePath!, 'push', '-u', 'origin', branch],
      { push: true },
    );
    if (pushed.code !== 0) {
      const why = (pushed.error ?? pushed.stderr).trim().split('\n').filter(Boolean).pop();
      appendFeed(deps, this.id, feedLine('error', `Push failed: ${why ?? `exit ${pushed.code}`}`));
      return { note: `The push of ${branch} failed: ${why ?? `exit ${pushed.code}`}` };
    }
    try {
      const url = await this.openPullRequest(summary, commits);
      appendFeed(deps, this.id, feedLine('text', `Opened ${url}`));
      return { url };
    } catch (error) {
      const message = errorText(error);
      appendFeed(deps, this.id, feedLine('error', `The pull request was not opened: ${message}`));
      return { note: `Pushed ${branch}, but the pull request was not opened: ${message}` };
    }
  }

  /**
   * POST /repos/{owner}/{name}/pulls through the repository's git connection
   * (GH8): the App opens it with an installation token, or the owner with
   * their OAuth token when the connection acts as them; with no connection,
   * the owner's GitHub connector token.
   */
  private async openPullRequest(summary: string, commits: CoderCommit[]): Promise<string> {
    const { deps, session } = this;
    const { fullName } = remoteOf(this.repo!);
    const token = await pullRequestToken(deps, this.owner, fullName);
    if (!token) throw new Error('there is no GitHub token on the Connectors page');
    const [owner, name] = fullName.split('/') as [string, string];
    const firstLine = summary
      .split('\n')
      .find((line) => line.trim())
      ?.trim();
    const title =
      commits.length === 1 || !firstLine
        ? commits[commits.length - 1]!.title
        : firstLine.slice(0, 200);
    const body = `${summary.trim()}\n\nOpened by ${this.bot!.name} with OpenBots`.trim();
    const base = (this.options.githubApi ?? GITHUB_API).replace(/\/+$/, '');
    const res = await fetch(
      `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'OpenBots',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title, head: session.branch, base: session.base, body }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const data = (await res.json().catch(() => null)) as {
      html_url?: string;
      message?: string;
    } | null;
    if (!res.ok || !data?.html_url) {
      throw new Error(`GitHub answered ${res.status}: ${data?.message ?? res.statusText}`);
    }
    return data.html_url;
  }

  /** The session's end: its pending approvals expire, then the row and the widget settle. */
  private async settle(
    status: 'settled' | 'failed' | 'stopped',
    error: string | null,
    result?: CodingSessionStateResult,
    widgetError?: string,
  ): Promise<CodingSessionState> {
    this.ending = true;
    await expireSessionApprovals(this.deps, this.id).catch((err: unknown) =>
      this.deps.logger.warn({ err, sessionId: this.id }, 'session approvals not expired'),
    );
    return settleSession(this.deps, this.id, {
      status,
      error,
      ...(result ? { result } : {}),
      ...(widgetError ? { widgetError } : {}),
    });
  }

  private async resume(state: CodingSessionState, extra: { note?: string } = {}) {
    const runId = this.session.runId;
    if (!runId) return;
    const output = { ...(widgetToolResult('coding_session', state) as object), ...extra };
    await resumeWaitingRun(this.deps, runId, output, { waitMs: this.options.runWaitMs });
  }

  /** Anything thrown: the session fails with the reason, and the Bot hears it. */
  private async fail(raw: string) {
    const message = this.scrub(raw);
    this.stopProcess();
    await flushFeed(this.deps, this.id).catch(() => null);
    appendFeed(this.deps, this.id, feedLine('error', message));
    const state = await this.settle(this.stopped ? 'stopped' : 'failed', message).catch(
      (error: unknown) => {
        this.deps.logger.error({ err: error, sessionId: this.id }, 'coding session not settled');
        return null;
      },
    );
    if (state) await this.resume(state);
  }
}
