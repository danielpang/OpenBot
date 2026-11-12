import { Avatar } from '@openbots/avatars/react';
import { showsThinking } from '@openbots/shared';
import { cn } from '@openbots/ui';
import { EventRow, FileCard, Widget } from '@openbots/widgets/react';
import { memo, type ReactNode } from 'react';
import { ArtifactPart } from '../artifacts/card.js';
import { AcceptEdits } from '../bots/accept-edits.js';
import { codingSessionHost } from '../coders/session-host.js';
import type { Bot } from '../bots/queries.js';
import { useToolConnector } from '../tools/hooks.js';
import { ConnectorIcon } from '../tools/icons.js';
import type { BotState, Message, Reaction } from './api.js';
import { fileUrl } from './api.js';
import { isEventOnly, toBlocks, type ActivityItem, type Block } from './blocks.js';
import { Markdown } from './markdown.js';
import { reactionChips } from './reactions.js';
import { ThinkingLine } from './thinking-line.js';
import { MessageMore, messageText } from './message-more.js';
import { ReactButton, ReactionChips } from './reactions-view.js';

// One transcript entry (C2, principle 6, W3). The owner's messages are
// bubbles on the right; the Bot's are prose beside its avatar, with tool
// activity folded into compact lines and widgets inline; event-only messages
// are compact system rows. An author prefix appears only for someone other
// than the Bot or the owner (another Bot, a webhook, a Routine), and in a
// group (`named`) on every Bot's message. Reactions (C8) sit under the
// message; a Bot's result can be answered in a thread (C7).

export interface MessageViewProps {
  message: Message;
  /** The Bot whose messages get its avatar: the transcript's, or in a group the author. */
  bot?: Pick<Bot, 'id' | 'name' | 'avatar'>;
  ownerId: string | undefined;
  /** Prefix the Bot's messages with its name too, as a group does. */
  named?: boolean;
  /** The Bot's live state, shown on the avatar of the message it is writing. */
  liveState?: BotState['state'];
  /** The Bot's current action (I3), shown on hover over that avatar. */
  currentAction?: string | null;
  /** Other authors by id, for the prefix. */
  authorName?: (message: Message) => string | undefined;
  onWidgetAction?: (message: Message, partIndex: number, action: unknown) => Promise<unknown>;
  /** Opens Takeover on a Bot's screen for a sign-in request (K8); absent without a computer. */
  onTakeover?: (botId: string, url?: string) => void;
  onOpenActivity?: (runId: string) => void;
  /** Opens an Artifact card in the viewer. */
  onOpenArtifact?: (artifactId: string, version?: number) => void;
  /** Opens an app path from an event row's link without a page load. */
  onNavigate?: (href: string) => void;
  /** Opens the thread on this message; absent inside a thread. */
  onOpenThread?: (message: Message) => void;
  /** Thread replies seen so far. */
  replies?: number;
  reactions?: readonly Reaction[];
  /** Adds (`on`) or takes back the owner's reaction. */
  onReact?: (message: Message, emoji: string, on: boolean) => void;
  /** Who reacted, for the chip's hover text. */
  reactorName?: (reaction: Reaction) => string;
}

