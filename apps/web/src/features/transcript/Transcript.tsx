import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { meQuery } from '../../app/api.js';
import { useBot } from '../bots/bot-view.js';
import { botChatQuery } from '../bots/queries.js';
import { BotChats } from '../chats/bot-chats.js';
import type { Message } from './api.js';
import { ChatTimeline } from './chat-timeline.js';
import { Composer } from './composer.js';
import { useBotPanel, useFocusThread } from './panel.js';
import { useBotState } from './realtime.js';
import { StopControl } from './run-controls.js';
import { useTranscript } from './use-transcript.js';

// A Bot's transcript (C1, C2, principle 6): the virtualized timeline over the
// chat's messages, newest at the bottom, older pages loaded by scrolling up,
// live updates from the realtime connection, the Bot's chats with other Bots
// (C6) folded under it, and the composer. The Bot view (1.5) renders it under
// the Chat tab.

export function Transcript({
  botId,
  focusSeq: seq,
  focusThread: thread,
  focusChat,
}: {
  botId: string;
  focusSeq?: number;
  /** The root of the thread `focusSeq` is in, for a reply in a thread. */
  focusThread?: string;
  /** One of the Bot's chats with another Bot: `focusSeq` is a message there, not here. */
  focusChat?: string;
}) {
  const focusSeq = focusChat ? undefined : seq;
  const focusThread = focusChat ? undefined : thread;
  const { bot } = useBot(botId);
  const chat = useQuery(botChatQuery(botId));
  const me = useQuery(meQuery);
  const state = useBotState(botId, bot?.state);
  const showPanel = useBotPanel(botId);
  const chatId = chat.data?.id;
  const transcript = useTranscript(chatId);
  const botFor = useCallback(() => bot, [bot]);
  const stateFor = useCallback(
    (m: Message) => (m.runId && m.runId === state?.runId ? state : undefined),
    [state],
  );
  const onOpenThread = useCallback(
    (m: Message) => chatId && showPanel({ kind: 'thread', chatId, rootId: m.id }),
    [chatId, showPanel],
  );
  useFocusThread(showPanel, chatId, focusThread, focusSeq);

  const failure = chat.error ?? transcript.error;
  if (failure) {
    return <p className="p-8 text-sm text-destructive">{failure.message}</p>;
  }
  if (!bot || !chat.data) {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatTimeline
        label={`Conversation with ${bot.name}`}
        start={`The start of your conversation with ${bot.name}.`}
        transcript={transcript}
        ownerId={me.data?.user.id}
        botFor={botFor}
        stateFor={stateFor}
        focusSeq={focusSeq}
        focusThread={focusThread}
        onOpenActivity={(runId) => showPanel({ kind: 'activity', runId })}
        onOpenArtifact={(artifactId, version) =>
          showPanel({ kind: 'artifact', artifactId, version })
        }
        onOpenThread={onOpenThread}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4">
        <BotChats botId={botId} focus={focusChat ? { chatId: focusChat, seq } : undefined} />
        <Composer
          chatId={chat.data.id}
          mentionable={[bot]}
          placeholder={`Message ${bot.name}`}
          onSent={transcript.addMessage}
          extra={<StopControl state={state} />}
        />
      </div>
    </div>
  );
}
