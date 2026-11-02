import type {
  ConnectionInfo,
  ConnectOptions,
  ProfileKind,
  ServerCheckResult,
  ServerProfile,
} from '../ipc.js';
import { stackView } from '../renderer/stack-view.js';
import { parseServerAddress, ServerUrlError } from '../server-url.js';
import type { StackManager } from '../stack/manager.js';
import { CLOUD_PROFILE_ID, LOCAL_PROFILE_ID, type ProfileStore } from './profiles.js';
import {
  checkServer,
  entryPath,
  ServerCheckError,
  waitUntilReady,
  type FetchLike,
  type WaitOptions,
} from './server-check.js';

// Which connection the app opens, and the three ways to choose one (plan
// 14.4): an OpenBots account on the hosted server, a self-hosted server, or
// the bundled stack on this Mac. The first two are thin clients: nothing here
// touches the stack manager unless the connection is This Mac. Plain, so it
// is tested without Electron; ./index.ts gives it the main window.

export interface LauncherWindow {
  /**
   * Loads `path` of the profile's server in the main window, making it the
   * window's profile, once the server answers as OpenBots (./opener.ts).
   * Resolves false when it did not, and the window shows the start page.
   */
  openServer(profile: ServerProfile, path?: string): Promise<boolean>;
  /** The start page for the profile: its stack controls for This Mac, and the way to change. */
  showStart(profile: ServerProfile, options?: { upgrade?: boolean; logs?: boolean }): Promise<void>;
  /** The three choices. */
  showWelcome(): Promise<void>;
}

export type LauncherStack = Pick<
  StackManager,
  'status' | 'start' | 'stop' | 'refresh' | 'pendingUpgrade'
>;

export interface LauncherOptions {
  profiles: ProfileStore;
  stack: LauncherStack;
  fetch: FetchLike;
  cloudUrl: string | null;
  window: LauncherWindow;
  /** For tests: how long and how often to wait for /readyz. */
  wait?: WaitOptions;
}

const LABELS: Record<ProfileKind, string> = {
  local: 'This Mac',
  remote: 'Self-hosted',
  cloud: 'OpenBots account',
};

/** "This Mac", "Self-hosted" or "OpenBots account", and the server's host. */
export function describeConnection(profile: ServerProfile): Omit<ConnectionInfo, 'stack'> {
  return {
    kind: profile.kind,
    label: LABELS[profile.kind],
    host: new URL(profile.url).host,
    url: profile.url,
  };
}

/** The tray menu's header line: the kind and the host. */
export function connectionHeader(profile: ServerProfile): string {
  const { label, host } = describeConnection(profile);
  return `${label} (${host})`;
}

/** Errors the owner can act on cross IPC as their sentence alone. */
function readable(error: unknown): never {
  if (error instanceof ServerUrlError || error instanceof ServerCheckError) {
    throw new Error(error.message);
  }
  throw error;
}

export interface Launcher {
  options(): Promise<ConnectOptions>;
  /**
   * Opens the chosen connection, or the three choices on first launch;
   * `start` when its server did not pass the check and the start page shows.
   */
  launch(): Promise<'welcome' | 'server' | 'start' | 'upgrade'>;
  /** Back to the three choices; saved profiles stay. */
  changeConnection(): Promise<void>;
  connectCloud(): Promise<void>;
  checkServer(input: string): Promise<ServerCheckResult>;
  connectServer(input: string): Promise<void>;
  /** After the start page started the stack: waits for /readyz, then opens the web app. */
  connectLocal(): Promise<void>;
  info(): Promise<ConnectionInfo>;
  /** This Mac only: the web app's Start, Stop and Show logs. */
  startLocal(): Promise<ConnectionInfo>;
  stopLocal(): Promise<void>;
  showLocalLogs(): Promise<void>;
}

export function createLauncher(options: LauncherOptions): Launcher {
  const { profiles, stack, fetch, cloudUrl, window } = options;

  async function check(input: string): Promise<ServerCheckResult> {
    try {
      const address = parseServerAddress(input);
      const result = await checkServer(fetch, address.url);
      return { ...result, warning: address.warning };
    } catch (error) {
      return readable(error);
    }
  }

  async function activeLocal(): Promise<ServerProfile> {
    const profile = await profiles.active();
    if (profile.kind !== 'local') {
      throw new Error('Only a connection to This Mac runs the OpenBots server here.');
    }
    return profile;
  }

  async function info(): Promise<ConnectionInfo> {
    const profile = await profiles.active();
    const base = describeConnection(profile);
    if (profile.kind !== 'local') return base;
    const view = stackView(await stack.status());
    const state = view.running ? 'running' : view.canStop ? 'unhealthy' : 'stopped';
    return { ...base, stack: { state, text: view.text } };
  }

  return {
    async options() {
      return { cloudUrl, chosen: (await profiles.list()).chosen };
    },

    async launch() {
      const view = await profiles.list();
      if (!view.chosen) {
        // Only an install from before the choice existed has no file and a stack .env.
        await profiles.recordNoChoice().catch(() => undefined);
        await window.showWelcome();
        return 'welcome';
      }
      const profile = view.profiles.find((p) => p.id === view.activeId)!;
      // A stack left running by an older app gets this one's settings first.
      if (profile.kind === 'local') await stack.refresh().catch(() => false);
      // The start page already shows why; a stopped stack's start there moves it to the release.
      if (!(await window.openServer(profile))) return 'start';
      // The app was updated past the local stack's release: the start page moves it.
      if (profile.kind !== 'local') return 'server';
      const upgrade = await stack.pendingUpgrade().catch(() => null);
      if (!upgrade) return 'server';
      await window.showStart(profile, { upgrade: true });
      return 'upgrade';
    },

    changeConnection: () => window.showWelcome(),

    async connectCloud() {
      if (!cloudUrl) throw new Error('OpenBots accounts are not available yet.');
      const profile = await profiles.setActive(CLOUD_PROFILE_ID);
      await window.openServer(profile, '/sign-in');
    },

    checkServer: check,

    async connectServer(input) {
      const result = await check(input);
      const added = await profiles.add({ url: result.url });
      const profile = await profiles.setActive(added.id);
      await window.openServer(profile, entryPath(result.setupRequired));
    },

    async connectLocal() {
      const view = await profiles.list();
      const local = view.profiles.find((p) => p.id === LOCAL_PROFILE_ID)!;
      try {
        await waitUntilReady(fetch, local.url, options.wait);
        await checkServer(fetch, local.url);
        const profile = await profiles.setActive(LOCAL_PROFILE_ID);
        // The app signs the owner in itself, and the web app goes on to setup if it is needed.
        await window.openServer(profile);
      } catch (error) {
        readable(error);
      }
    },

    info,

    async startLocal() {
      await activeLocal();
      await stack.start();
      return info();
    },

    async stopLocal() {
      const profile = await activeLocal();
      await stack.stop();
      await window.showStart(profile);
    },

    async showLocalLogs() {
      await window.showStart(await activeLocal(), { logs: true });
    },
  };
}
