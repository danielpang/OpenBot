import { cn } from '@openbots/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { capabilitiesQuery } from '../../app/api.js';
import { botsQuery, type Bot } from '../bots/queries.js';
import { SignInTakeover } from '../computer/takeover.js';
import { widgetAction, type BotState, type Message, type Reaction } from './api.js';
import { MessageView } from './message-view.js';
import { messagesOf } from './timeline.js';
import type { TranscriptData } from './use-transcript.js';

// The virtualized timeline of one chat (C2): a Bot's transcript or a group
// (C4). Newest at the bottom, older pages loaded by scrolling up, stick to
// the bottom while the owner is there. Only top-level messages are listed;
// thread replies (C7) show as a count that opens the thread.

export interface ChatTimelineProps {
  /** The log's accessible name. */
  label: string;
  /** The line above the first message. */
  start: string;
  transcript: TranscriptData;
  ownerId: string | undefined;
  /** The Bot whose avatar a message gets: the transcript's Bot, or a group's author. */
  botFor(message: Message): Bot | undefined;
  /** The Bot's live state while it writes this message. */
  stateFor(message: Message): BotState | undefined;
  /** Prefix every Bot message with its name, as a group does. */
  named?: boolean;
  /** A message to scroll to and mark, e.g. from a notification. */
  focusSeq?: number;
  /**
   * The thread `focusSeq` is a reply in: its root is what the timeline scrolls
   * to and marks, since replies show in the thread panel.
   */
  focusThread?: string;
  onOpenActivity(runId: string): void;
  onOpenArtifact(artifactId: string, version?: number): void;
  onOpenThread(message: Message): void;
}

const STICK_PX = 80;
const LOAD_OLDER_PX = 240;

