import type { WsClient, WsStatus } from '@openbots/api-client';
import type { WsEventOf } from '@openbots/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createRealtime } from '../../app/api.js';
import { applyBotState, botsQuery } from '../bots/queries.js';
import { chatsQuery, isNewChat } from '../chats/api.js';
import type { BotState } from './api.js';

// The one realtime connection for the signed-in shell (plan 14.2). It
// subscribes to every Bot so the roster's avatars follow `bot.state` (I2, I3),
// keeps a live Bot state store the transcript reads, and routes reconnect
// resyncs to whichever transcript has the chat open. A Bot's message in a
// chat the lists do not know yet (a first `message_bot` to another Bot, or a
// group made in another tab) refreshes the chat list (C6).

type ResyncListener = (since: number) => void;

export interface Realtime {
  client: WsClient | null;
  /** Called with the last seq held after each reconnect while `chatId` is subscribed. */
  onResync(chatId: string, listener: ResyncListener): () => void;
}

export const RealtimeContext = createContext<Realtime>({ client: null, onResync: () => () => {} });

/** The connection's state, and whether it was ever open (then a lost one is reconnecting). */
export interface RealtimeStatus {
  status: WsStatus;
  everOpen: boolean;
}

export const RealtimeStatusContext = createContext<RealtimeStatus>({
  status: 'connecting',
  everOpen: false,
});

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [realtime, setRealtime] = useState<Realtime>({ client: null, onResync: () => () => {} });
  const [status, setStatus] = useState<RealtimeStatus>({ status: 'connecting', everOpen: false });
  const bots = useQuery(botsQuery);

  useEffect(() => {
    const listeners = new Map<string, Set<ResyncListener>>();
    const client = createRealtime({
      onResync: (chatId, since) => {
        for (const listener of listeners.get(chatId) ?? []) listener(since);
      },
      onStatus: (next) =>
        setStatus((current) => ({ status: next, everOpen: current.everOpen || next === 'open' })),
    });
    const off = client.on('bot.state', (event) => {
      recordBotState(event);
      queryClient.setQueryData(botsQuery.queryKey, (current) =>
        current ? { ...current, items: applyBotState(current.items, event) } : current,
      );
    });
    const offChats = client.on('message.created', (event) => {
      const chats = queryClient.getQueryData(chatsQuery.queryKey);
      const bots = queryClient.getQueryData(botsQuery.queryKey);
      if (event.chat_id && isNewChat(event.chat_id, chats?.items, bots?.items)) {
        void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
      }
    });
    setRealtime({
      client,
      onResync(chatId, listener) {
        let set = listeners.get(chatId);
        if (!set) listeners.set(chatId, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
      },
    });
    return () => {
      off();
      offChats();
      client.close();
    };
  }, [queryClient]);

  const botIds = bots.data?.items.map((b) => b.id).join(',') ?? '';
  useEffect(() => {
    if (!realtime.client || !botIds) return;
    const ids = botIds.split(',');
    realtime.client.subscribe({ bots: ids });
    return () => realtime.client?.unsubscribe({ bots: ids });
  }, [realtime.client, botIds]);

  return (
    <RealtimeContext value={realtime}>
      <RealtimeStatusContext value={status}>{children}</RealtimeStatusContext>
    </RealtimeContext>
  );
}

export function useRealtime(): Realtime {
  return useContext(RealtimeContext);
}

/** The shared connection's state, for the Mac app's connection indicator. */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeStatusContext);
}

// Live Bot state: the latest `bot.state` per Bot, over whatever REST returned.

const liveStates = new Map<string, BotState>();
const stateListeners = new Set<() => void>();

function subscribeStates(listener: () => void) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Records a `bot.state` event in the live store. */
function recordBotState(event: WsEventOf<'bot.state'>) {
  const { botId, state, currentAction, runId, currentTool = null } = event.payload;
  const updatedAt = new Date(event.ts).toISOString();
  liveStates.set(botId, { botId, state, currentAction, runId, currentTool, updatedAt });
  for (const listener of stateListeners) listener();
}

/** The Bot's current state: the latest event, or `fallback` (from REST) before any arrives. */
export function useBotState(botId: string, fallback: BotState | undefined): BotState | undefined {
  const live = useSyncExternalStore(
    subscribeStates,
    () => liveStates.get(botId),
    () => undefined,
  );
  return live ?? fallback;
}
