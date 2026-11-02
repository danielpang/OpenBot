import type { LoginRequestInput, LoginRequestPlan, LoginRequests } from '@openbots/agent';
import { PRIORITY, wsEvent, type JobHandler, type MessagePart } from '@openbots/shared';
import {
  validateWidgetProps,
  widgetToolResult,
  type LoginRequestState,
  type LoginRequestWaiter,
} from '@openbots/widgets';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { publishEvent } from '../infra/index.js';
import { approvalTtlMs } from './approvals.js';
import { mainBotOf, type BotRow } from './bots.js';
import { botPairChat } from './chats.js';
import { syncCookies } from './computer.js';
import { onWidgetAction } from './hooks.js';
import { announceMessage, storeMessage, type ChatRow } from './messages.js';
import { resumeRun } from './runs.js';

// Sign-in requests (K1, K8). A Bot that needs a login it lacks calls
// `request_login`. The `login_request` widget always goes in a transcript
// (plan 9.7 step 3), whichever chat the run is in: the main Bot's when one is
// set and another Bot asks, else the asking Bot's own. A request in the
// transcript the run is in is the run's own widget, and the run waits on it
// like a question (`widget_states.pending_run_id`). Anywhere else the server
// posts it there, authored by the transcript's Bot and starting no run, and
// the run's chat keeps only its "Asked for a sign-in" row; a routed request
// is also announced in the pair's `bot_to_bot` chat (C6). The runs waiting on
// a posted request are listed in its state (`waiting`), so a second Bot (or a
// second run) asking for the same site while it is pending joins it instead
// of asking the owner again. Done syncs the computer's cookies first, then
// every waiting run resumes with the outcome.
//
// Sites are merged by registrable domain (plan 9.7): `accounts.google.com` and
// `mail.google.com` are one request for `google.com`, since a sign-in is a
// cookie on that domain. Like an approval (services/approvals.ts), an
// unanswered request expires after OPENBOTS_APPROVAL_TTL_MINUTES: a delayed job
// per request, and a sweep at worker start for jobs an in-memory queue lost.
// Every waiting run resumes told that the request expired.

const KIND = 'login_request';
export const LOGINS_QUEUE = 'logins';

/** Where a request sits: its widget part. */
export interface LoginExpireJob {
  messageId: string;
  partIndex: number;
}
/** How far back a transcript is searched for a pending request. */
const RECENT_REQUESTS = 50;

type LoginsDeps = Pick<AppDeps, 'config' | 'db' | 'infra' | 'logger'>;

export const invalidSite = () =>
  new Error('Name the site by its host name, like github.com, or give its sign-in url');

/** The host as a lower-case name without `www.`, from a host, a url or the sign-in url. */
export function hostOf(site: string, url?: string): string {
  const host = (value: string) => {
    try {
      const parsed = new URL(value.includes('://') ? value : `https://${value}`);
      const name = parsed.hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, '');
      return name.includes('.') || name === 'localhost' ? name : null;
    } catch {
      return null;
    }
  };
  const found = host(site.trim()) ?? (url ? host(url) : null);
  if (!found) throw invalidSite();
  return found;
}

/**
 * Second-level labels that are public suffixes under a two-letter country
 * code (`co.uk`, `com.au`, `ne.jp`), so `bbc.co.uk` keeps three labels.
 */
const COUNTRY_SECOND_LEVEL = new Set(
  'ac co com edu gob gov go govt ltd me mil ne net nic or org plc sch'.split(' '),
);

/** Hosting domains where each subdomain is someone else's site, with cookies of its own. */
const SHARED_HOSTING = new Set([
  'appspot.com',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'gitlab.io',
  'herokuapp.com',
  'netlify.app',
  'onrender.com',
  'pages.dev',
  'vercel.app',
  'web.app',
  'workers.dev',
]);

/**
 * The registrable domain of a host (plan 9.7), by a small rule rather than
 * the full public suffix list: the last two labels, or three under a country
 * code's public second level (`co.uk`) or a shared hosting domain
 * (`github.io`). `localhost` and IP addresses stay as they are. The rule can
 * split a site the full list would merge (a rare suffix like `kyoto.jp`
 * merges more than it should), which costs at most one extra request.
 */
export function registrableDomain(host: string): string {
  if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const [second, top] = labels.slice(-2) as [string, string];
  const suffixOfThree =
    SHARED_HOSTING.has(`${second}.${top}`) ||
    (top.length === 2 && COUNTRY_SECOND_LEVEL.has(second));
  return labels.slice(suffixOfThree ? -3 : -2).join('.');
}

/** The site a request is for: the registrable domain of the host it names. */
export function siteOf(site: string, url?: string): string {
  return registrableDomain(hostOf(site, url));
}