export function ChatTimeline({
  label,
  start,
  transcript,
  ownerId,
  botFor,
  stateFor,
  named,
  focusSeq,
  focusThread,
  onOpenActivity,
  onOpenArtifact,
  onOpenThread,
}: ChatTimelineProps) {
  const router = useRouter();
  const { timeline, loading, hasMore, loadingOlder, loadOlder, setWidgetState } = transcript;
  const others = useQuery(botsQuery);
  const { messages, replies } = useMemo(() => topLevel(messagesOf(timeline)), [timeline]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 72,
    getItemKey: (i) => messages[i]!.id,
    overscan: 6,
    initialRect: { width: 720, height: 800 },
  });

  // Keep the newest message in view while the owner is at the bottom, and
  // keep the view still when an older page is prepended above it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const older = useCallback(async () => {
    const el = scroller.current;
    if (!el || !hasMore || loadingOlder) return;
    anchor.current = el.scrollHeight - el.scrollTop;
    await loadOlder();
  }, [hasMore, loadingOlder, loadOlder]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (el.scrollTop < LOAD_OLDER_PX) void older();
  };

  const onWidgetAction = useCallback(
    async (message: Message, partIndex: number, action: unknown) => {
      const widget = await widgetAction(message.id, partIndex, action as Record<string, unknown>);
      setWidgetState(widget);
      return widget.state;
    },
    [setWidgetState],
  );

  // Scroll to `focusSeq` (or the root of `focusThread`) once it is loaded,
  // loading older pages until it is. A thread's root is older than its
  // replies, so its seq is not known: pages load until it shows up.
  const focusKey = focusThread ?? focusSeq;
  const [focused, setFocused] = useState<{ key: string | number; id: string } | undefined>();
  useEffect(() => {
    if (focusKey === undefined || focused?.key === focusKey || loading) return;
    const index = messages.findIndex((m) =>
      focusThread !== undefined ? m.id === focusThread : m.seq === focusSeq,
    );
    if (index >= 0) {
      stick.current = false;
      virtualizer.scrollToIndex(index, { align: 'center' });
      setFocused({ key: focusKey, id: messages[index]!.id });
    } else if (
      hasMore &&
      !loadingOlder &&
      (focusThread !== undefined || (messages[0]?.seq ?? 0) > (focusSeq ?? 0))
    ) {
      void older();
    }
  }, [
    focusKey,
    focusThread,
    focusSeq,
    focused,
    loading,
    messages,
    hasMore,
    loadingOlder,
    older,
    virtualizer,
  ]);

  // A sign-in request's Take over (K8): that Bot's screen, on the sign-in page.
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const [signIn, setSignIn] = useState<{ botId: string; url?: string } | null>(null);
  const onTakeover = useCallback(
    (botId: string, url?: string) => setSignIn({ botId, ...(url ? { url } : {}) }),
    [],
  );

  const onNavigate = useCallback((href: string) => void router.navigate({ href }), [router]);
  const { authorName, reactorName } = useAuthorNames(others.data?.items);
  const { react } = transcript;
  const onReact = useCallback(
    (message: Message, emoji: string, on: boolean) => {
      // A failed reaction leaves the chips as they were; nothing to retry.
      react(message.id, emoji, on).catch(() => {});
    },
    [react],
  );

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-slot="chat-scroll"
      className="relative min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-label={label}
      aria-busy={loading}
    >
      <div className="mx-auto w-full max-w-3xl px-4 pt-6">
        <div className="pb-2 text-center text-xs text-muted-foreground">
          {loading ? (
            'Loading…'
          ) : loadingOlder ? (
            'Loading earlier messages…'
          ) : hasMore ? (
            <button type="button" className="hover:underline" onClick={() => void older()}>
              Load earlier messages
            </button>
          ) : (
            start
          )}
        </div>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index]!;
            const state = stateFor(message);
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={cn(
                  'absolute inset-x-0 top-0',
                  focused !== undefined &&
                    message.id === focused.id &&
                    'rounded-lg bg-accent/40 transition-colors',
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <MessageView
                  message={message}
                  bot={botFor(message)}
                  ownerId={ownerId}
                  named={named}
                  liveState={state?.state}
                  currentAction={state?.currentAction ?? null}
                  authorName={authorName}
                  onWidgetAction={onWidgetAction}
                  {...(capabilities?.computer ? { onTakeover } : {})}
                  onOpenActivity={onOpenActivity}
                  onOpenArtifact={onOpenArtifact}
                  onNavigate={onNavigate}
                  onOpenThread={onOpenThread}
                  replies={replies.get(message.id)}
                  reactions={transcript.reactions[message.id]}
                  onReact={onReact}
                  reactorName={reactorName}
                />
              </div>
            );
          })}
        </div>
      </div>
      {signIn && (
        <SignInTakeover botId={signIn.botId} url={signIn.url} onClose={() => setSignIn(null)} />
      )}
    </div>
  );
}

/**
 * Top-level messages, and how many thread replies each has: the `replyCount`
 * its read carried plus the loaded replies newer than the last one it counted.
 */
export function topLevel(all: readonly Message[]): {
  messages: Message[];
  replies: Map<string, number>;
} {
  const messages = all.filter((m) => !m.threadRootId);
  const counted = new Map(messages.map((m) => [m.id, m.lastReplySeq ?? -1]));
  const replies = new Map(messages.map((m) => [m.id, m.replyCount ?? 0]));
  for (const message of all) {
    const rootId = message.threadRootId;
    if (rootId && message.seq > (counted.get(rootId) ?? -1)) {
      replies.set(rootId, (replies.get(rootId) ?? 0) + 1);
    }
  }
  return { messages, replies };
}

/** Other Bots' handles for message prefixes, and who reacted for the chips. */
export function useAuthorNames(bots: readonly Bot[] | undefined) {
  return useMemo(() => {
    const names = new Map(bots?.map((b) => [b.id, `@${b.handle}`]));
    return {
      authorName: (m: Message) =>
        m.authorType === 'bot' && m.authorId ? names.get(m.authorId) : undefined,
      reactorName: (r: Reaction) =>
        r.reactorType === 'user' ? 'You' : (names.get(r.reactorId) ?? 'A Bot'),
    };
  }, [bots]);
}
