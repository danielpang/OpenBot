import { COMPUTER_HOME } from '@openbots/computer';
import {
  CODER_AGENT_LABELS,
  wsEvent,
  type CoderAgent,
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
import { DomainError, notFound } from '../errors.js';
import { publishEvent } from '../infra/index.js';
import { adapterFor } from './coder-adapters/index.js';
import { publishCoderControl } from './coder-control.js';
import { enqueueCoderJob } from './coder-jobs.js';
import { resumeWaitingRun } from './coder-run-resume.js';
import { mainBotOf, type BotRow } from './bots.js';
import { botPairChat } from './chats.js';
import { announceMessage, storeMessage, type ChatRow } from './messages.js';
import type { RunState } from './runs.js';

// Coding agent sign-ins (docs/plans/TECHNICAL_PLAN.md 22.5; I4). `startLogin`
// records the attempt (`coder_logins`), posts the `coder_login` widget when a
// Bot asked (in the main Bot's transcript, like a site sign-in request, K8)
// and enqueues the runner's `login` job, which runs the vendor's own login
// (coder-login-driver.ts). A pending login for the same agent is reused: a
// second asking run joins it (`waiting_runs` in the widget's state), and
// every one of them resumes with the outcome. An asking run that already
// waits on another widget (the runner found the agent signed out while a
// `coding_session` widget held the run, CA10) is moved to wait on the
// sign-in instead. An unanswered login expires after CODER_LOGIN_TTL_MS, at
// the driver's timeout or lazily when read. An agent that signs in in its
// own terminal (pi) has no login to drive: its sign-ins end when Check finds
// it signed in (`completeTerminalLogins`).

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
export const ACTIVE_LOGIN: CoderLoginStatus[] = ['pending', 'awaiting_code'];

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

export { CODEX_SIGN_IN_REFUSED } from './coder-adapters/codex.js';

/** A failed sign-in's error as the owner reads it: a vendor 401 in plain words, when the adapter has them. */
export function signInErrorForOwner(agent: CoderAgent, raw: string): string {
  const refused = adapterFor(agent).signInRefused;
  return refused && /\b401\b|unauthori[sz]ed/i.test(raw) ? refused : raw;
}

/** Where the owner signs an agent in by hand: a terminal as `coder`, the CLI typed. */
export interface CoderLoginTerminal {
  cwd: string;
  user: 'coder';
  preset: string;
}

/**
 * The agent has no headless sign-in (its adapter's `signIn.kind` is
 * `terminal`), so the owner signs in in a terminal on the computer, then
 * checks it (`POST /coders/{agent}/check`): the 409 Settings gets.
 */
export class CoderLoginInTerminalError extends DomainError {
  constructor(
    message: string,
    readonly terminal: CoderLoginTerminal,
  ) {
    super(409, 'CODER_LOGIN_IN_TERMINAL', message);
  }
}

/** The terminal sign-in the agent asks for, or null when its login runs headless. */
export function terminalLogin(agent: CoderAgent): CoderLoginInTerminalError | null {
  const signIn = adapterFor(agent).signIn;
  if (signIn.kind !== 'terminal') return null;
  return new CoderLoginInTerminalError(signIn.instructions, {
    cwd: COMPUTER_HOME,
    user: 'coder',
    preset: signIn.preset,
  });
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
          inArray(schema.coderLogins.status, ACTIVE_LOGIN),
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
      instructions: adapterFor(agent).signIn.instructions,
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
        inArray(schema.coderLogins.status, ACTIVE_LOGIN),
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
  if (ACTIVE_LOGIN.includes(row.status as CoderLoginStatus) && isPast(row)) {
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

export const isPast = (row: CoderLoginRow, now = Date.now()) =>
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
        inArray(schema.coderLogins.status, ACTIVE_LOGIN),
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
  if (!ACTIVE_LOGIN.includes(row.status as CoderLoginStatus) || isPast(row)) {
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
    .where(and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE_LOGIN)))
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
  await publishCoderControl(deps, { type: 'stdin', sessionId: loginId, data: `${code.trim()}\r` });
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
        inArray(schema.coderLogins.status, ACTIVE_LOGIN),
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
export async function endLogin(
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
    .where(and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE_LOGIN)))
    .returning();
  if (!updated) return null;
  if (status !== 'signed_in') {
    await publishCoderControl(deps, { type: 'stop', sessionId: row.id }).catch((error: unknown) =>
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
export async function patchWidget(
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
      .where(
        and(eq(schema.coderLogins.id, row.id), inArray(schema.coderLogins.status, ACTIVE_LOGIN)),
      );
    await writeLoginCode(deps, row.id, action.code);
    return;
  }
  const owner = { id: row.ownerId, workspaceId: row.workspaceId };
  await cancelLogin(deps, owner, row.id, action.type === 'cant' ? 'failed' : 'cancelled');
}
