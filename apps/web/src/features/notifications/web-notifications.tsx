import {
  createNoticeWatcher,
  ownerHandles,
  type Notice,
  type NoticeContext,
  type WsEvent,
} from '@openbots/shared';
import { Button } from '@openbots/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { meQuery } from '../../app/api.js';
import { hasNativeNotifications } from '../../app/platform.js';
import { botsQuery } from '../bots/queries.js';
import { chatsQuery, type Chat } from '../chats/api.js';
import { useRealtime } from '../transcript/realtime.js';

// Browser notifications (T5, P1, N1) for the kinds the Mac app shows:
// approvals, questions, mentions of the owner, Routine exceptions and long
// tasks that finished. Which events notify is decided in @openbots/shared
// (notices.ts), the same watcher the Mac app uses. They listen on the one
// realtime socket and need a one-time permission from Settings > Account.
// Clicking one focuses the window, opens the Bot (or the group the event is
// in, or the Bot to Bot chat under the Bot), scrolls to the message, and for
// a reply in a thread opens the thread. In the Mac app the shell shows native
// ones instead.

/**
 * Where a click goes. A group's or a Bot to Bot chat's seq is that chat's, so
 * an event in a group opens the group, and one in a Bot to Bot chat opens that
 * chat under the Bot's transcript (`?chat=`); anything else opens the Bot. A
 * reply in a thread also opens its thread.
 */
export function noticeTarget(notice: Pick<Notice, 'target'>, chats: readonly Chat[] | undefined) {
  const { botId, chatId, seq, threadRootId } = notice.target;
  const search = {
    ...(seq ? { seq } : {}),
    ...(threadRootId ? { thread: threadRootId } : {}),
  };
  const type = chatId ? chats?.find((c) => c.id === chatId)?.type : undefined;
  if (chatId && type === 'group') {
    return { to: '/groups/$chatId' as const, params: { chatId }, search };
  }
  if (chatId && type === 'bot_to_bot') {
    return { to: '/bots/$botId' as const, params: { botId }, search: { chat: chatId, ...search } };
  }
  return { to: '/bots/$botId' as const, params: { botId }, search };
}

/** The page shows the chat a click would open: its path, and the same Bot to Bot chat or none. */
export function isShowing(
  target: ReturnType<typeof noticeTarget>,
  location: { pathname: string; search: Record<string, unknown> },
): boolean {
  const path =
    target.to === '/groups/$chatId'
      ? `/groups/${target.params.chatId}`
      : `/bots/${target.params.botId}`;
  const chat = 'chat' in target.search ? target.search.chat : undefined;
  return location.pathname === path && location.search.chat === chat;
}

/** What the browser shows: the notice, with the Bot's server-rendered avatar (plan 13) as its icon. */
export function notificationOptions(notice: Pick<Notice, 'body' | 'tag' | 'target'>) {
  const botId = encodeURIComponent(notice.target.botId);
  return { body: notice.body, tag: notice.tag, icon: `/api/v1/bots/${botId}/avatar.png?size=128` };
}

/** The realtime events the watcher reads. */
export const NOTICE_EVENTS = [
  'approval.requested',
  'message.created',
  'message.delta',
  'message.completed',
  // So the watcher lets go of a streamed message that was deleted.
  'message.deleted',
  'run.status',
] as const;

export const notificationsSupported = () =>
  typeof window !== 'undefined' && 'Notification' in window;

/** Shows notifications while the page is hidden, unfocused, or on another screen than the chat. */
export function useWebNotifications() {
  const { client } = useRealtime();
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    if (!client || !notificationsSupported() || hasNativeNotifications()) return;
    const watcher = createNoticeWatcher((): NoticeContext => {
      const me = queryClient.getQueryData(meQuery.queryKey);
      return {
        botName: (id) =>
          queryClient.getQueryData(botsQuery.queryKey)?.items.find((b) => b.id === id)?.name,
        ownerHandles: me ? ownerHandles(me.user) : [],
      };
    });
    const show = (event: WsEvent) => {
      // The watcher sees every event, so a streamed mention is whole when it completes.
      const notice = watcher.onEvent(event);
      if (!notice || Notification.permission !== 'granted') return;
      const target = noticeTarget(notice, queryClient.getQueryData(chatsQuery.queryKey)?.items);
      const watching =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        isShowing(target, router.state.location);
      if (watching) return;
      const notification = new Notification(notice.title, notificationOptions(notice));
      notification.onclick = () => {
        window.focus();
        notification.close();
        // The chat list may not be loaded yet, or may predate a new group.
        void queryClient
          .fetchQuery(chatsQuery)
          .then(
            (chats) => chats.items,
            () => undefined,
          )
          .then((chats) => router.navigate(noticeTarget(notice, chats)));
      };
    };
    const offs = NOTICE_EVENTS.map((type) => client.on(type, (event) => show(event as WsEvent)));
    return () => {
      for (const off of offs) off();
    };
  }, [client, queryClient, router]);
}

/** Mounted inside the realtime provider. */
export function WebNotifications() {
  useWebNotifications();
  return null;
}

/** Settings > Account: the one-time permission prompt. */
export function NotificationSettings() {
  if (hasNativeNotifications()) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Alerts you when {NOTIFIED}. Turn them off in macOS System Settings &gt; Notifications.
        </p>
      </section>
    );
  }
  return <BrowserNotificationSettings />;
}

const NOTIFIED = 'a Bot needs you, finishes a long task, or a Routine fails';

function BrowserNotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    notificationsSupported() ? Notification.permission : 'unsupported',
  );
  const text = {
    unsupported: 'This browser does not support notifications.',
    default: `Get a notification when ${NOTIFIED}.`,
    granted: `On. You're notified when ${NOTIFIED}.`,
    denied: 'Blocked. Allow notifications for this site in your browser.',
  }[permission];
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Notifications</h2>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{text}</p>
        {permission === 'default' && (
          <Button
            variant="outline"
            onClick={() => void Notification.requestPermission().then(setPermission)}
          >
            Turn on
          </Button>
        )}
      </div>
    </section>
  );
}