/** The run asking: which chat it is in decides whether it posts the widget itself. */
type AskingRun = { id: string; chatId: string | null };

/** `ToolContext.logins` for one run. */
export function loginRequests(deps: LoginsDeps, run: AskingRun, bot: BotRow): LoginRequests {
  return { request: (input) => requestLogin(deps, run, bot, input) };
}

export async function requestLogin(
  deps: LoginsDeps,
  run: AskingRun,
  bot: BotRow,
  input: LoginRequestInput,
): Promise<LoginRequestPlan> {
  const host = hostOf(input.site, input.url);
  const site = registrableDomain(host);
  // The screen opens on the host asked for, a subdomain (`accounts.google.com`)
  // or the site itself, rather than on a blank page.
  const url = input.url ?? `https://${host}/`;
  const main = await mainBotOf(deps.db, { id: bot.ownerId, workspaceId: bot.workspaceId });
  const screenBot = main && !main.archivedAt ? main : bot;
  const checked = validateWidgetProps(KIND, {
    site,
    ...(url ? { url } : {}),
    reason: input.reason.trim(),
    requester: { bot_id: bot.id, handle: bot.handle, name: bot.name },
    screen_bot_id: screenBot.id,
  });
  if (!checked.ok) throw new Error(checked.error);
  const widget = { kind: KIND, props: checked.value } as const;

  const reason = input.reason.trim();
  const waiter: LoginRequestWaiter = {
    run_id: run.id,
    bot_id: bot.id,
    handle: bot.handle,
    ...(reason ? { reason } : {}),
  };
  const transcript = await transcriptOf(deps.db, screenBot);
  // The Bot's own request from a run in its own transcript: the run posts it.
  const inline = screenBot.id === bot.id && run.chatId === transcript.id;
  const done = await deps.db.transaction(async (tx) => {
    // One request per site at a time: a second asker waits for the first post.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`login:${screenBot.id}:${site}`}))`,
    );
    const pending = await pendingRequest(tx, transcript, screenBot, site);
    if (pending) {
      const waiting = [...(pending.state.waiting ?? [])];
      if (!waiting.some((w) => w.run_id === run.id)) waiting.push(waiter);
      // The main Bot's own request gets its expiry here when another Bot joins first.
      const expiresAt = pending.state.expires_at ?? loginExpiresAt(deps);
      const state: LoginRequestState = { ...pending.state, waiting, expires_at: expiresAt };
      await tx
        .insert(schema.widgetStates)
        .values({
          workspaceId: transcript.workspaceId,
          messageId: pending.message.id,
          partIndex: pending.partIndex,
          state,
        })
        .onConflictDoUpdate({
          target: [schema.widgetStates.messageId, schema.widgetStates.partIndex],
          set: { state, updatedAt: new Date() },
        });
      const handoff =
        bot.id === screenBot.id ? null : await handoffNote(tx, bot, screenBot, site, input.reason);
      const scheduled = pending.state.expires_at ? null : expiresAt;
      return { kind: 'joined' as const, ...pending, state, handoff, scheduled };
    }
    // None pending, and the run is in the transcript: it posts the widget.
    if (inline) return null;
    const message = await storeMessage(tx, transcript, {
      authorType: 'bot',
      authorId: screenBot.id,
      parts: [{ type: 'widget', kind: KIND, props: widget.props, state: { status: 'pending' } }],
    });
    const expiresAt = loginExpiresAt(deps);
    const state: LoginRequestState = {
      status: 'pending',
      waiting: [waiter],
      expires_at: expiresAt,
    };
    await tx.insert(schema.widgetStates).values({
      workspaceId: transcript.workspaceId,
      messageId: message.id,
      partIndex: 0,
      state,
    });
    // Routed: the asker tells the main Bot (C6). Its own, from another chat:
    // the run's chat keeps its "Asked for a sign-in" row as the pointer.
    const handoff =
      bot.id === screenBot.id ? null : await handoffNote(tx, bot, screenBot, site, input.reason);
    return {
      kind: 'posted' as const,
      message,
      partIndex: 0,
      state,
      handoff,
      scheduled: expiresAt,
    };
  });
  if (!done) return { site, widget };

  if (done.scheduled) {
    await scheduleLoginExpiry(
      deps,
      { messageId: done.message.id, partIndex: done.partIndex },
      done.scheduled,
    );
  }
  if (done.handoff) await announceMessage(deps, done.handoff);
  if (done.kind === 'posted') {
    await announceMessage(deps, done.message);
  } else {
    await publishEvent(
      deps.infra.bus,
      wsEvent(
        'widget.updated',
        {
          widget: {
            messageId: done.message.id,
            partIndex: done.partIndex,
            state: done.state,
            pendingRunId: null,
          },
        },
        { chat_id: done.message.chatId, seq: done.message.seq, bot_id: screenBot.id },
      ),
    );
  }
  return { site, widget, posted: { messageId: done.message.id, partIndex: done.partIndex } };
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

