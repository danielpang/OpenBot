import type { CoderStarted, CoderStartInput } from '@openbots/agent';
import { COMPUTER_HOME } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  CODING_SESSION_ENDED,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  coderEnabled,
  resolveToolPolicy,
  type CoderAgent,
  type CoderChangedFile,
  type CoderCommit,
  type CoderMode,
  type CoderUsage,
  type CodingSessionStatus,
  type RunSource,
} from '@openbots/shared';
import {
  validateWidgetProps,
  widgetKind,
  type CodingSessionAction,
  type CodingSessionProps,
  type CodingSessionState,
} from '@openbots/widgets';
import { and, count, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { DomainError, notFound } from '../errors.js';
import { listCoderAccounts, needsSignIn } from './coder-accounts.js';
import { adapterFor } from './coder-adapters/index.js';
import { runAsCoder } from './coder-commands.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { startLogin } from './coder-login.js';
import {
  appendFeed,
  feedLine,
  flushFeed,
  readSessionLog,
  removeSessionLog,
} from './coder-state.js';
import { SESSION_KIND, sessionEffect } from './coder-widget-actions.js';
import type { BotRow } from './bots.js';
import { agentFor, startComputer } from './computer.js';
import { announceMessage, storeMessage } from './messages.js';
import {
  assertRunnable,
  remoteOf,
  runGit,
  sessionBranch,
  type GitContext,
} from './repos-checkout.js';
import { allowedRepos, listRepos, toRepoRef } from './repos.js';
import { actOnWidget } from './runs.js';
import { remoteHead } from './session-git.js';
import type { ComputerAgentClient } from '@openbots/computer';

// Coding sessions for the API and the runtime (docs/TECHNICAL_PLAN.md 22.2,
// 22.10; I9, I14, I15). `code_task` reaches `startCodingSession` through
// coder-tool.ts: it checks the Bot may code and has no session running,
// inserts the `coding_sessions` row (or reopens an ended one to continue it),
// posts the `coding_session` widget in the run's chat with the run waiting
// on it (`widget_states.pending_run_id`), and enqueues the runner's `session`
// job (services/coder-runner.ts), which does the rest. An agent that is not
// signed in gets the `coder_login` widget instead (services/coder-login.ts),
// and the run waits on that.
//
// The REST routes' Stop, Continue and Discard go through the widget's
// actions (coder-widget-actions.ts), so the widget and the row never
// disagree. Discard removes the worktree, its branch and its log, and a
// branch the session pushed without a pull request.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

export type CodingSessionRow = typeof schema.codingSessions.$inferSelect;

/** The statuses of a session that holds its Bot (one at a time) and a runner slot. */
export const CODING_SESSION_ACTIVE: CodingSessionStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting',
];

export const ended = (status: string) =>
  CODING_SESSION_ENDED.includes(status as CodingSessionStatus);

/** The run `code_task` is called from. */
export interface CoderRun {
  bot: BotRow;
  runId: string;
  chatId: string;
  /** The thread the run answers in, where the widget goes too. */
  thread?: string | null;
  source: RunSource;
}

/** A git ref name the runner can pass to git safely. */
const REF_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![/.])$/;

function checkRef(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const ref = value.trim();
  if (!REF_NAME.test(ref) || ref.length > 255) {
    throw new DomainError(400, 'INVALID_BRANCH', `${what} ${value} is not a valid git branch name`);
  }
  return ref;
}

/** What every session branch starts with: Discard deletes only these on the remote. */
export const SESSION_BRANCH_PREFIX = 'bot/';

/**
 * A branch a Bot named for its session: under `bot/`, and not the base or
 * the repository's default branch, which Discard could otherwise delete.
 */
function checkSessionBranch(
  branch: string | undefined,
  base: string,
  defaultBranch: string,
): string | undefined {
  if (branch === undefined) return undefined;
  if (!branch.startsWith(SESSION_BRANCH_PREFIX)) {
    throw new DomainError(400, 'BRANCH_NOT_ALLOWED', 'Session branches start with bot/');
  }
  if (branch === base || branch === defaultBranch) {
    throw new DomainError(
      400,
      'BRANCH_NOT_ALLOWED',
      `A session cannot work on ${branch}, the branch it starts from. Name a new bot/ branch, or leave branch out.`,
    );
  }
  return branch;
}

