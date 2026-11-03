import type { PairCode, PairRelayView } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import { errorParts } from '../stack/error-parts.js';
import { createStore } from './store.js';

// The pairing window's flow (docs/RELAY_PROTOCOL.md 6), without a DOM. Pair
// your phone shows a code for the phone to scan straight away, through This
// Mac's relay: the project's shared relay unless the owner set their own.
// The Relay view (`?view=relay`, the app menu's "Relay…", or "Change relay"
// under the code) changes it. That restarts the stack and signs out every
// paired phone, so it warns first and asks once more. Another connection's
// relay is its server's: the view only shows it. ./pair-view.tsx renders it.

export type PairView = 'pair' | 'relay';

export interface PairState {
  step: 'loading' | 'code' | 'paired' | 'relay' | 'confirm' | 'applying' | 'saved';
  relay: PairRelayView | null;
  /** The relay address in the Relay view, as typed. */
  url: string;
  code: PairCode | null;
  /** A code is on its way. */
  making: boolean;
  /** The phone's name once it paired. */
  paired: string | null;
  error: string | null;
}

export type PairFlow = ReturnType<typeof createPairFlow>;

/** The Relay view's address differs from the relay in use, so Save would change it. */
export function relayChanged(state: Pick<PairState, 'relay' | 'url'>): boolean {
  const url = state.url.trim();
  return url !== '' && url !== (state.relay?.current ?? state.relay?.sharedUrl);
}

export function createPairFlow(bridge: Pick<AppBridge, 'pair'>, view: PairView = 'pair') {
  const store = createStore<PairState>({
    step: 'loading',
    relay: null,
    url: '',
    code: null,
    making: false,
    paired: null,
    error: null,
  });
  const showError = (error: unknown) => store.update({ error: errorParts(error).message });

  async function makeCode() {
    store.update({ step: 'code', making: true, error: null });
    try {
      store.update({ code: await bridge.pair.code() });
    } catch (error) {
      store.update({ code: null });
      showError(error);
    } finally {
      store.update({ making: false });
    }
  }

  function openRelay() {
    const { relay } = store.get();
    store.update({
      step: 'relay',
      code: null,
      error: null,
      url: relay?.current ?? relay?.sharedUrl ?? '',
    });
  }

  const offPaired = bridge.pair.onPaired((name) => {
    if (store.get().step === 'code') store.update({ step: 'paired', paired: name });
  });

  return {
    store,
    async start() {
      try {
        store.update({ relay: await bridge.pair.relay() });
      } catch (error) {
        store.update({ step: view === 'relay' ? 'relay' : 'code' });
        showError(error);
        return;
      }
      if (view === 'relay') openRelay();
      else await makeCode();
    },
    setUrl: (url: string) => store.update({ url, error: null }),
    /** Back to the shared relay in the address box. */
    useShared() {
      const { relay } = store.get();
      if (relay) store.update({ url: relay.sharedUrl, error: null });
    },
    /** The Relay view, from under the code (This Mac only). */
    changeRelay() {
      if (store.get().relay?.local) openRelay();
    },
    /** Save in the Relay view: asks once more, since it signs out the paired phones. */
    save() {
      const state = store.get();
      if (state.url.trim() === '') {
        store.update({ error: 'Enter the relay’s address, like wss://relay.example.com.' });
        return;
      }
      if (relayChanged(state)) store.update({ step: 'confirm', error: null });
    },
    /** Back from the confirmation, with the address as typed. */
    back: () => store.update({ step: 'relay', error: null }),
    async apply() {
      store.update({ step: 'applying', error: null });
      try {
        store.update({ relay: await bridge.pair.setRelay(store.get().url.trim()), step: 'saved' });
      } catch (error) {
        store.update({ step: 'relay' });
        showError(error);
      }
    },
    newCode: makeCode,
    close() {
      offPaired();
      bridge.pair.close();
    },
  };
}
