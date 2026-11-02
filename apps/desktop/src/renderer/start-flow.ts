import type { ServerProfile } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import { errorParts, type StackErrorKind } from '../stack/error-parts.js';
import type { StackStatus } from '../stack/manager.js';
import { stackView, type StackView } from './stack-view.js';
import { createStore, type Store } from './store.js';
import {
  addressWarning,
  cloudChoice,
  PHASE_TEXT,
  runLocalSetup,
  savedConnections,
} from './welcome.js';

// The start page's flow (plan 14.4), without a DOM: ./start-page.tsx renders
// its state. With `welcome=1` it is the welcome screen: the three ways to
// connect, on first launch and from "Change connection…". Otherwise it is
// shown when the active server does not answer, with the reason, the bundled
// stack's controls for This Mac (start, stop, update, logs), and a way to
// change the connection; with `upgrade=1` when the app was updated past the
// release the stack runs, and `logs=1` from the web app's "Show logs". A
// self-hosted or account connection never asks Docker.

export type SetupPhase = keyof typeof PHASE_TEXT;

/** "Run OpenBots on this Mac" on the welcome screen, as runLocalSetup reports it. */
export type LocalSetupState =
  | { kind: 'idle' }
  | { kind: 'progress'; phase: SetupPhase | null; text: string }
  | { kind: 'docker-missing' }
  | { kind: 'docker-stopped'; text: string }
  | { kind: 'port-taken'; text: string; free: number | null }
  | { kind: 'network-clash'; text: string; detail: string | null }
  | { kind: 'failed'; message: string; detail: string | null };

/** Where an error shows: beside the choice or control that caused it, or at the top. */
export type ErrorPlace = 'page' | 'cloud' | 'server' | 'local' | 'stack' | 'saved';

export interface PageError {
  message: string;
  /** Command output behind "Show details", or null. */
  detail: string | null;
  place: ErrorPlace;
  /** Set when the page offers a way out, e.g. "Use a separate network". */
  kind?: StackErrorKind;
}

export interface StartState {
  mode: 'welcome' | 'status';
  /** The one error the page shows; every action clears it first. */
  error: PageError | null;
  saved: {
    visible: boolean;
    profiles: ServerProfile[];
    /** The active connection, marked in the list once one was chosen. */
    currentId: string | null;
  };
  welcome: {
    /** A connection was chosen before: the screen came from "Change connection…". */
    changing: boolean;
    cloud: { enabled: boolean; note: string | null };
    address: string;
    warning: string | null;
    checking: boolean;
    local: LocalSetupState;
  };
  status: {
    /** Why the server did not open, from the main process; offers Try again. */
    reason: string | null;
    /** The connection the page is about. */
    profile: ServerProfile | null;
    /** This Mac's stack, once read; null for any other connection. */
    stack: { status: StackStatus; view: StackView } | null;
    /** What the stack is doing on the owner's request, shown instead of its status. */
    busy: string | null;
    logs: { open: boolean; lines: string[] };
  };
}

export const OPENING_DOCKER = 'Opening Docker… Check again once it is running.';
export const STARTING = 'Starting the OpenBots server… The first start takes a few minutes.';
export const UPDATING = 'Updating the OpenBots server… This takes a few minutes.';
export const MOVING_PORT = 'Moving OpenBots to a free port and starting it…';
export const MOVING_NETWORK = 'Moving OpenBots to a network of its own and starting it…';

/** The most log lines the panel keeps. */
export const MAX_LOG_LINES = 5000;

/** The setup step a progress line belongs to, or null for a line the flow does not know. */
export function phaseOf(text: string): SetupPhase | null {
  const entry = Object.entries(PHASE_TEXT).find(([, line]) => line === text);
  return entry ? (entry[0] as SetupPhase) : null;
}

/** Which of This Mac's controls make sense, as the start page always showed them. */
export function stackButtons(view: StackView, busy: boolean) {
  return {
    start: view.canStart && !view.canUpgrade && !busy,
    update: view.canUpgrade && !busy,
    port: view.freePort != null && !busy,
    stop: view.canStop && !busy,
    runtime: view.canOpenRuntime && !busy,
    open: view.running,
  };
}

