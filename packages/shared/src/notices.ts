import type { WsEvent } from './events.js';
import { parseMentions } from './parts.js';

// Which realtime events become a notification (N1): approvals, questions
// (and any other widget that waits on the owner), mentions of the owner,
// Routine exceptions, long tasks that finished, and repositories the
// computer could not clone again after it started. One watcher for both
// clients: the Mac app's main process shows them natively, and the web app
// shows browser notifications when it runs outside the Mac app.

export type NoticeKind =
  'approval' | 'question' | 'mention' | 'routine' | 'long_task' | 'repos_clone_failed';

/**
 * The event part the server posts in the main Bot's transcript when the
 * reconcile after a computer start could not clone repositories again; its
 * `data` holds `botId` and `failed` (`fullName`, `error`).
 */
export const REPOS_CLONE_FAILED = 'repos_clone_failed';

/** Where a notice opens: the message, in its thread when it is a reply. */
export interface NoticeTarget {
  botId: string;
  chatId: string | undefined;
  seq: number | undefined;
  /** The thread's root message, when the message is in a thread. */
  threadRootId: string | undefined;
}

export interface Notice {
  kind: NoticeKind;
  /** One notification per request: a second event for it is dropped. */
  tag: string;
  title: string;
  body: string;
  target: NoticeTarget;
}

export interface NoticeContext {
  botName(botId: string): string | undefined;
  /** Lowercased handles that mean the owner in `@handle` mentions. */
  ownerHandles: readonly string[];
}

/**
 * Widgets that wait on the owner, by widget kind: each notifies like a
 * question. `title` follows the name of the Bot whose transcript holds the
 * widget, unless `heading` gives the whole title from the props; `body` reads
 * the widget's props. A new kind that needs the owner is one entry here.
 */
export const OWNER_INPUT_WIDGETS: Readonly<
  Record<
    string,
    {
      title: string;
      heading?(props: Record<string, unknown>): string | undefined;
      body(props: Record<string, unknown>): string;
    }
  >
> = {
  question: {
    title: 'has a question',
    body: (props) => (typeof props.question === 'string' ? props.question : 'Open to answer'),
  },
  // A sign-in request (K8). With a main Bot it sits in the main Bot's
  // transcript, so the title names the Bot that needs the login.
  login_request: {
    title: 'needs you to sign in',
    heading: (props) => {
      const requester = props.requester as { name?: unknown } | undefined;
      const name = typeof requester?.name === 'string' ? requester.name : undefined;
      const site = typeof props.site === 'string' ? props.site : undefined;
      if (!name) return undefined;
      return site ? `${name} needs you to sign in to ${site}` : `${name} needs you to sign in`;
    },
    body: (props) =>
      typeof props.reason === 'string' && props.reason
        ? props.reason
        : typeof props.site === 'string'
          ? `Sign in to ${props.site}`
          : 'Open to sign in',
  },
};

/** A run that ends after this long, while the owner is elsewhere, is a "finished long task". */
export const LONG_TASK_MS = 2 * 60_000;

/**
 * Runs that never notify as long tasks: a Routine's exceptions notify as
 * Routine notices and its successes stay quiet, and Bot to Bot runs are a
 * step of some other task.
 */
export const QUIET_TRIGGERS: readonly string[] = ['routine', 'bot_message', 'bot_dm'];

/** Handles a Bot might use for its owner: the name, the first name, the email's local part. */
export function ownerHandles(user: { name: string; email: string }): string[] {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim();
  const name = slug(user.name);
  const handles = [
    name.replace(/\s+/g, ''),
    name.replace(/\s+/g, '-'),
    name.replace(/\s+/g, '_'),
    name.split(/\s+/)[0] ?? '',
    slug(user.email.split('@')[0] ?? '').replace(/\s+/g, ''),
  ];
  return [...new Set(handles.filter((h) => /^[a-z0-9_-]{1,32}$/.test(h)))];
}