const excerpt = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const shortName = (fullName: string) => fullName.split('/').pop() ?? fullName;

const botBusy = (row: Pick<CodingSessionRow, 'id' | 'repoFullName'>) =>
  new DomainError(
    409,
    'CODER_BUSY',
    `You already have a coding session running${row.repoFullName ? ` on ${row.repoFullName}` : ''} (session ${row.id}). Wait for it to finish, or tell the owner; a Bot runs one coding session at a time.`,
  );

/**
 * `CoderServices.start`: checks, inserts or reopens the session, posts its
 * widget with the run waiting on it, and enqueues the runner. An agent that
 * is not signed in starts its sign-in instead, and the run waits on that.
 */
export async function startCodingSession(
  deps: AppDeps,
  run: CoderRun,
  input: CoderStartInput,
): Promise<CoderStarted> {
  const { bot } = run;
  const owner = { id: bot.ownerId, workspaceId: bot.workspaceId };
  const policy = resolveToolPolicy(bot.toolPolicy);
  if (!coderEnabled(policy)) {
    throw new DomainError(
      403,
      'CODER_DISABLED',
      'Coding agents are turned off for this Bot. The owner can turn them on in Bot Settings.',
    );
  }

  // Continuing: the session's own agent, repository and branch.
  const previous = input.session_id ? await ownSession(deps.db, owner, input.session_id) : null;
  if (previous && previous.botId !== bot.id) {
    throw new DomainError(403, 'SESSION_NOT_YOURS', 'That coding session belongs to another Bot.');
  }
  if (previous && !ended(previous.status)) {
    throw new DomainError(
      409,
      'SESSION_RUNNING',
      'That coding session is still running. Wait for it to finish before you continue it.',
    );
  }
  const agent = (previous?.agent as CoderAgent | undefined) ?? input.agent;
  const label = CODER_AGENT_LABELS[agent];

  const account = (await listCoderAccounts(deps, owner)).find((a) => a.agent === agent)!;
  if (needsSignIn(account)) {
    const login = await startLogin(deps, owner, agent, {
      botId: bot.id,
      runId: run.runId,
      chatId: run.chatId,
    });
    if (!login.posted) throw new Error('The sign-in widget was not posted');
    return {
      // The sign-in's id: there is no session until the agent is signed in.
      sessionId: login.login.id,
      kind: 'coder_login',
      posted: login.posted,
      label: `Waiting for sign-in: ${label}`,
      props: login.props,
    };
  }

  // The repository: the one continued, or one of the Bot's by id or full name.
  let repo: { id: string | null; fullName: string; remoteUrl: string | null; base: string };
  if (previous) {
    // The policy may have changed since the session began.
    if (
      !allowedRepos([{ full_name: previous.repoFullName ?? '' }], policy.coder.allowedRepos).length
    ) {
      throw new DomainError(
        403,
        'REPO_NOT_ALLOWED',
        `This Bot may not work on ${previous.repoFullName ?? 'that repository'} any more. The owner can allow it in Bot Settings.`,
      );
    }
    repo = {
      id: previous.repoId,
      fullName: previous.repoFullName ?? 'repository',
      remoteUrl: previous.remoteUrl,
      base: previous.base ?? 'main',
    };
  } else {
    const all = await listRepos(deps, owner);
    const wanted = input.repo
      .trim()
      .replace(/\.git$/, '')
      .toLowerCase();
    const match = all.find(
      (r) => r.repo.id === input.repo || r.repo.fullName.toLowerCase() === wanted,
    );
    if (!match) {
      throw new DomainError(
        404,
        'REPO_UNKNOWN',
        `${input.repo} is not one of the owner's repositories. Ask the owner to add it on the Computer page, under Repositories, then try again.`,
      );
    }
    if (!allowedRepos([toRepoRef(match)], policy.coder.allowedRepos).length) {
      throw new DomainError(
        403,
        'REPO_NOT_ALLOWED',
        `This Bot may not work on ${match.repo.fullName}. The owner can allow it in Bot Settings.`,
      );
    }
    repo = {
      id: match.repo.id,
      fullName: match.repo.fullName,
      remoteUrl: match.repo.remoteUrl,
      base: match.repo.defaultBranch,
    };
  }
  const base = previous?.base ?? checkRef(input.base, 'Base') ?? repo.base;
  const branch =
    previous?.branch ??
    checkSessionBranch(checkRef(input.branch, 'Branch'), base, repo.base) ??
    sessionBranch(input.prompt);
  const mode: CoderMode = input.mode;

  const [chat] = await deps.db.select().from(schema.chats).where(eq(schema.chats.id, run.chatId));
  if (!chat) throw notFound('Chat not found');

  const done = await deps.db.transaction(async (tx) => {
    // One session per Bot: two calls at once see each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`coder-bot:${bot.id}`}))`);
    const [busy] = await tx
      .select()
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.botId, bot.id),
          inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
          ...(previous ? [ne(schema.codingSessions.id, previous.id)] : []),
        ),
      )
      .limit(1);
    if (busy) throw botBusy(busy);
    // A branch named for a new session that another of the owner's sessions
    // works on: they would share its worktree, and one's Discard would take
    // the other's branch. The runner checks the remote the same way.
    if (!previous && input.branch !== undefined) {
      const [taken] = await tx
        .select({ id: schema.codingSessions.id })
        .from(schema.codingSessions)
        .where(
          and(
            eq(schema.codingSessions.ownerId, owner.id),
            eq(schema.codingSessions.workspaceId, owner.workspaceId),
            eq(schema.codingSessions.repoFullName, repo.fullName),
            eq(schema.codingSessions.branch, branch),
            // A discarded session no longer holds its branch.
            or(
              isNotNull(schema.codingSessions.worktreePath),
              inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
            ),
          ),
        )
        .limit(1);
      if (taken) {
        throw new DomainError(
          409,
          'BRANCH_IN_USE',
          `Session ${taken.id} already works on ${branch}. Continue it with its session_id, or name a new bot/ branch.`,
        );
      }
    }
    const [{ n: running } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.ownerId, owner.id),
          eq(schema.codingSessions.workspaceId, owner.workspaceId),
          inArray(schema.codingSessions.status, CODING_SESSION_ACTIVE),
        ),
      );

    let session: CodingSessionRow;
    if (previous) {
      const [reopened] = await tx
        .update(schema.codingSessions)
        .set({
          status: 'queued',
          prompt: input.prompt,
          mode,
          runId: run.runId,
          chatId: chat.id,
          // An approved push was for the last prompt: this one asks again.
          pushAllowed: false,
          error: null,
          finishedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.codingSessions.id, previous.id),
            inArray(schema.codingSessions.status, [...CODING_SESSION_ENDED]),
          ),
        )
        .returning();
      if (!reopened) throw botBusy(previous);
      session = reopened;
    } else {
      const [inserted] = await tx
        .insert(schema.codingSessions)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          botId: bot.id,
          runId: run.runId,
          chatId: chat.id,
          agent,
          repoId: repo.id,
          repoFullName: repo.fullName,
          remoteUrl: repo.remoteUrl,
          branch,
          base,
          mode,
          prompt: input.prompt,
          status: 'queued',
        })
        .returning();
      session = inserted!;
    }

    const checked = validateWidgetProps(SESSION_KIND, {
      session_id: session.id,
      agent,
      repo: repo.fullName,
      branch,
      base,
      mode,
      prompt_excerpt: excerpt(input.prompt, 300),
    } satisfies CodingSessionProps);
    if (!checked.ok) throw new Error(checked.error);
    const props = checked.value as CodingSessionProps;
    const initial = widgetKind(SESSION_KIND)!.initialState!(props) as CodingSessionState;
    const state: CodingSessionState =
      running >= DEFAULT_MAX_CONCURRENT_SESSIONS
        ? {
            ...initial,
            feed: [
              {
                t: new Date().toISOString(),
                type: 'text',
                text: `Queued: ${DEFAULT_MAX_CONCURRENT_SESSIONS} coding sessions are running; this one starts when one ends`,
              },
            ],
          }
        : initial;
    const message = await storeMessage(tx, chat, {
      authorType: 'bot',
      authorId: bot.id,
      ...(run.thread ? { threadRootId: run.thread } : {}),
      parts: [{ type: 'widget', kind: SESSION_KIND, props, state: initial }],
    });
    await tx.insert(schema.widgetStates).values({
      workspaceId: chat.workspaceId,
      messageId: message.id,
      partIndex: 0,
      state,
      pendingRunId: run.runId,
    });
    const [placed] = await tx
      .update(schema.codingSessions)
      .set({ messageId: message.id, partIndex: 0 })
      .where(eq(schema.codingSessions.id, session.id))
      .returning();
    if (repo.id) {
      await tx
        .update(schema.repos)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.repos.id, repo.id));
    }
    return { session: placed!, message, props };
  });

  await announceMessage(deps, done.message);
  await enqueueCoderJob(deps, { kind: 'session', sessionId: done.session.id });
  return {
    sessionId: done.session.id,
    kind: 'coding_session',
    posted: { messageId: done.message.id, partIndex: 0 },
    label: `Coding: ${shortName(repo.fullName)} with ${label}`,
    props: done.props,
  };
}

