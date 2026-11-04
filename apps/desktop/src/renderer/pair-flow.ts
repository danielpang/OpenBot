import type { PairCode, PairRelayStatus, PairRelayView } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import { errorParts } from '../stack/error-parts.js';
import { createStore } from './store.js';

// The pairing window's flow (docs/RELAY_PROTOCOL.md 6), without a DOM. Pair
// your phone shows a code for the phone to scan straight away, through This
// Mac's relay: the project's shared relay unless the owner set their own.
//
// The code shows once the server's link to that relay is up (`GET
// /api/v1/relay`, asked every second while a code is up). A phone that scans
// a code while its server cannot reach the relay fails with a bare socket
// error and nothing to go on, so the window holds the code back and says
// what is wrong instead, with the server's own reason when it has one (a
// relay name that does not resolve, a refused connection), and shows the code
// as soon as the link comes up.
//
// The Relay view (`?view=relay`, the app menu's "Relay…", or "Change relay"
// under the code) changes the relay. That restarts the stack and signs out
// every paired phone, so it warns first and asks once more. Another
// connection's relay is its server's: the view only shows it. ./pair-view.tsx
// renders it.

export type PairView = 'pair' | 'relay';

/** The server's link to its relay as the window sees it; `none` when the server has no relay. */
export type PairLink = 'none' | 'waiting' | 'linked' | 'failed';

/** How often the window asks for the link's status while a code is up. */
export const LINK_POLL_MS = 1_000;
/** How long the server gets to link before the window says it has not, when it gives no reason. */
export const LINK_WAIT_MS = 15_000;

export interface PairState {
  step: 'loading' | 'code' | 'paired' | 'relay' | 'confirm' | 'applying' | 'saved';
  relay: PairRelayView | null;
  /** The relay address in the Relay view, as typed. */
  url: string;
  code: PairCode | null;
  /** A code is on its way. */
  making: boolean;
  /** The server's link to its relay; the code shows on `linked` (or `none`) only. */
  link: PairLink;
  /** Why the link failed, for the window; null until it did. */
  linkError: string | null;
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

/** The relay's host for a message, or the address as given when it does not parse. */
function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the window says when the server has not linked: the server's reason when it gave one. */
export function linkFailure(relayUrl: string, status: PairRelayStatus): string {
  const host = relayHost(relayUrl);
  return status.error
    ? `Your server could not connect to the relay at ${host}: ${status.error}.`
    : `Your server has not connected to the relay at ${host}.`;
}

export function createPairFlow(bridge: Pick<AppBridge, 'pair'>, view: PairView = 'pair') {
  const store = createStore<PairState>({
    step: 'loading',
    relay: null,
    url: '',
    code: null,
    making: false,
    link: 'none',
    linkError: null,
    paired: null,
    error: null,
  });
  const showError = (error: unknown) => store.update({ error: errorParts(error).message });

  let poll: ReturnType<typeof setTimeout> | undefined;
  /** Which watch is current; a new code, another view or the close ends the older one. */
  let watching = 0;

  function stopWatching() {
    clearTimeout(poll);
    poll = undefined;
    watching += 1;
  }

  /**
   * Asks for the server's relay link while the code shows. The code is held
   * back until `linked`; a failure the server reports shows at once, and a
   * link still not up after LINK_WAIT_MS shows as not connected. Both go on
   * asking, so a server that links later gets its code shown.
   */
  function watchLink(relayUrl: string) {
    stopWatching();
    const id = watching;
    let waitedMs = 0;
    const tick = async () => {
      let status: PairRelayStatus = { status: 'off', error: null };
      try {
        status = await bridge.pair.relayStatus();
      } catch {
        // The server could not be asked: the wait goes on, and tells in time.
      }
      if (id !== watching) return;
      if (status.status === 'linked') {
        store.update({ link: 'linked', linkError: null });
      } else if (status.error !== null || waitedMs >= LINK_WAIT_MS) {
        store.update({ link: 'failed', linkError: linkFailure(relayUrl, status) });
      }
      waitedMs += LINK_POLL_MS;
      poll = setTimeout(() => void tick(), LINK_POLL_MS);
    };
    void tick();
  }

  async function makeCode() {
    stopWatching();
    store.update({ step: 'code', making: true, error: null, link: 'none', linkError: null });
    try {
      const code = await bridge.pair.code();
      const relayUrl = store.get().relay?.current ?? null;
      store.update({ code, link: relayUrl === null ? 'none' : 'waiting' });
      if (relayUrl !== null) watchLink(relayUrl);
    } catch (error) {
      store.update({ code: null });
      showError(error);
    } finally {
      store.update({ making: false });
    }
  }

  function openRelay() {
    stopWatching();
    const { relay } = store.get();
    store.update({
      step: 'relay',
      code: null,
      link: 'none',
      linkError: null,
      error: null,
      url: relay?.current ?? relay?.sharedUrl ?? '',
    });
  }

  const offPaired = bridge.pair.onPaired((name) => {
    if (store.get().step !== 'code') return;
    stopWatching();
    store.update({ step: 'paired', paired: name });
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
      stopWatching();
      offPaired();
      bridge.pair.close();
    },
  };
}
