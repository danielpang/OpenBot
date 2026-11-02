import type { QuickAskBot } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import { createStore } from './store.js';

// The quick-ask window's flow (plan 14.4), without a DOM: the global shortcut
// opens it, Enter sends the text to the chosen Bot's transcript, and Esc or a
// click elsewhere closes it. ./quick-ask-view.tsx renders it.

export const LAST_BOT = 'openbots:quick-ask:bot';

export interface QuickAskState {
  bots: QuickAskBot[];
  botId: string;
  text: string;
  sending: boolean;
  error: string | null;
}

/** Where the last chosen Bot is remembered: localStorage in the window. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type QuickAskFlow = ReturnType<typeof createQuickAskFlow>;

export function createQuickAskFlow(bridge: Pick<AppBridge, 'quickAsk'>, storage: KeyValue) {
  const store = createStore<QuickAskState>({
    bots: [],
    botId: '',
    text: '',
    sending: false,
    error: null,
  });
  const showError = (error: unknown) => store.update({ error: message(error) });

  return {
    store,
    start: () =>
      bridge.quickAsk.bots().then((bots) => {
        const last = storage.getItem(LAST_BOT);
        const botId = last && bots.some((b) => b.id === last) ? last : (bots[0]?.id ?? '');
        store.update({ bots, botId });
        if (bots.length === 0) showError('Make a Bot in OpenBots first.');
      }, showError),
    choose: (botId: string) => store.update({ botId }),
    setText: (text: string) => store.update({ text }),
    send: async () => {
      const { botId, text } = store.get();
      if (!botId || text.trim() === '') return;
      store.update({ error: null, sending: true });
      storage.setItem(LAST_BOT, botId);
      try {
        await bridge.quickAsk.send(botId, text);
        store.update({ text: '' });
      } catch (error) {
        showError(error);
      } finally {
        store.update({ sending: false });
      }
    },
    close: () => bridge.quickAsk.close(),
  };
}