/** The newest unanswered request for `site` in a Bot's transcript, if any. */
async function pendingRequest(tx: Db, transcript: ChatRow, main: BotRow, site: string) {
  const rows = await tx
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chatId, transcript.id),
        eq(schema.messages.authorType, 'bot'),
        eq(schema.messages.authorId, main.id),
        sql`${schema.messages.parts} @> ${JSON.stringify([{ type: 'widget', kind: KIND }])}::jsonb`,
      ),
    )
    .orderBy(desc(schema.messages.seq))
    .limit(RECENT_REQUESTS);
  for (const message of rows) {
    const parts = message.parts as MessagePart[];
    for (const [partIndex, part] of parts.entries()) {
      if (part.type !== 'widget' || part.kind !== KIND) continue;
      if ((part.props as { site?: unknown } | undefined)?.site !== site) continue;
      const [stored] = await tx
        .select()
        .from(schema.widgetStates)
        .where(
          and(
            eq(schema.widgetStates.messageId, message.id),
            eq(schema.widgetStates.partIndex, partIndex),
          ),
        )
        .for('update');
      // A request a run posted itself has no row until the run pauses.
      const state = (stored?.state ?? part.state ?? { status: 'pending' }) as LoginRequestState;
      if (state.status === 'pending') return { message, partIndex, state };
    }
  }
  return null;
}

/** The asking Bot's line in its chat with the main Bot (C6), so the owner sees the handoff. */
async function handoffNote(tx: Db, bot: BotRow, main: BotRow, site: string, reason: string) {
  const chat = await botPairChat(tx, bot, main);
  return storeMessage(tx, chat, {
    authorType: 'bot',
    authorId: bot.id,
    parts: [
      {
        type: 'text',
        text: `I need a sign-in to ${site}. ${sentence(reason)} I asked our owner in your transcript, and I am waiting for their answer.`,
      },
    ],
  });
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * A run that paused on a request posted elsewhere, after the owner already
 * answered it (they pressed Done while the run was still finishing its
 * step): resume it now, since the answer found no waiting run.
 */
export async function resumeIfAnswered(
  deps: LoginsDeps,
  runId: string,
  posted: { messageId: string; partIndex: number },
): Promise<void> {
  const [stored] = await deps.db
    .select()
    .from(schema.widgetStates)
    .where(
      and(
        eq(schema.widgetStates.messageId, posted.messageId),
        eq(schema.widgetStates.partIndex, posted.partIndex),
      ),
    );
  const state = stored?.state as LoginRequestState | undefined;
  if (!state || state.status === 'pending') return;
  await resumeRun(deps, runId, widgetToolResult(KIND, state)).catch((error: unknown) => {
    deps.logger.info({ err: error, runId }, 'sign-in answer not resumed');
  });
}

// Expiry (plan 9.7): on the approvals' TTL and mechanism.

/** When a request made now expires (ISO 8601): OPENBOTS_APPROVAL_TTL_MINUTES, like an approval. */
export function loginExpiresAt(deps: Pick<AppDeps, 'config'>, now = Date.now()): string {
  return new Date(now + approvalTtlMs(deps.config)).toISOString();
}

/** The delayed `expire` job for a request, due at `expiresAt`. */
export async function scheduleLoginExpiry(
  deps: Pick<AppDeps, 'infra'>,
  target: LoginExpireJob,
  expiresAt: string,
): Promise<void> {
  const delayMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  await deps.infra
    .queue<LoginExpireJob>(LOGINS_QUEUE)
    .enqueue('expire', target, { delayMs, priority: PRIORITY.background });
}

/**
 * Expires one request once its time is up: the widget closes as `expired`,
 * the owner's transcript hears so, and every waiting run (the one waiting
 * through `pending_run_id` and each in `waiting`) resumes told the request
 * expired, which also moves its Bot out of the waiting state. A request from
 * before expiry was recorded expires a TTL after its message. Returns whether
 * it expired anything.
 */
export async function expireLoginRequest(
  deps: LoginsDeps,
  target: LoginExpireJob,
  now = new Date(),
): Promise<boolean> {
  const [message] = await deps.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, target.messageId));
  const part = (message?.parts as MessagePart[] | undefined)?.[target.partIndex];
  if (!message || part?.type !== 'widget' || part.kind !== KIND) return false;
  const done = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.widgetStates)
      .where(
        and(
          eq(schema.widgetStates.messageId, target.messageId),
          eq(schema.widgetStates.partIndex, target.partIndex),
        ),
      )
      .for('update');
    const state = row?.state as LoginRequestState | undefined;
    if (!row || state?.status !== 'pending') return null;
    const due = state.expires_at
      ? new Date(state.expires_at)
      : new Date(message.createdAt.getTime() + approvalTtlMs(deps.config));
    if (due > now) return null;
    const expired: LoginRequestState = { ...state, status: 'expired' };
    await tx
      .update(schema.widgetStates)
      .set({ state: expired, pendingRunId: null, updatedAt: new Date() })
      .where(eq(schema.widgetStates.id, row.id));
    return { state: expired, pendingRunId: row.pendingRunId };
  });
  if (!done) return false;
  await publishEvent(
    deps.infra.bus,
    wsEvent(
      'widget.updated',
      {
        widget: {
          messageId: message.id,
          partIndex: target.partIndex,
          state: done.state,
          pendingRunId: null,
        },
      },
      {
        chat_id: message.chatId,
        seq: message.seq,
        ...(message.authorType === 'bot' && message.authorId ? { bot_id: message.authorId } : {}),
      },
    ),
  );
  const output = widgetToolResult(KIND, done.state);
  const runs = new Set([
    ...(done.pendingRunId ? [done.pendingRunId] : []),
    ...(done.state.waiting ?? []).map((w) => w.run_id),
  ]);
  for (const runId of runs) {
    await resumeRun(deps, runId, output).catch((error: unknown) => {
      // Cancelled while it waited: nothing to tell.
      deps.logger.info({ err: error, runId }, 'expired sign-in request not resumed');
    });
  }
  return true;
}