// Sessions

/** A session as the API returns it. */
export interface CodingSessionView {
  id: string;
  botId: string;
  runId: string | null;
  chatId: string | null;
  messageId: string | null;
  partIndex: number | null;
  agent: CoderAgent;
  repoId: string | null;
  repoFullName: string | null;
  branch: string | null;
  base: string | null;
  mode: CoderMode;
  status: CodingSessionStatus;
  pushAllowed: boolean;
  vendorSessionId: string | null;
  usage: CoderUsage | null;
  summary: string | null;
  changedFiles: CoderChangedFile[];
  commits: CoderCommit[];
  prUrl: string | null;
  /** The Artifact holding the branch's diff against its base, once it settled with commits. */
  diffArtifactId: string | null;
  error: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export function toSessionView(row: CodingSessionRow): CodingSessionView {
  return {
    id: row.id,
    botId: row.botId,
    runId: row.runId,
    chatId: row.chatId,
    messageId: row.messageId,
    partIndex: row.partIndex,
    agent: row.agent as CoderAgent,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    branch: row.branch,
    base: row.base,
    mode: row.mode as CoderMode,
    status: row.status as CodingSessionStatus,
    pushAllowed: row.pushAllowed,
    vendorSessionId: row.vendorSessionId,
    usage: row.usage ?? null,
    summary: row.summary,
    changedFiles: row.changedFiles ?? [],
    commits: row.commits ?? [],
    prUrl: row.prUrl,
    diffArtifactId: row.diffArtifactId,
    error: row.error,
    worktreePath: row.worktreePath,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownSession(db: Db, owner: Owner, sessionId: string): Promise<CodingSessionRow> {
  const [row] = await db
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.id, sessionId),
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
      ),
    );
  if (!row) throw notFound('Coding session not found');
  return row;
}