export const MessageView = memo(function MessageView({
  message,
  bot,
  ownerId,
  named,
  liveState,
  currentAction,
  authorName,
  onWidgetAction,
  onTakeover,
  onOpenActivity,
  onOpenArtifact,
  onNavigate,
  onOpenThread,
  replies = 0,
  reactions,
  onReact,
  reactorName = (r) => (r.reactorType === 'user' ? 'You' : 'A Bot'),
}: MessageViewProps) {
  if (isEventOnly(message)) {
    return (
      <div className="py-1">
        {toBlocks(message).map((block) => (
          <BlockView key={block.index} block={block} message={message} onNavigate={onNavigate} />
        ))}
      </div>
    );
  }

  const byOwner = message.authorType === 'user' && message.authorId === ownerId;
  const byBot = message.authorType === 'bot' && !!bot && message.authorId === bot.id;
  const prefix =
    byOwner || (byBot && !named)
      ? undefined
      : byBot
        ? bot.name
        : (authorName?.(message) ?? AUTHOR[message.authorType]);
  const streaming = message.status === 'streaming';
  const blocks = toBlocks(message);
  const reply = onOpenThread && !message.threadRootId ? () => onOpenThread(message) : undefined;
  const content = blocks.map((block) => (
    <BlockView
      key={block.index}
      block={block}
      message={message}
      onWidgetAction={onWidgetAction}
      onTakeover={onTakeover}
      onOpenActivity={onOpenActivity}
      onOpenArtifact={onOpenArtifact}
      onNavigate={onNavigate}
      onReply={reply}
    />
  ));
  const chips = reactionChips(reactions);
  const toggle = onReact ? (emoji: string, on: boolean) => onReact(message, emoji, on) : undefined;
  const after = (chips.length > 0 || (reply && replies > 0)) && (
    <div className={cn('flex flex-wrap items-center gap-2', byOwner && 'justify-end')}>
      <ReactionChips chips={chips} reactorName={reactorName} onToggle={toggle} />
      {reply && replies > 0 && (
        <button type="button" className="text-xs font-medium hover:underline" onClick={reply}>
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </button>
      )}
    </div>
  );

  if (byOwner) {
    return (
      <div className="flex flex-col items-end gap-1 py-1.5" data-author="owner">
        <div className="flex max-w-[80%] flex-col gap-2 rounded-2xl bg-muted px-3.5 py-2">
          {content}
        </div>
        {after}
      </div>
    );
  }

  const activity = byBot && message.runId && onOpenActivity && !streaming;
  // An approval offers its own "Reply in thread" (2.4).
  const replyHere =
    reply &&
    byBot &&
    !streaming &&
    !message.parts.some((p) => p.type === 'widget' && p.kind === 'approval');
  const copyText = streaming ? '' : messageText(message.parts);
  const more = Boolean(activity || replyHere || copyText);
  return (
    <div className="group flex gap-3 py-1.5" data-author={byBot ? 'bot' : message.authorType}>
      <div
        className="w-6 shrink-0 pt-0.5"
        title={streaming ? (currentAction ?? undefined) : undefined}
      >
        {byBot && (
          <Avatar
            params={bot.avatar}
            state={streaming && liveState ? liveState : 'idle'}
            size={24}
            fileUrl={fileUrl}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {prefix && <div className="text-xs font-medium text-muted-foreground">{prefix}</div>}
        {content}
        {showsThinking(message) && <ThinkingLine seed={message.id} who={bot?.name ?? 'The Bot'} />}
        {message.status === 'failed' && (
          <p className="text-xs text-muted-foreground">This reply did not finish.</p>
        )}
        {after}
        {!streaming && (toggle || more) && (
          <div className="-ml-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            {toggle && <ReactButton onPick={(emoji) => toggle(emoji, true)} />}
            <MessageMore
              onReply={replyHere ? reply : undefined}
              onActivity={activity ? () => onOpenActivity(message.runId!) : undefined}
              copyText={copyText || undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
});

const AUTHOR: Record<Message['authorType'], string | undefined> = {
  user: 'Member',
  bot: 'Bot',
  system: undefined,
  webhook: 'Webhook',
  routine: 'Routine',
};

function BlockView({
  block,
  message,
  onWidgetAction,
  onTakeover,
  onOpenActivity,
  onOpenArtifact,
  onNavigate,
  onReply,
}: {
  block: Block;
  message: Message;
  onWidgetAction?: MessageViewProps['onWidgetAction'];
  onTakeover?: MessageViewProps['onTakeover'];
  onOpenActivity?: MessageViewProps['onOpenActivity'];
  onOpenArtifact?: MessageViewProps['onOpenArtifact'];
  onNavigate?: MessageViewProps['onNavigate'];
  onReply?: () => void;
}): ReactNode {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'reasoning':
      return (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {message.status === 'streaming' && block.index === message.parts.length - 1
              ? 'Thinking…'
              : 'Thought'}
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{block.text}</p>
        </details>
      );
    case 'activity':
      return <ActivityLine items={block.items} />;
    case 'image':
      return (
        <a href={fileUrl(block.part.file_id)} target="_blank" rel="noreferrer" className="block">
          <img
            src={fileUrl(block.part.file_id)}
            alt={block.part.name}
            loading="lazy"
            className="max-h-80 max-w-full rounded-lg border object-contain"
          />
        </a>
      );
    case 'file':
      return <FileCard file={block.part} fileUrl={fileUrl} />;
    case 'widget':
      return (
        <>
          <Widget
            kind={block.part.kind}
            props={block.part.props}
            state={block.part.state}
            fileUrl={fileUrl}
            onReply={onReply}
            onOpenActivity={onOpenActivity}
            onOpenArtifact={onOpenArtifact}
            onNavigate={onNavigate}
            {...(onTakeover ? { onTakeover } : {})}
            {...(block.part.kind === 'coding_session'
              ? {
                  renderMarkdown,
                  ...(onNavigate ? { coder: codingSessionHost(onNavigate) } : {}),
                }
              : {})}
            onAction={
              onWidgetAction ? (action) => onWidgetAction(message, block.index, action) : undefined
            }
          />
          {block.part.kind === 'approval' &&
            message.authorType === 'bot' &&
            message.authorId &&
            (block.part.state as { status?: string } | undefined)?.status === 'pending' && (
              <AcceptEdits botId={message.authorId} />
            )}
        </>
      );
    case 'event': {
      const data = block.part.data as { fix?: unknown; link?: unknown } | undefined;
      return (
        <EventRow
          kind={block.part.kind}
          text={block.part.text}
          fix={typeof data?.fix === 'string' ? data.fix : undefined}
          link={typeof data?.link === 'string' ? data.link : undefined}
          onLink={onNavigate}
        />
      );
    }
    case 'artifact':
      return <ArtifactPart part={block.part} onOpen={onOpenArtifact} />;
    case 'skill_ref':
      return (
        <span className="w-fit rounded bg-accent px-1.5 py-0.5 text-xs">
          /{block.part.name ?? 'skill'}
        </span>
      );
  }
}

const renderMarkdown = (text: string) => <Markdown text={text} />;

/** The connector's mark before a connector tool's line; nothing for other tools. */
function ToolConnectorIcon({ tool }: { tool: string }) {
  const connector = useToolConnector(tool);
  return connector ? <ConnectorIcon size="sm" icon={connector.icon} name={connector.name} /> : null;
}

/** Tool calls as one line: the latest step label, the rest on expand. */
export function ActivityLine({ items }: { items: ActivityItem[] }) {
  const last = items.at(-1);
  if (!last) return null;
  const running = !last.done;
  const summary = (
    <span className={cn('min-w-0 truncate', last.error && 'text-destructive')}>
      {last.label}
      {running && '…'}
    </span>
  );
  if (items.length === 1) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ToolConnectorIcon tool={last.tool} />
        {summary}
      </div>
    );
  }
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-1.5">
        <ToolConnectorIcon tool={last.tool} />
        {summary}
        <span className="shrink-0">· {items.length} steps</span>
      </summary>
      <ol className="mt-1 flex flex-col gap-0.5 border-l pl-3">
        {items.map((item) => (
          <li key={item.id} className={cn(item.error && 'text-destructive')}>
            {item.label}
          </li>
        ))}
      </ol>
    </details>
  );
}