/** "3 minutes", "1 hour", "2 hours 5 minutes". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(hours, 'hour');
}

interface PartLike {
  type?: string;
  kind?: string;
  text?: string;
  props?: Record<string, unknown>;
}

const truncate = (text: string, max = 180) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const idOrUndefined = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Turns the event stream into notices. Mentions need the whole text of a
 * streamed Bot message, so the watcher keeps it per message until
 * `message.completed`.
 */
export function createNoticeWatcher(context: () => NoticeContext) {
  const streaming = new Map<
    string,
    {
      chatId: string;
      botId: string;
      seq: number;
      threadRootId: string | undefined;
      parts: PartLike[];
    }
  >();
  const shown = new Set<string>();

  const target = (
    botId: string,
    chatId: string | undefined,
    seq: number | undefined,
    threadRootId?: unknown,
  ): NoticeTarget => ({
    botId,
    chatId,
    seq: seq != null && seq > 0 ? seq : undefined,
    threadRootId: idOrUndefined(threadRootId),
  });

  function once(notice: Notice | null): Notice | null {
    if (!notice || shown.has(notice.tag)) return null;
    shown.add(notice.tag);
    return notice;
  }

  const nameOf = (botId: string) => context().botName(botId) ?? 'A Bot';

  function mentionIn(
    parts: PartLike[],
    meta: { messageId: string; target: NoticeTarget },
  ): Notice | null {
    const text = parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    const { handles } = parseMentions(text);
    const owner = context().ownerHandles;
    if (!handles.some((h) => owner.includes(h))) return null;
    return {
      kind: 'mention',
      tag: `mention:${meta.messageId}`,
      title: `${nameOf(meta.target.botId)} mentioned you`,
      body: truncate(text),
      target: meta.target,
    };
  }

  function askingIn(
    parts: PartLike[],
    meta: { messageId: string; target: NoticeTarget },
  ): Notice | null {
    for (const p of parts) {
      const widget = p?.type === 'widget' && p.kind ? OWNER_INPUT_WIDGETS[p.kind] : undefined;
      if (!widget) continue;
      return {
        kind: 'question',
        tag: `question:${meta.messageId}`,
        title: widget.heading?.(p.props ?? {}) ?? `${nameOf(meta.target.botId)} ${widget.title}`,
        body: truncate(widget.body(p.props ?? {})),
        target: meta.target,
      };
    }
    return null;
  }

  function longTask(event: Extract<WsEvent, { type: 'run.status' }>): Notice | null {
    const { payload } = event;
    const botId = event.bot_id;
    if (!botId || (payload.status !== 'completed' && payload.status !== 'failed')) return null;
    if (typeof payload.trigger === 'string' && QUIET_TRIGGERS.includes(payload.trigger)) {
      return null;
    }
    const started = Date.parse(payload.startedAt ?? '');
    const finished = Date.parse(payload.finishedAt ?? '');
    const took = finished - started;
    if (!Number.isFinite(took) || took < LONG_TASK_MS) return null;
    const name = nameOf(botId);
    const duration = formatDuration(took);
    const failed = payload.status === 'failed';
    return {
      kind: 'long_task',
      tag: `run:${payload.runId}`,
      title: failed ? `${name} could not finish a long task` : `${name} finished a long task`,
      body: failed
        ? truncate(
            payload.error ? `${payload.error} (after ${duration})` : `Stopped after ${duration}.`,
          )
        : `Done after ${duration}. Open to see the result.`,
      target: target(botId, event.chat_id, event.seq, payload.threadRootId),
    };
  }

  function onEvent(event: WsEvent): Notice | null {
    switch (event.type) {
      case 'approval.requested': {
        const botId = event.bot_id;
        if (!botId) return null;
        const approval = event.payload.approval as {
          id: string;
          toolName: string;
          summary?: string | null;
        };
        return once({
          kind: 'approval',
          tag: `approval:${approval.id}`,
          title: `${nameOf(botId)} needs your approval`,
          body: approval.summary || approval.toolName,
          target: target(botId, event.chat_id, event.seq, event.payload.threadRootId),
        });
      }

      case 'message.created': {
        const message = event.payload.message;
        const parts = message.parts as PartLike[];
        if (message.authorType === 'routine') {
          const run = parts.find((p) => p?.type === 'widget' && p.kind === 'routine_run')?.props;
          if (!run || run.outcome === 'completed') return null;
          const botId = typeof run.bot_id === 'string' ? run.bot_id : event.bot_id;
          if (!botId) return null;
          const routine = typeof run.name === 'string' ? run.name : 'A Routine';
          const exception = typeof run.exception === 'string' ? run.exception : '';
          return once({
            kind: 'routine',
            tag: `routine:${message.id}`,
            title: `${routine} ${run.outcome === 'cancelled' ? 'was cancelled' : 'failed'}`,
            body: truncate(exception || `${nameOf(botId)}'s Routine did not finish.`),
            target: target(botId, message.chatId, message.seq, message.threadRootId),
          });
        }
        if (message.authorType === 'system') {
          const failed = parts.find((p) => p?.type === 'event' && p.kind === REPOS_CLONE_FAILED) as
            | (PartLike & { data?: { botId?: unknown; failed?: { fullName?: unknown }[] } })
            | undefined;
          const botId = typeof failed?.data?.botId === 'string' ? failed.data.botId : undefined;
          if (!failed || !botId) return null;
          const names = (failed.data?.failed ?? [])
            .map((f) => f?.fullName)
            .filter((n): n is string => typeof n === 'string');
          return once({
            kind: 'repos_clone_failed',
            tag: `repos_clone_failed:${message.id}`,
            title: 'Repositories could not be cloned',
            body: truncate(
              names.length
                ? `The computer could not clone ${names.join(', ')} again. Open to see why.`
                : 'The computer could not clone some repositories again. Open to see why.',
            ),
            target: target(botId, message.chatId, message.seq, message.threadRootId),
          });
        }
        if (message.authorType !== 'bot' || !message.authorId) return null;
        const meta = {
          messageId: message.id,
          target: target(message.authorId, message.chatId, message.seq, message.threadRootId),
        };
        const asking = askingIn(parts, meta);
        if (asking) return once(asking);
        if (message.status === 'streaming') {
          streaming.set(message.id, {
            chatId: message.chatId,
            botId: message.authorId,
            seq: message.seq,
            threadRootId: idOrUndefined(message.threadRootId),
            parts: [...parts],
          });
          return null;
        }
        return once(mentionIn(parts, meta));
      }

      case 'message.delta': {
        const held = streaming.get(event.payload.messageId);
        const botId = event.bot_id ?? held?.botId;
        if (botId) {
          const asking = askingIn(
            event.payload.deltas.map((d) => d.part as PartLike),
            {
              messageId: event.payload.messageId,
              target: target(
                botId,
                event.chat_id ?? held?.chatId,
                event.seq ?? held?.seq,
                held?.threadRootId,
              ),
            },
          );
          if (asking) return once(asking);
        }
        if (!held) return null;
        for (const delta of event.payload.deltas) {
          if (delta.part) held.parts[delta.partIndex] = delta.part as PartLike;
          else {
            const current = held.parts[delta.partIndex];
            held.parts[delta.partIndex] = {
              ...(current ?? { type: delta.type }),
              text: (current?.text ?? '') + delta.text,
            };
          }
        }
        return null;
      }

      case 'message.completed': {
        const held = streaming.get(event.payload.messageId);
        if (!held) return null;
        streaming.delete(event.payload.messageId);
        if (event.payload.status !== 'complete') return null;
        return once(
          mentionIn(held.parts, {
            messageId: event.payload.messageId,
            target: target(held.botId, held.chatId, held.seq, held.threadRootId),
          }),
        );
      }

      // Removed before it showed anything: nothing in it to notify about.
      case 'message.deleted':
        streaming.delete(event.payload.messageId);
        return null;

      case 'run.status':
        return once(longTask(event));

      default:
        return null;
    }
  }

  return { onEvent };
}