/** running, stopped or unhealthy, as the connection indicator says it. */
export function stackHealth(view: StackView): 'running' | 'unhealthy' | 'stopped' {
  return view.running ? 'running' : view.canStop ? 'unhealthy' : 'stopped';
}

export type StartFlow = ReturnType<typeof createStartFlow>;

export function createStartFlow(bridge: AppBridge, query: URLSearchParams) {
  const welcome = query.get('welcome') === '1';
  const store: Store<StartState> = createStore<StartState>({
    mode: welcome ? 'welcome' : 'status',
    error: null,
    saved: { visible: false, profiles: [], currentId: null },
    welcome: {
      changing: false,
      cloud: { enabled: false, note: null },
      address: '',
      warning: null,
      checking: false,
      local: { kind: 'idle' },
    },
    status: {
      reason: null,
      profile: null,
      stack: null,
      busy: null,
      logs: { open: false, lines: [] },
    },
  });
  const get = () => store.get();
  const setWelcome = (patch: Partial<StartState['welcome']>) =>
    store.update((s) => ({ welcome: { ...s.welcome, ...patch } }));
  const setStatus = (patch: Partial<StartState['status']>) =>
    store.update((s) => ({ status: { ...s.status, ...patch } }));
  const setLocal = (local: LocalSetupState) => setWelcome({ local });
  const setLogs = (patch: Partial<StartState['status']['logs']>) =>
    store.update((s) => ({ status: { ...s.status, logs: { ...s.status.logs, ...patch } } }));

  const clearError = () => store.update({ error: null });
  const showError =
    (place: ErrorPlace) =>
    (error: unknown): void => {
      const { message, detail, kind } = errorParts(error);
      // The welcome screen's own errors (a server check, the account) have no output to show.
      const shown = { message, detail: welcome ? null : detail, place };
      store.update({ error: kind ? { ...shown, kind } : shown });
    };

  async function renderSaved() {
    const view = await bridge.profiles.list();
    const profiles = savedConnections(view);
    store.update({
      saved: {
        // On first launch the welcome screen has exactly the three choices.
        visible: profiles.length > 0 && !(welcome && !view.chosen),
        profiles,
        currentId: view.chosen ? view.activeId : null,
      },
    });
    return view;
  }

  // The welcome screen.

  async function startWelcome() {
    const options = await bridge.connect.options();
    setWelcome({ changing: options.chosen, cloud: cloudChoice(options) });
    await renderSaved();
  }

  const setUpLocal = async (options: { movePort?: boolean; ownNetwork?: boolean } = {}) => {
    clearError();
    // Nothing is saved until the server opens, so after a failure the other two
    // choices still work as on first launch.
    await runLocalSetup(
      bridge,
      {
        progress: (text, phase) =>
          setLocal({ kind: 'progress', phase: phase ?? phaseOf(text), text }),
        dockerMissing: () => setLocal({ kind: 'docker-missing' }),
        dockerStopped: (text) => setLocal({ kind: 'docker-stopped', text }),
        portTaken: (text, free) => setLocal({ kind: 'port-taken', text, free }),
        networkClash: (text, detail) => setLocal({ kind: 'network-clash', text, detail }),
        failed: (message, detail) => setLocal({ kind: 'failed', message, detail }),
      },
      options,
    );
  };

  // The status page.

  async function refreshStack(): Promise<StackView> {
    const status = await bridge.stack.status();
    const view = stackView(status);
    setStatus({ stack: { status, view } });
    return view;
  }

  async function act(label: string, fn: () => Promise<unknown>) {
    setStatus({ busy: label });
    try {
      await fn();
    } catch (error) {
      showError('stack')(error);
    } finally {
      setStatus({ busy: null });
      await refreshStack().catch(showError('stack'));
    }
  }

  const startStack = () =>
    act(STARTING, async () => {
      await bridge.stack.start();
      await bridge.profiles.open('local');
    });

  // Writes the app's release into the stack's .env (the rest of it stays),
  // pulls it and restarts the services on it.
  const updateStack = () =>
    act(UPDATING, async () => {
      await bridge.stack.upgrade();
      await bridge.profiles.open('local');
    });

  let stopLogs: (() => void) | undefined;
  async function toggleLogs() {
    if (stopLogs) {
      stopLogs();
      stopLogs = undefined;
      setLogs({ open: false });
      return;
    }
    setLogs({ open: true, lines: [] });
    try {
      stopLogs = await bridge.stack.tailLogs(
        { tail: 200 },
        (line) =>
          store.update((s) => ({
            status: {
              ...s.status,
              logs: {
                ...s.status.logs,
                lines: [...s.status.logs.lines, line].slice(-MAX_LOG_LINES),
              },
            },
          })),
        () => {
          stopLogs = undefined;
          setLogs({ open: false });
        },
      );
    } catch (error) {
      showError('stack')(error);
    }
  }

  async function startStatus() {
    const reason = query.get('error');
    if (reason) {
      setStatus({ reason });
      showError('page')(`Could not open the server: ${reason}`);
    }
    const view = await renderSaved();
    const shown = view.profiles.find((p) => p.id === (query.get('profile') ?? view.activeId));
    setStatus({ profile: shown ?? null });
    // Docker is This Mac's alone: a self-hosted or account connection never asks for it.
    if (shown?.kind !== 'local') return;
    const stack = await refreshStack();
    if (query.get('logs') === '1') await toggleLogs();
    if (stack.canUpgrade && query.get('upgrade') === '1') await updateStack();
    else if (stack.canStart && query.get('autostart') === '1') await startStack();
  }

  return {
    store,
    start: () => (welcome ? startWelcome() : startStatus()).catch(showError('page')),

    saved: {
      open: (id: string) => bridge.profiles.open(id).catch(showError('saved')),
      remove: (id: string) =>
        bridge.profiles
          .remove(id)
          .then(renderSaved, showError('saved'))
          .then(() => undefined),
    },

    welcome: {
      cloud: () => {
        clearError();
        return bridge.connect.cloud().catch(showError('cloud'));
      },
      setAddress: (address: string) => setWelcome({ address, warning: addressWarning(address) }),
      connectServer: () => {
        clearError();
        setWelcome({ checking: true });
        return bridge.connect
          .server(get().welcome.address)
          .catch(showError('server'))
          .finally(() => setWelcome({ checking: false }));
      },
      setUpLocal: () => setUpLocal(),
      checkAgain: () => setUpLocal(),
      usePort: () => setUpLocal({ movePort: true }),
      useOwnNetwork: () => setUpLocal({ ownNetwork: true }),
      openRuntime: () =>
        bridge.stack
          .startRuntime()
          .then(() => setLocal({ kind: 'docker-stopped', text: OPENING_DOCKER }))
          .catch(showError('local')),
    },

    status: {
      change: () => bridge.connection.change().catch(showError('page')),
      retry: () => {
        const id = query.get('profile');
        return id ? bridge.profiles.open(id).catch(showError('page')) : Promise.resolve();
      },
      start: startStack,
      update: updateStack,
      // Another app took the stack's port: move to the free one, then start there.
      usePort: () =>
        act(MOVING_PORT, async () => {
          await bridge.stack.changePort();
          await bridge.stack.start();
          await bridge.profiles.open('local');
        }),
      // Another OpenBots stack holds the sandbox network: stop what this
      // stack's failed start left up, move it to its own network, start it.
      useOwnNetwork: () =>
        act(MOVING_NETWORK, async () => {
          await bridge.stack.stop();
          await bridge.stack.useOwnNetwork();
          await bridge.stack.start();
          await bridge.profiles.open('local');
        }),
      stop: () => act('Stopping…', () => bridge.stack.stop()),
      openRuntime: () => act('Opening Docker…', () => bridge.stack.startRuntime()),
      open: () => bridge.profiles.open('local').catch(showError('stack')),
      toggleLogs,
    },
  };
}
