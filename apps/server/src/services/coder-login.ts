import { randomUUID } from 'node:crypto';
import { CODER_CONFIG_DIRS, COMPUTER_HOME, type ComputerAgentClient } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  CODER_CONTROL_CHANNEL,
  CoderControlSchema,
  wsEvent,
  type CoderAgent,
  type CoderControl,
  type CoderLoginStatus,
} from '@openbots/shared';
import {
  validateWidgetProps,
  widgetToolResult,
  type CoderLoginProps,
  type CoderLoginWidgetState,
} from '@openbots/widgets';
import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from './audit.js';
import { adapterFor, type CoderLoginParse } from './coder-adapters/index.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { resumeWaitingRun } from './coder-runner.js';
import { mainBotOf, type BotRow } from './bots.js';
import { botPairChat } from './chats.js';
import { agentFor, startComputer } from './computer.js';
import { announceMessage, storeMessage, type ChatRow } from './messages.js';
import type { RunState } from './runs.js';

// The sign-in driver (design doc, I4 and F2). Signing a coding agent in runs
// the vendor's own login in a PTY on the computer as the `coder` user, so
// the credentials land in the agent's config directory on the root-only
// state volume and never pass through the server. `startLogin` records the
// attempt (`coder_logins`), posts the `coder_login` widget when a Bot asked
// (in the main Bot's transcript, like a site sign-in request, K8) and
// enqueues the runner's `login` job, which calls `runCoderLogin`: it reads
// the link and device code from the login's output through the adapter's
// `parseLogin`, shows them on the row and the widget, and writes the code
// the owner pastes back into the PTY. The code arrives over the coder
// control channel (`stdin` for the login's id), so the API process that
// takes it need not be the worker that runs the login, and it is never
// stored. A pending login for the same agent is reused: a second asking run
// joins it (`waiting_runs` in the widget's state), and every one of them
// resumes with the outcome. An asking run that already waits on another
// widget (the runner found the agent signed out while a `coding_session`
// widget held the run, F7) is moved to wait on the sign-in instead. An
// unanswered login expires after CODER_LOGIN_TTL_MS, at the driver's
// timeout or lazily when read.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type LoginDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export type CoderLoginRow = typeof schema.coderLogins.$inferSelect;

const KIND = 'coder_login';

/** How long a sign-in waits for the owner. */
export const CODER_LOGIN_TTL_MS = 10 * 60_000;
/**
 * How long a sign-in done in the terminal (pi) waits: no login process
 * times it out, and the owner opens the Computer page and comes back to Check.
 */
export const TERMINAL_LOGIN_TTL_MS = 24 * 60 * 60_000;

/** A sign-in still waiting on the owner or the CLI. */
const ACTIVE: CoderLoginStatus[] = ['pending', 'awaiting_code'];

/** The widget's state as stored: the contract's, plus the runs waiting on it. */
export type CoderLoginStoredState = CoderLoginWidgetState & { waiting_runs?: string[] };

/** A sign-in as the API returns it; never the code. */
export interface CoderLoginView {
  id: string;
  agent: CoderAgent;
  status: CoderLoginStatus;
  url: string | null;
  deviceCode: string | null;
  accountLabel: string | null;
  error: string | null;
  expiresAt: string | null;
}