export interface SessionFilter {
  botId?: string;
  status?: CodingSessionStatus;
  limit?: number;
}

/** The owner's sessions, newest first. */
export async function listSessions(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  { botId, status, limit = 50 }: SessionFilter = {},
): Promise<CodingSessionRow[]> {
  return deps.db
    .select()
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
        ...(botId ? [eq(schema.codingSessions.botId, botId)] : []),
        ...(status ? [eq(schema.codingSessions.status, status)] : []),
      ),
    )
    .orderBy(desc(schema.codingSessions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export function getSession(deps: Pick<AppDeps, 'db'>, owner: Owner, sessionId: string) {
  return ownSession(deps.db, owner, sessionId);
}

export const sessionEnded = () =>
  new DomainError(409, 'SESSION_ENDED', 'This coding session already ended');
export const sessionRunning = () =>
  new DomainError(409, 'SESSION_RUNNING', 'This coding session is still running');

/**
 * Applies an owner's Stop, Continue or Discard through the session's widget,
 * so its state moves with the row; a session whose widget is gone is acted
 * on directly.
 */
async function viaWidget(
  deps: AppDeps,
  owner: Owner,
  row: CodingSessionRow,
  action: CodingSessionAction,
): Promise<CodingSessionRow> {
  if (row.messageId && row.partIndex !== null) {
    await actOnWidget(deps, owner, row.messageId, row.partIndex, action);
  } else {
    const effect = await sessionEffect(deps, deps.db, row, action, null);
    await effect?.();
  }
  return ownSession(deps.db, owner, row.id);
}

export async function stopSession(deps: AppDeps, owner: Owner, sessionId: string) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (ended(row.status)) throw sessionEnded();
  return viaWidget(deps, owner, row, { type: 'stop' });
}

/**
 * Continue from the API: like the widget's Continue, the prompt goes to the
 * Bot as an owner message, and its run continues the session through
 * `code_task`. The row is left as it is until then.
 */
export async function continueSession(
  deps: AppDeps,
  owner: Owner,
  sessionId: string,
  prompt: string,
) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!ended(row.status)) throw sessionRunning();
  return viaWidget(deps, owner, row, { type: 'continue', prompt });
}

