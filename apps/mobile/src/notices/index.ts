import {
  createNoticeWatcher,
  type Notice,
  type NoticeContext,
  type NoticeKind,
  type WsEvent,
} from '@openbots/shared';

export interface NoticeState {
  items: readonly Notice[];
  badge: number;
}

/** Shared notice policy with foreground suppression and an observable local Inbox badge. */
export class MobileNotices {
  private snapshot: NoticeState = { items: [], badge: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly watcher: ReturnType<typeof createNoticeWatcher>;
  private foregroundChat: string | null = null;
  private enabled: Partial<Record<NoticeKind, boolean>> = {};

  constructor(
    context: () => NoticeContext,
    private readonly onBanner?: (notice: Notice) => void,
  ) {
    this.watcher = createNoticeWatcher(context);
  }

  getSnapshot = (): NoticeState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setForegroundChat(chatId: string | null): void {
    this.foregroundChat = chatId;
  }
  setPreferences(enabled: Partial<Record<NoticeKind, boolean>>): void {
    this.enabled = enabled;
  }

  private publish(items: readonly Notice[]): void {
    this.snapshot = { items, badge: items.length };
    for (const listener of this.listeners) listener();
  }

  onEvent(event: WsEvent): Notice | null {
    if (event.type === 'approval.resolved') {
      this.dismiss(`approval:${event.payload.approval.id}`);
    }
    const notice = this.watcher.onEvent(event);
    if (!notice || this.enabled[notice.kind] === false) return null;
    this.publish([notice, ...this.snapshot.items].slice(0, 100));
    if (!notice.target.chatId || notice.target.chatId !== this.foregroundChat)
      this.onBanner?.(notice);
    return notice;
  }

  dismiss(tag: string): void {
    this.publish(this.snapshot.items.filter((item) => item.tag !== tag));
  }
  markChatRead(chatId: string): void {
    this.publish(this.snapshot.items.filter((item) => item.target.chatId !== chatId));
  }
  clear(): void {
    this.publish([]);
  }
}
