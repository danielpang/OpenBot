import {
  createNoticeWatcher as createWatcher,
  type NoticeContext as SharedContext,
  type Notice as SharedNotice,
  type NoticeTarget,
  type WsEvent,
} from '@openbots/shared';
import { deepLinkPath, type MessageLink } from './deep-links.js';

// Native notifications (N1) for approvals, questions, mentions of the owner,
// Routine exceptions and finished long tasks. Which events notify is decided
// in @openbots/shared (notices.ts), which the web app's browser notifications
// use too; in the Mac app the shell shows them instead, so they also arrive
// while the window is closed. This module adds the deep link each one opens.

export { ownerHandles } from '@openbots/shared';
export type { NoticeKind } from '@openbots/shared';

export interface Notice extends SharedNotice {
  link: MessageLink;
}

/** The chats `GET /chats` lists; any other chat is a Bot's own transcript. */
export type ChatKind = 'group' | 'bot_to_bot';

export interface NoticeContext extends SharedContext {
  chatKind(chatId: string): ChatKind | undefined;
}

/**
 * The deep link to a notice's message: in a group's chat, in a Bot to Bot
 * chat under the Bot's transcript, or in the Bot's transcript.
 */
export function linkFor(
  target: NoticeTarget,
  chatKind: (chatId: string) => ChatKind | undefined,
): MessageLink {
  const extra = {
    ...(target.seq != null ? { seq: target.seq } : {}),
    ...(target.threadRootId ? { thread: target.threadRootId } : {}),
  };
  const kind = target.chatId ? chatKind(target.chatId) : undefined;
  if (kind === 'group') return { kind: 'chat', chatId: target.chatId!, ...extra };
  if (kind === 'bot_to_bot') {
    return { kind: 'bot', botId: target.botId, chat: target.chatId!, ...extra };
  }
  return { kind: 'bot', botId: target.botId, ...extra };
}

export function createNoticeWatcher(context: () => NoticeContext) {
  const watcher = createWatcher(context);
  return {
    onEvent(event: WsEvent): Notice | null {
      const notice = watcher.onEvent(event);
      return notice && { ...notice, link: linkFor(notice.target, context().chatKind) };
    },
  };
}

/**
 * The owner is already looking at the notice's chat: no notification. A Bot
 * to Bot chat counts only when the view was opened at it (`?chat=`); it is
 * folded away under the transcript otherwise.
 */
export function isWatching(
  notice: Pick<Notice, 'link'>,
  view: { focused: boolean; path: string | null },
): boolean {
  if (!view.focused || view.path == null) return false;
  const [path = '', search = ''] = view.path.split('?');
  const chat = new URLSearchParams(search).get('chat');
  const shown = chat ? `${path}?${new URLSearchParams({ chat }).toString()}` : path;
  return shown === deepLinkPath({ ...notice.link, seq: undefined, thread: undefined });
}