export async function discardSession(deps: AppDeps, owner: Owner, sessionId: string) {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!ended(row.status)) {
    throw new DomainError(409, 'SESSION_RUNNING', 'Stop the session before discarding its branch');
  }
  return viaWidget(deps, owner, row, { type: 'discard' });
}

/**
 * Where Open terminal opens (CA7, I15): the worktree, as `coder`, with the
 * agent's resume command typed and ready. The PTY proxy checks the path
 * against the owner's sessions again.
 */
export async function terminalFor(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  sessionId: string,
): Promise<{ cwd: string; user: 'coder'; preset: string }> {
  const row = await ownSession(deps.db, owner, sessionId);
  if (!row.worktreePath) {
    throw new DomainError(409, 'NO_WORKTREE', 'This session has no worktree on the computer');
  }
  const agent = row.agent as CoderAgent;
  const preset = row.vendorSessionId ? adapterFor(agent).resumeCommand(row.vendorSessionId) : '';
  return { cwd: row.worktreePath, user: 'coder', preset };
}

/** The most of a session's log the API returns: its end. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The session's full event log, its last LOG_MAX_BYTES (empty before the
 * runner wrote any). The runner writes it on the server
 * (services/coder-state.ts), so the computer is not involved.
 */
export async function sessionLog(deps: AppDeps, owner: Owner, sessionId: string): Promise<string> {
  const row = await ownSession(deps.db, owner, sessionId);
  return readSessionLog(deps, row, LOG_MAX_BYTES);
}

/**
 * Whether a terminal may open in `cwd` (I15): the worktree of one of the
 * owner's coding sessions, or the checkout of one of their repositories.
 */
export async function isCoderTerminalCwd(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  cwd: string,
): Promise<boolean> {
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  // The home: where a sign-in that runs in the terminal opens (pi's /login, CODER_LOGIN_IN_TERMINAL).
  if (path === COMPUTER_HOME) return true;
  const [session] = await deps.db
    .select({ id: schema.codingSessions.id })
    .from(schema.codingSessions)
    .where(
      and(
        eq(schema.codingSessions.ownerId, owner.id),
        eq(schema.codingSessions.workspaceId, owner.workspaceId),
        eq(schema.codingSessions.worktreePath, path),
      ),
    )
    .limit(1);
  if (session) return true;
  const [checkout] = await deps.db
    .select({ id: schema.repoCheckouts.id })
    .from(schema.repoCheckouts)
    .innerJoin(schema.repos, eq(schema.repos.id, schema.repoCheckouts.repoId))
    .where(
      and(
        eq(schema.repos.ownerId, owner.id),
        eq(schema.repos.workspaceId, owner.workspaceId),
        eq(schema.repoCheckouts.path, path),
      ),
    )
    .limit(1);
  return !!checkout;
}

/**
 * Removes a session's worktree and its local branch on the computer, as
 * `coder`, best effort (the computer starts if it has to), and its log on
 * the server, then forgets the path. A branch the session pushed is deleted
 * on the remote too unless a pull request was opened from it, which keeps
 * it; the feed says which.
 */