export function toLoginView(row: CoderLoginRow): CoderLoginView {
  return {
    id: row.id,
    agent: row.agent as CoderAgent,
    status: row.status as CoderLoginStatus,
    url: row.url,
    deviceCode: row.deviceCode,
    accountLabel: row.accountLabel,
    error: row.error,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** What the widget tells the owner to do, per agent. */
const INSTRUCTIONS: Record<CoderAgent, string> = {
  claude: 'Open this link on any device, sign in to Claude, then paste the code it gives you.',
  codex: 'Open this link on any device, sign in to ChatGPT and enter the code shown here.',
  pi: 'Open this link on any device and finish signing in, then paste the code if it gives you one.',
};

/** What the owner is told for an agent that signs in in its own terminal (the widget and the 409). */
export const TERMINAL_LOGIN_INSTRUCTIONS: Partial<Record<CoderAgent, string>> = {
  pi: 'pi signs in from its own terminal. Open the Computer page, run pi, type /login and choose a provider. Then press Check under Settings > Coding agents.',
};

/** What the owner sees when Codex's sign-in is refused by OpenAI (a 401); the raw text is logged. */
export const CODEX_SIGN_IN_REFUSED =
  'Codex could not sign in to OpenAI. Sign in again under Settings > Coding agents.';

/** A failed sign-in's error as the owner reads it: a vendor 401 in plain words. */
export function signInErrorForOwner(agent: CoderAgent, raw: string): string {
  if (agent === 'codex' && /\b401\b|unauthori[sz]ed/i.test(raw)) return CODEX_SIGN_IN_REFUSED;
  return raw;
}

/** Where the owner signs an agent in by hand: a terminal as `coder`, the CLI typed. */
export interface CoderLoginTerminal {
  cwd: string;
  user: 'coder';
  preset: string;
}

/**
 * The agent has no headless sign-in (pi: `/login` is in its TUI only), so
 * the owner signs in in a terminal on the computer, then checks it
 * (`POST /coders/{agent}/check`). The adapter's `login()` throws this, or
 * any error with the code CODER_LOGIN_IN_TERMINAL.
 */
export class CoderLoginInTerminalError extends DomainError {
  constructor(
    message: string,
    readonly terminal: CoderLoginTerminal,
  ) {
    super(409, 'CODER_LOGIN_IN_TERMINAL', message);
  }
}

/** The terminal sign-in an adapter's `login()` asks for, or null when it runs headless. */
export function terminalLogin(agent: CoderAgent): CoderLoginInTerminalError | null {
  try {
    adapterFor(agent).login();
    return null;
  } catch (error) {
    if (error instanceof CoderLoginInTerminalError) return error;
    const coded = error as { code?: unknown; message?: unknown; terminal?: unknown };
    if (coded?.code !== 'CODER_LOGIN_IN_TERMINAL') throw error;
    const given = coded.terminal as Partial<CoderLoginTerminal> | undefined;
    const label = CODER_AGENT_LABELS[agent];
    return new CoderLoginInTerminalError(
      TERMINAL_LOGIN_INSTRUCTIONS[agent] ??
        (typeof coded.message === 'string' && coded.message
          ? coded.message
          : `${label} signs in from its own terminal. Open the terminal, finish the sign-in there, then check it.`),
      {
        cwd: typeof given?.cwd === 'string' ? given.cwd : COMPUTER_HOME,
        user: 'coder',
        preset: typeof given?.preset === 'string' ? given.preset : agent,
      },
    );
  }
}

/** Who asked for the sign-in: a Bot's run, or the owner from Settings (none). */
export interface LoginAsker {
  botId?: string;
  runId?: string;
  chatId?: string;
}

export interface StartedLogin {
  login: CoderLoginView;
  /** The `coder_login` widget, when a Bot asked. */
  posted: { messageId: string; partIndex: number } | null;
  props: CoderLoginProps | null;
}

/**
 * Starts signing `agent` in for the owner, or joins the sign-in already
 * pending for it. With a Bot asking, the widget goes in the main Bot's
 * transcript (or the asking Bot's own, without one) and the asking run is
 * listed to resume when it ends. An agent that signs in in its own terminal
 * (pi) has no login to drive: from Settings that throws
 * CoderLoginInTerminalError (the route's 409); for a Bot the sign-in is
 * recorded and its widget tells the owner where to sign in, and Settings'
 * Check ends it (`completeTerminalLogins`).
 */
export async function startLogin(
  deps: LoginDeps,
  owner: Owner,
  agent: CoderAgent,
  asker: LoginAsker = {},
): Promise<StartedLogin> {
  // An agent this build has no adapter for answers CODER_UNSUPPORTED.
  adapterFor(agent);
  // One that signs in in the terminal has nothing to drive here.
  const inTerminal = terminalLogin(agent);
  if (inTerminal && !asker.botId) throw inTerminal;
  await expireStaleLogins(deps, owner, agent);
  const bot = asker.botId ? await botRow(deps.db, asker.botId) : null;
  const main = bot ? await mainBotOf(deps.db, owner) : null;
  const screenBot = bot ? (main && !main.archivedAt ? main : bot) : null;

  const done = await deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`coder-login:${owner.id}:${agent}`}))`,
    );
    const [pending] = await tx
      .select()
      .from(schema.coderLogins)
      .where(
        and(
          eq(schema.coderLogins.ownerId, owner.id),
          eq(schema.coderLogins.workspaceId, owner.workspaceId),
          eq(schema.coderLogins.agent, agent),
          inArray(schema.coderLogins.status, ACTIVE),
        ),
      )
      .orderBy(desc(schema.coderLogins.createdAt))
      .limit(1);
    let row: CoderLoginRow =
      pending ??
      (await tx
        .insert(schema.coderLogins)
        .values({
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          agent,
          status: 'pending',
          expiresAt: new Date(
            Date.now() + (inTerminal ? TERMINAL_LOGIN_TTL_MS : CODER_LOGIN_TTL_MS),
          ),
        })
        .returning()
        .then((rows) => rows[0]!));
    const created = !pending;
    if (!bot || !screenBot) return { row, created, posted: null, props: null, joined: null };

    if (row.messageId !== null && row.partIndex !== null) {
      // Joined: the asking run is told when it ends, like the first one.
      const state = await joinWidget(tx, row, asker.runId);
      const [message] = await tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, row.messageId));
      const props = (message?.parts as { props?: CoderLoginProps }[] | undefined)?.[row.partIndex]
        ?.props;
      return {
        row,
        created,
        posted: { messageId: row.messageId, partIndex: row.partIndex },
        props: props ?? null,
        joined: message ? { message, state } : null,
      };
    }

    // The first Bot to ask (or a sign-in the owner began in Settings): post it.
    const checked = validateWidgetProps(KIND, {
      login_id: row.id,
      agent,
      instructions: inTerminal?.message ?? INSTRUCTIONS[agent],
      waiting: [{ bot_id: bot.id, handle: bot.handle, name: bot.name }],
    } satisfies CoderLoginProps);
    if (!checked.ok) throw new Error(checked.error);
    const props = checked.value as CoderLoginProps;
    const transcript = await transcriptOf(tx, screenBot);
    const state: CoderLoginStoredState = {
      status: row.status as CoderLoginStatus,
      agent,
      ...(row.url ? { url: row.url } : {}),
      ...(row.deviceCode ? { device_code: row.deviceCode } : {}),
      ...(row.expiresAt ? { expires_at: row.expiresAt.toISOString() } : {}),
      waiting_runs: asker.runId ? [asker.runId] : [],
    };
    const message = await storeMessage(tx, transcript, {
      authorType: 'bot',
      authorId: screenBot.id,
      parts: [{ type: 'widget', kind: KIND, props, state: { status: 'pending', agent } }],
    });
    await tx.insert(schema.widgetStates).values({
      workspaceId: transcript.workspaceId,
      messageId: message.id,
      partIndex: 0,
      state,
    });
    const [placed] = await tx
      .update(schema.coderLogins)
      .set({ chatId: transcript.id, messageId: message.id, partIndex: 0, updatedAt: new Date() })
      .where(eq(schema.coderLogins.id, row.id))
      .returning();
    row = placed ?? row;
    const handoff = bot.id === screenBot.id ? null : await handoffNote(tx, bot, screenBot, agent);
    return {
      row: row!,
      created,
      posted: { messageId: message.id, partIndex: 0 },
      props,
      joined: null,
      message,
      handoff,
    };
  });

  if ('handoff' in done && done.handoff) await announceMessage(deps, done.handoff);
  if ('message' in done && done.message) await announceMessage(deps, done.message);
  if (done.joined) {
    await publishWidget(deps, done.joined.message, done.posted!.partIndex, done.joined.state);
  }
  if (asker.runId && done.posted) {
    await moveRunToLogin(deps, asker.runId, done.posted, done.props, agent);
  }
  // A terminal sign-in has no login process: Check ends it.
  if (done.created && !inTerminal) {
    await enqueueCoderJob(deps, { kind: 'login', loginId: done.row.id });
  }
  return { login: toLoginView(done.row), posted: done.posted, props: done.props };
}

/**
 * A run listed on a sign-in that is paused on another widget (its
 * `coding_session`) now waits on the sign-in: its pending wait points at the
 * `coder_login` widget, and the other widget no longer names it as waiting.
 * The sign-in's outcome resumes it (`resumeWaiting`). A run not waiting yet
 * is left alone; `moveRunToWaitingLogin` catches it when it pauses.
 */
async function moveRunToLogin(
  deps: Pick<AppDeps, 'db'>,
  runId: string,
  posted: { messageId: string; partIndex: number },
  props: CoderLoginProps | null,
  agent: CoderAgent,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .for('update');
    const state = run?.state as RunState | null;
    const pending = state?.pending;
    if (run?.status !== 'waiting' || !state || !pending) return false;
    if (pending.messageId === posted.messageId && pending.partIndex === posted.partIndex) {
      return false;
    }
    await tx
      .update(schema.runs)
      .set({
        state: {
          ...state,
          pending: {
            ...pending,
            widget: { kind: KIND, props: props ?? pending.widget.props },
            label: `Waiting for sign-in: ${CODER_AGENT_LABELS[agent]}`,
            messageId: posted.messageId,
            partIndex: posted.partIndex,
            posted,
          },
        } satisfies RunState,
      })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, 'waiting')));
    await tx
      .update(schema.widgetStates)
      .set({ pendingRunId: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.widgetStates.pendingRunId, runId),
          ne(schema.widgetStates.messageId, posted.messageId),
        ),
      );
    return true;
  });
}

/**
 * For a run that just paused on a `coding_session` widget: when an active
 * sign-in already lists it (the runner asked for one before the pause), it
 * waits on that sign-in instead. Returns whether it moved.
 */
export async function moveRunToWaitingLogin(
  deps: Pick<AppDeps, 'db'>,
  runId: string,
): Promise<boolean> {
  const [found] = await deps.db
    .select({ login: schema.coderLogins, parts: schema.messages.parts })
    .from(schema.coderLogins)
    .innerJoin(
      schema.widgetStates,
      and(
        eq(schema.widgetStates.messageId, schema.coderLogins.messageId),
        eq(schema.widgetStates.partIndex, schema.coderLogins.partIndex),
      ),
    )
    .innerJoin(schema.messages, eq(schema.messages.id, schema.coderLogins.messageId))
    .where(
      and(
        inArray(schema.coderLogins.status, ACTIVE),
        sql`${schema.widgetStates.state} -> 'waiting_runs' @> ${JSON.stringify([runId])}::jsonb`,
      ),
    )
    .limit(1);
  if (!found || found.login.messageId === null || found.login.partIndex === null) return false;
  const props =
    (found.parts as { props?: CoderLoginProps }[] | null)?.[found.login.partIndex]?.props ?? null;
  return moveRunToLogin(
    deps,
    runId,
    { messageId: found.login.messageId, partIndex: found.login.partIndex },
    props,
    found.login.agent as CoderAgent,
  );
}

/** Adds a run to a posted sign-in's waiting list; returns the new state. */
async function joinWidget(tx: Db, row: CoderLoginRow, runId: string | undefined) {
  const [stored] = await tx
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, row.messageId!),
        eq(schema.widgetStates.partIndex, row.partIndex!),
      ),
    )
    .for('update');
  const current = (stored?.state ?? { status: row.status }) as CoderLoginStoredState;
  const waiting = [...(current.waiting_runs ?? [])];
  if (runId && !waiting.includes(runId)) waiting.push(runId);
  const state: CoderLoginStoredState = { ...current, waiting_runs: waiting };
  await tx
    .insert(schema.widgetStates)
    .values({
      workspaceId: row.workspaceId,
      messageId: row.messageId!,
      partIndex: row.partIndex!,
      state,
    })
    .onConflictDoUpdate({
      target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
      set: { state, updatedAt: new Date() },
    });
  return state;
}

async function botRow(db: Db, botId: string): Promise<BotRow> {
  const [row] = await db.select().from(schema.bots).where(eq(schema.bots.id, botId));
  if (!row) throw notFound('Bot not found');
  return row;
}

/** The Bot's transcript (B4); every Bot gets one when it is created. */
async function transcriptOf(db: Db, bot: BotRow): Promise<ChatRow> {
  const [chat] = await db
    .select()
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.ownerId, bot.ownerId),
        eq(schema.chats.workspaceId, bot.workspaceId),
        eq(schema.chats.botId, bot.id),
        eq(schema.chats.type, 'bot_dm'),
      ),
    );
  if (!chat) throw new Error(`@${bot.handle} has no transcript`);
  return chat;
}

/** The asking Bot's line in its chat with the main Bot (C6), so the owner sees the handoff. */
async function handoffNote(tx: Db, bot: BotRow, main: BotRow, agent: CoderAgent) {
  const chat = await botPairChat(tx, bot, main);
  return storeMessage(tx, chat, {
    authorType: 'bot',
    authorId: bot.id,
    parts: [
      {
        type: 'text',
        text: `I need ${CODER_AGENT_LABELS[agent]} signed in on the computer for a coding task. I asked our owner in your transcript, and I am waiting for their answer.`,
      },
    ],
  });
}

/** One of the owner's sign-ins; one past its time is marked expired first. */
export async function getLogin(
  deps: LoginDeps,
  owner: Owner,
  loginId: string,
  agent?: CoderAgent,
): Promise<CoderLoginView> {
  let row = await ownLogin(deps.db, owner, loginId, agent);
  if (ACTIVE.includes(row.status as CoderLoginStatus) && isPast(row)) {
    row = (await endLogin(deps, row, 'expired', { error: 'The sign-in expired' })) ?? row;
  }
  return toLoginView(row);
}

async function ownLogin(db: Db, owner: Owner, loginId: string, agent?: CoderAgent) {
  const [row] = await db
    .select()
    .from(schema.coderLogins)
    .where(
      and(
        eq(schema.coderLogins.id, loginId),
        eq(schema.coderLogins.ownerId, owner.id),
        eq(schema.coderLogins.workspaceId, owner.workspaceId),
        ...(agent ? [eq(schema.coderLogins.agent, agent)] : []),
      ),
    );
  if (!row) throw notFound('Sign-in not found');
  return row;
}

const isPast = (row: CoderLoginRow, now = Date.now()) =>
  row.expiresAt !== null && row.expiresAt.getTime() <= now;

/** Marks the owner's sign-ins for `agent` that ran out of time as expired. */
async function expireStaleLogins(deps: LoginDeps, owner: Owner, agent: CoderAgent) {
  const stale = await deps.db
    .select()
    .from(schema.coderLogins)
    .where(
      and(
        eq(schema.coderLogins.ownerId, owner.id),
        eq(schema.coderLogins.workspaceId, owner.workspaceId),
        eq(schema.coderLogins.agent, agent),
        inArray(schema.coderLogins.status, ACTIVE),
        lte(schema.coderLogins.expiresAt, new Date()),
      ),
    );
  for (const row of stale) await endLogin(deps, row, 'expired', { error: 'The sign-in expired' });
}

/**
 * Passes the owner's code to the login's PTY, wherever the driver runs: it
 * goes over the control channel and is never stored. The widget says a code
 * was submitted. Refused (409) once the sign-in ended.
 */
export async function submitLoginCode(
  deps: LoginDeps,
  owner: Owner,
  loginId: string,
  code: string,
  agent?: CoderAgent,
): Promise<CoderLoginView> {
  const row = await ownLogin(deps.db, owner, loginId, agent);
  if (!ACTIVE.includes(row.status as CoderLoginStatus) || isPast(row)) {
    await getLogin(deps, owner, loginId);
    throw loginClosed();
  }
  const updated = await markCodeSubmitted(deps, row);
  await writeLoginCode(deps, loginId, code);
  return toLoginView(updated);
}

const loginClosed = () => new DomainError(409, 'LOGIN_CLOSED', 'This sign-in already ended');

/** Moves a sign-in to `awaiting_code` with the widget saying a code was sent. */
async function markCodeSubmitted(deps: LoginDeps, row: CoderLoginRow): Promise<CoderLoginRow> {
  const [updated] = await deps.db
    .update(schema.coderLogins)
    .set({ status: 'awaiting_code', updatedAt: new Date() })
    .where(and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE)))
    .returning();
  await patchWidget(deps, updated ?? row, { status: 'awaiting_code', code_submitted: true });
  return updated ?? row;
}

/** Sends the code to the driver; for the widget's `code` action, whose reducer set the state. */
export async function writeLoginCode(
  deps: Pick<AppDeps, 'infra'>,
  loginId: string,
  code: string,
): Promise<void> {
  await deps.infra.bus.publish<CoderControl>(CODER_CONTROL_CHANNEL, {
    type: 'stdin',
    sessionId: loginId,
    data: `${code.trim()}\r`,
  });
}

/**
 * Ends a sign-in the owner gave up on (`failed`: they cannot sign in) or
 * replaced with an API key (`cancelled`): the login process is stopped and
 * every waiting run resumes told so.
 */
export async function cancelLogin(
  deps: LoginDeps,
  owner: Owner,
  loginId: string,
  status: 'failed' | 'cancelled',
  agent?: CoderAgent,
): Promise<CoderLoginView> {
  const row = await ownLogin(deps.db, owner, loginId, agent);
  const ended = await endLogin(deps, row, status, {
    ...(status === 'cancelled' ? { wants_api_key: true } : {}),
    ...(status === 'failed' ? { error: 'The owner could not sign in' } : {}),
  });
  return toLoginView(ended ?? row);
}

/**
 * The owner signed `agent` in in its terminal and Check found it so: every
 * sign-in still open for it ends `signed_in`, and the runs waiting on them
 * resume. Returns how many ended.
 */
export async function completeTerminalLogins(
  deps: LoginDeps,
  owner: Owner,
  agent: CoderAgent,
  accountLabel: string,
): Promise<number> {
  const open = await deps.db
    .select()
    .from(schema.coderLogins)
    .where(
      and(
        eq(schema.coderLogins.ownerId, owner.id),
        eq(schema.coderLogins.workspaceId, owner.workspaceId),
        eq(schema.coderLogins.agent, agent),
        inArray(schema.coderLogins.status, ACTIVE),
      ),
    );
  let ended = 0;
  for (const row of open) {
    if (await endLogin(deps, row, 'signed_in', { account_label: accountLabel })) ended += 1;
  }
  return ended;
}

/**
 * Moves an active sign-in to an end state on its row and widget, stops the
 * login process, and resumes the waiting runs. Returns null when it had
 * ended already.
 */
async function endLogin(
  deps: LoginDeps,
  row: CoderLoginRow,
  status: Exclude<CoderLoginStatus, 'pending' | 'awaiting_code'>,
  extra: Partial<CoderLoginWidgetState> = {},
): Promise<CoderLoginRow | null> {
  const [updated] = await deps.db
    .update(schema.coderLogins)
    .set({
      status,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.account_label !== undefined ? { accountLabel: extra.account_label } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE)))
    .returning();
  if (!updated) return null;
  if (status !== 'signed_in') {
    await deps.infra.bus
      .publish<CoderControl>(CODER_CONTROL_CHANNEL, { type: 'stop', sessionId: row.id })
      .catch((error: unknown) =>
        deps.logger.warn({ err: error, loginId: row.id }, 'stopping a sign-in failed'),
      );
  }
  const state = await patchWidget(deps, updated, { status, ...extra });
  if (state) await resumeWaiting(deps, state);
  return updated;
}

/**
 * Resumes every run waiting on a sign-in with the widget's outcome. A run
 * that asked for the sign-in may not have paused yet; `resumeWaitingRun`
 * waits for the pause, so the run does not later resume with the stale
 * needs_login result.
 */
async function resumeWaiting(deps: LoginDeps, state: CoderLoginStoredState) {
  const output = widgetToolResult(KIND, state);
  await Promise.all(
    (state.waiting_runs ?? []).map((runId) =>
      resumeWaitingRun(deps, runId, output).catch((error: unknown) => {
        // Cancelled while it waited, or resumed already.
        deps.logger.info({ err: error, runId }, 'coding agent sign-in outcome not resumed');
      }),
    ),
  );
}

/**
 * Merges `patch` into the sign-in's widget state, when it has a widget, and
 * publishes it. Returns the new state.
 */
async function patchWidget(
  deps: LoginDeps,
  row: CoderLoginRow,
  patch: Partial<CoderLoginStoredState>,
): Promise<CoderLoginStoredState | null> {
  if (row.messageId === null || row.partIndex === null) return null;
  const done = await deps.db.transaction(async (tx) => {
    const [message] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row.messageId!));
    if (!message) return null;
    const [stored] = await tx
      .select()
      .from(schema.widgetStates)
      .where(
        and(
          eq(schema.widgetStates.messageId, row.messageId!),
          eq(schema.widgetStates.partIndex, row.partIndex!),
        ),
      )
      .for('update');
    const current = (stored?.state ?? { status: row.status }) as CoderLoginStoredState;
    const state: CoderLoginStoredState = { ...current, ...patch };
    await tx
      .insert(schema.widgetStates)
      .values({
        workspaceId: row.workspaceId,
        messageId: row.messageId!,
        partIndex: row.partIndex!,
        state,
      })
      .onConflictDoUpdate({
        target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
        set: { state, updatedAt: new Date() },
      });
    return { message, state };
  });
  if (!done) return null;
  await publishWidget(deps, done.message, row.partIndex, done.state);
  return done.state;
}

async function publishWidget(
  deps: Pick<AppDeps, 'infra'>,
  message: Pick<
    typeof schema.messages.$inferSelect,
    'id' | 'chatId' | 'seq' | 'authorType' | 'authorId'
  >,
  partIndex: number,
  state: unknown,
) {
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'widget.updated',
      { widget: { messageId: message.id, partIndex, state, pendingRunId: null } },
      {
        chat_id: message.chatId,
        seq: message.seq,
        ...(message.authorType === 'bot' && message.authorId ? { bot_id: message.authorId } : {}),
      },
    ),
  );
}

/**
 * The widget's action hook (services/runs.ts): `code` passes the code on,
 * `cant` and `api_key` end the sign-in (`failed`, `cancelled`). The
 * reducer already moved the state; this moves the row and the process.
 */
export async function onCoderLoginAction(
  deps: LoginDeps,
  props: CoderLoginProps,
  action: { type: 'code'; code: string } | { type: 'cant' } | { type: 'api_key' },
): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(schema.coderLogins)
    .where(eq(schema.coderLogins.id, props.login_id));
  if (!row) return;
  if (action.type === 'code') {
    await deps.db
      .update(schema.coderLogins)
      .set({ status: 'awaiting_code', updatedAt: new Date() })
      .where(and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE)));
    await writeLoginCode(deps, row.id, action.code);
    return;
  }
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  await cancelLogin(deps, owner, row.id, action.type === 'cant' ? 'failed' : 'cancelled');
}

// The driver

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;

/** Terminal output as plain text: escape sequences and carriage returns removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** How much of the login's output a failure keeps for its error. */
const TAIL_CHARS = 500;
/** How long a signed-in CLI gets to write its credentials and exit before it is closed. */
const SIGNED_IN_EXIT_MS = 10_000;

/** Said when the CLI printed a link on a host its adapter does not sign in on. */
export const UNEXPECTED_LOGIN_HOST = 'The sign-in printed a link on an unexpected host';

/**
 * The sign-in's link only when it is an https link on one of the adapter's
 * `loginHosts`; `rejected` when it is a link anywhere else.
 */
export function loginLink(
  url: string | undefined,
  hosts: readonly string[],
): { url?: string; rejected?: true } {
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    url.length > 2_000 ||
    !allowed.has(parsed.hostname.toLowerCase())
  ) {
    return { rejected: true };
  }
  return { url };
}

type Outcome =
  | { type: 'signed_in' }
  | { type: 'exit'; error?: string }
  | { type: 'cancelled' }
  | { type: 'timeout' };

/**
 * Runs one sign-in for the runner's `login` job: starts the computer if it
 * has to, runs the adapter's login in a PTY as `coder` with the agent's
 * config directory, and follows it until it signs in, fails, is cancelled
 * or runs out of time.
 */
export async function runCoderLogin(deps: AppDeps, loginId: string): Promise<void> {
  const [found] = await deps.db
    .select()
    .from(schema.coderLogins)
    .where(eq(schema.coderLogins.id, loginId));
  if (!found || !ACTIVE.includes(found.status as CoderLoginStatus)) return;
  let row = found;
  if (isPast(row)) {
    await endLogin(deps, row, 'expired', { error: 'The sign-in expired' });
    return;
  }
  const workspaceId = row.workspaceId;
  const scoped = <T>(fn: () => Promise<T>) => inWorkspace(workspaceId, fn);
  const owner = { id: row.ownerId, workspaceId };
  const agentName = row.agent as CoderAgent;
  const adapter = adapterFor(agentName);
  // Signed in in the terminal: Check ends it, there is nothing to run.
  if (terminalLogin(agentName)) return;
  const plan = adapter.login();

  let computer;
  try {
    ({ computer } = await startComputer(deps, owner, SYSTEM_ACTOR));
  } catch (error) {
    await endLogin(deps, row, 'failed', {
      error: `The computer did not start: ${(error as Error).message}`,
    });
    return;
  }
  const agent = agentFor(deps, computer);
  const config = CODER_CONFIG_DIRS[agentName];

  let parse: CoderLoginParse = {};
  let tail = '';
  /** The codes the owner sent, kept out of any error text (the PTY echoes them). */
  const codes: string[] = [];
  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
  let exited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => (exited = resolve));
  // Row and widget writes, one at a time and in order.
  let writes: Promise<unknown> = Promise.resolve();
  const persist = (fn: () => Promise<unknown>) => {
    writes = writes
      .then(() => scoped(fn))
      .catch((error: unknown) =>
        deps.logger.warn({ err: error, loginId }, 'saving the sign-in progress failed'),
      );
  };

  const read = (data: string) => {
    const text = stripAnsi(data);
    tail = (tail + text).slice(-TAIL_CHARS * 4);
    const before = parse;
    parse = adapter.parseLogin(text, parse);
    const link = loginLink(parse.url, adapter.loginHosts);
    if (link.rejected) {
      // Never shown to the owner: a tampered CLI or environment could phish.
      settle({ type: 'exit', error: UNEXPECTED_LOGIN_HOST });
      return;
    }
    const url = link.url;
    const changed =
      url !== loginLink(before.url, adapter.loginHosts).url ||
      parse.deviceCode !== before.deviceCode ||
      (parse.awaitingCode && !before.awaitingCode);
    if (changed) {
      const deviceCode = parse.deviceCode;
      const awaitingCode = !!parse.awaitingCode;
      persist(async () => {
        const [current] = await deps.db
          .select()
          .from(schema.coderLogins)
          .where(eq(schema.coderLogins.id, loginId));
        if (!current) return;
        // A code the owner already sent keeps the sign-in at awaiting_code.
        const status: CoderLoginStatus =
          awaitingCode || current.status === 'awaiting_code' ? 'awaiting_code' : 'pending';
        const [updated] = await deps.db
          .update(schema.coderLogins)
          .set({
            // The link and code stay on the row (and the widget) through awaiting_code.
            url: url ?? current.url,
            deviceCode: deviceCode ?? current.deviceCode,
            status,
            updatedAt: new Date(),
          })
          .where(
            and(eq(schema.coderLogins.id, loginId), inArray(schema.coderLogins.status, ACTIVE)),
          )
          .returning();
        if (updated) {
          row = updated;
          await patchWidget(deps, updated, {
            status,
            ...(updated.url ? { url: updated.url } : {}),
            ...(updated.deviceCode ? { device_code: updated.deviceCode } : {}),
          });
        }
      });
    }
    if (parse.signedIn) settle({ type: 'signed_in' });
    else if (parse.error) settle({ type: 'exit', error: parse.error });
  };

  let proc: Awaited<ReturnType<ComputerAgentClient['coder']>> | undefined;
  const unsubscribe = await deps.infra.bus.subscribe<CoderControl>(CODER_CONTROL_CHANNEL, (raw) => {
    const msg = CoderControlSchema.safeParse(raw);
    if (!msg.success || !('sessionId' in msg.data) || msg.data.sessionId !== loginId) return;
    if (msg.data.type === 'stdin') {
      codes.push(msg.data.data.trim());
      try {
        proc?.write(msg.data.data);
      } catch {
        // It ended; the exit says how.
      }
    } else if (msg.data.type === 'stop') {
      settle({ type: 'cancelled' });
    }
  });

  const expiresIn = row.expiresAt ? row.expiresAt.getTime() - Date.now() : plan.timeoutMs;
  const timer = setTimeout(() => settle({ type: 'timeout' }), Math.min(plan.timeoutMs, expiresIn));
  try {
    try {
      proc = await agent.coder(
        {
          session_id: loginId,
          user: 'coder',
          pty: true,
          command: plan.command,
          args: plan.args,
          env: { [config.env]: config.dir, ...(plan.env ?? {}) },
          git_credentials: false,
        },
        {
          stdout: read,
          stderr: read,
          credentialRequest: () => {},
          permissionRequest: () => {},
          exit: (info) => {
            exited();
            settle({ type: 'exit', ...(info.error ? { error: info.error } : {}) });
          },
        },
      );
    } catch (error) {
      settle({ type: 'exit', error: (error as Error).message });
    }
    const result = await outcome;
    clearTimeout(timer);
    if (result.type === 'signed_in') {
      // The CLI writes its credentials as it says so; give it the moment to exit.
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, SIGNED_IN_EXIT_MS))]);
    }
    await proc?.close().catch(() => {});
    await writes;
    await scoped(async () => {
      if (result.type === 'signed_in') {
        await signedIn(deps, row, agent, parse.accountLabel?.trim() || 'Signed in');
      } else if (result.type === 'timeout') {
        await endLogin(deps, row, 'expired', { error: 'The sign-in expired' });
      } else if (result.type === 'exit') {
        const said = redact(stripAnsi(tail).trim(), codes).slice(-TAIL_CHARS);
        const raw = result.error ?? (said || 'The sign-in ended before it finished');
        const error = signInErrorForOwner(agentName, raw);
        if (error !== raw) {
          deps.logger.warn({ loginId, agent: agentName, output: raw }, 'the sign-in was refused');
        }
        await endLogin(deps, row, 'failed', { error });
      }
      // Cancelled: cancelLogin moved the row and the widget already.
    });
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

function redact(text: string, codes: string[]) {
  return codes.filter(Boolean).reduce((out, code) => out.split(code).join('…'), text);
}

/** The sign-in worked: the account row says so, and every waiting run resumes. */
async function signedIn(
  deps: AppDeps,
  row: CoderLoginRow,
  agent: ComputerAgentClient,
  accountLabel: string,
) {
  const agentName = row.agent as CoderAgent;
  const version = await coderVersion(agent, agentName).catch(() => null);
  const now = new Date();
  await deps.db
    .insert(schema.coderAccounts)
    .values({
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      agent: agentName,
      authKind: 'subscription',
      accountLabel,
      signedInAt: now,
      lastError: null,
      ...(version ? { version } : {}),
    })
    .onConflictDoUpdate({
      target: [
        schema.coderAccounts.workspaceId,
        schema.coderAccounts.ownerId,
        schema.coderAccounts.agent,
      ],
      set: {
        authKind: 'subscription',
        accountLabel,
        signedInAt: now,
        lastError: null,
        ...(version ? { version } : {}),
        updatedAt: now,
      },
    });
  await recordAudit(deps.db, {
    workspaceId: row.workspaceId,
    actor: { type: 'user', id: row.ownerId } satisfies AuditActor,
    action: 'coder.sign_in',
    targetType: 'coder_login',
    targetId: row.id,
    metadata: { agent: agentName },
  });
  await endLogin(deps, row, 'signed_in', { account_label: accountLabel });
}

/** `<cli> --version` on the computer, its first line. */
export async function coderVersion(
  agent: ComputerAgentClient,
  agentName: CoderAgent,
): Promise<string | null> {
  const adapter = adapterFor(agentName);
  // `versionArgs` may be the flags alone (`['--version']`): they go to the CLI the login runs.
  const argv = adapter.versionArgs[0]?.startsWith('-')
    ? [adapter.login().command, ...adapter.versionArgs]
    : adapter.versionArgs;
  const [command, ...args] = argv;
  if (!command) return null;
  const { code, stdout } = await runAsCoder(agent, command, args);
  if (code !== 0) return null;
  const line = stripAnsi(stdout).trim().split('\n')[0]?.trim();
  return line ? line.slice(0, 100) : null;
}

/** How long a one-off command as `coder` (a version, a sign-out, a discard) may take. */
const COMMAND_MS = 60_000;

/**
 * Runs one command as `coder` over WS /coder and collects its output: for
 * the short jobs around the sessions (the CLI's version, signing out,
 * removing a worktree). The output is capped at `maxBytes`.
 */
export function runAsCoder(
  agent: ComputerAgentClient,
  command: string,
  args: string[],
  { env = {}, maxBytes = 2_000_000 }: { env?: Record<string, string>; maxBytes?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const keep = (current: string, data: string) =>
      current.length >= maxBytes ? current : (current + data).slice(0, maxBytes);
    const timer = setTimeout(() => {
      void opened.then((p) => p.close()).catch(() => {});
    }, COMMAND_MS);
    const opened = agent.coder(
      {
        session_id: randomUUID(),
        user: 'coder',
        command,
        args,
        env,
        git_credentials: false,
      },
      {
        stdout: (d) => (stdout = keep(stdout, d)),
        stderr: (d) => (stderr = keep(stderr, d)),
        credentialRequest: () => {},
        permissionRequest: () => {},
        exit: (info) => {
          clearTimeout(timer);
          void opened.then((p) => p.close()).catch(() => {});
          resolve({
            code: info.code,
            stdout,
            stderr,
            ...(info.error ? { error: info.error } : {}),
          });
        },
      },
    );
    opened.catch((error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