/** Every pending request past its time; at worker start, for jobs an in-memory queue lost. */
export async function expireDueLoginRequests(deps: LoginsDeps, now = new Date()) {
  const ws = schema.widgetStates;
  const cutoff = new Date(now.getTime() - approvalTtlMs(deps.config));
  const due = await deps.db
    .select({ messageId: ws.messageId, partIndex: ws.partIndex })
    .from(ws)
    .innerJoin(schema.messages, eq(schema.messages.id, ws.messageId))
    .where(
      and(
        sql`${ws.state} ->> 'status' = 'pending'`,
        sql`${schema.messages.parts} @> ${JSON.stringify([{ type: 'widget', kind: KIND }])}::jsonb`,
        sql`case when ${ws.state} ->> 'expires_at' is not null
          then (${ws.state} ->> 'expires_at')::timestamptz <= ${now.toISOString()}::timestamptz
          else ${schema.messages.createdAt} <= ${cutoff.toISOString()}::timestamptz end`,
      ),
    );
  let expired = 0;
  for (const target of due) if (await expireLoginRequest(deps, target, now)) expired++;
  return expired;
}

/** The `logins` queue handler: one delayed `expire` job per request. */
export function loginExpiryHandler(deps: AppDeps): JobHandler<LoginExpireJob> {
  return async (job) => {
    await expireLoginRequest(deps, job.data);
  };
}

/**
 * Registers the `login_request` widget hook: once the owner answers, Done
 * syncs the computer's cookies so the login reaches every screen (a hand
 * back from Takeover has synced already; this covers signing in some other
 * way, and a Bot whose screen was not running then), then every
 * waiting run resumes with the outcome. The run waiting through
 * `pending_run_id` (a request in the asker's own transcript) is resumed by
 * the widget action itself, right after. Call once per process (main.ts).
 */
export function registerLoginHooks(): () => void {
  return onWidgetAction(KIND, async (deps, tx, { message, state }) => {
    const answered = state as LoginRequestState;
    const [chat] = await tx
      .select({ ownerId: schema.chats.ownerId, workspaceId: schema.chats.workspaceId })
      .from(schema.chats)
      .where(eq(schema.chats.id, message.chatId));
    return {
      after: async () => {
        if (answered.status === 'signed_in' && chat) {
          // Every live screen: the one signed in on gives, the others take.
          // The computer helpers key their provider on the process's
          // AppDeps, the object every widget action is called with.
          await syncCookies(deps as AppDeps, { id: chat.ownerId, workspaceId: chat.workspaceId });
        }
        const output = widgetToolResult(KIND, answered);
        for (const waiter of answered.waiting ?? []) {
          await resumeRun(deps, waiter.run_id, output).catch((error: unknown) => {
            // Cancelled, or resumed already as the widget's pending run.
            deps.logger.info({ err: error, runId: waiter.run_id }, 'sign-in answer not resumed');
          });
        }
      },
    };
  });
}