export async function discardWorktree(deps: AppDeps, row: CodingSessionRow): Promise<void> {
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  const worktree = row.worktreePath;
  if (worktree) {
    const at = worktree.indexOf('/.worktrees/');
    const repoDir = at > 0 ? worktree.slice(0, at) : null;
    try {
      const { computer } = await startComputer(deps, owner);
      const client = agentFor(deps, computer);
      const script = repoDir
        ? 'git -C "$0" worktree remove --force "$1"; git -C "$0" worktree prune; if [ -n "$2" ]; then git -C "$0" branch -D "$2"; fi; exit 0'
        : 'rm -rf -- "$1"; exit 0';
      await runAsCoder(client, 'sh', [
        '-c',
        script,
        repoDir ?? worktree,
        worktree,
        row.branch ?? '',
      ]);
      const note = repoDir ? await discardPushedBranch(deps, row, client, repoDir) : null;
      if (note) {
        appendFeed(deps, row.id, feedLine('text', note));
        await flushFeed(deps, row.id);
      }
    } catch (error) {
      deps.logger.warn({ err: error, sessionId: row.id }, 'discarding a worktree failed');
    }
  }
  await removeSessionLog(deps, row).catch((error: unknown) =>
    deps.logger.warn({ err: error, sessionId: row.id }, 'removing a session log failed'),
  );
  await deps.db
    .update(schema.codingSessions)
    .set({ worktreePath: null, updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, row.id));
}

/**
 * The remote side of Discard: a branch the session pushed (its push was
 * approved and the remote has it) is deleted there as `runner`, unless a
 * pull request was opened from it. Only a `bot/` branch the session created
 * (`branch_existed` false) whose remote head is still the commit the runner
 * saw it push (`pushed_sha`) is deleted, with a lease on that commit, so a
 * branch that was there before, work someone else pushed on it, or a branch
 * from before the `bot/` rule, stays. Returns what the feed says, or null when
 * there was nothing on the remote.
 */
async function discardPushedBranch(
  deps: AppDeps,
  row: CodingSessionRow,
  client: ComputerAgentClient,
  repoDir: string,
): Promise<string | null> {
  const branch = row.branch;
  if (!row.pushAllowed || !branch) return null;
  if (row.prUrl) return `The branch ${branch} stays on GitHub with its pull request ${row.prUrl}`;
  const [repo] = row.repoId
    ? await deps.db.select().from(schema.repos).where(eq(schema.repos.id, row.repoId))
    : [];
  if (!repo) return null;
  const ctx: GitContext = {
    deps,
    agent: client,
    owner: { id: row.ownerId, workspaceId: row.workspaceId },
    repoFullName: remoteOf(repo).fullName,
  };
  // The session could write the checkout's config: checked before runner git runs there.
  await assertRunnable(ctx, repoDir, repo);
  const ref = `refs/heads/${branch}`;
  const head = await remoteHead(ctx, repoDir, branch);
  if (!head) return null;
  const stays = `The branch ${branch} stays on GitHub`;
  if (!branch.startsWith(SESSION_BRANCH_PREFIX)) {
    return `${stays}: only bot/ branches are deleted`;
  }
  if (row.branchExisted !== false) {
    return row.branchExisted
      ? `${stays}: it was there before the session`
      : `${stays}: OpenBots has no record of creating it`;
  }
  if (!row.pushedSha) return `${stays}: OpenBots has no record of pushing it`;
  if (head !== row.pushedSha) {
    return `${stays}: it has commits the session did not push`;
  }
  const deleted = await runGit(
    ctx,
    ['-C', repoDir, 'push', 'origin', '--delete', `--force-with-lease=${ref}:${head}`, branch],
    { push: true },
  );
  if (deleted.code === 0) return `Deleted the pushed branch ${branch} on GitHub`;
  const why = (deleted.error ?? deleted.stderr).trim().split('\n').filter(Boolean).pop();
  return `The pushed branch ${branch} was not deleted on GitHub${why ? `: ${why}` : ''}`;
}
