import type { ConnectOptions, ProfilesView, ServerProfile } from '../ipc.js';
import type { AppBridge } from '../preload/bridge.js';
import { parseServerAddress } from '../server-url.js';
import { errorParts } from '../stack/error-parts.js';
import type { StackPhase, StackProgress } from '../stack/manager.js';
import { portTakenText, RUNTIME_NAMES } from './stack-view.js';

// The welcome screen's logic (plan 14.4): the three ways to connect. Plain,
// with the page behind small view interfaces, so it is tested without a DOM;
// ./start-flow.ts drives it for the page. Only "Run OpenBots on this Mac" asks for
// Docker, and only once it is chosen.

export const CLOUD_UNAVAILABLE = 'OpenBots accounts are not available yet.';

/** "Sign in to an OpenBots account" needs a hosted server from the build. */
export function cloudChoice(options: ConnectOptions): { enabled: boolean; note: string | null } {
  return options.cloudUrl
    ? { enabled: true, note: null }
    : { enabled: false, note: CLOUD_UNAVAILABLE };
}

/** The warning under the address field as the owner types: plain http, or nothing. */
export function addressWarning(input: string): string | null {
  try {
    return parseServerAddress(input).warning;
  } catch {
    return null;
  }
}

/**
 * The connections the start page lists to switch to: every saved one, and
 * This Mac only while it is the active one (choosing it otherwise is the
 * third choice, which checks Docker first).
 */
export function savedConnections(view: ProfilesView): ServerProfile[] {
  return view.profiles.filter((p) => p.kind !== 'local' || p.id === view.activeId);
}

export const PHASE_TEXT: Record<StackPhase | 'checking' | 'waiting', string> = {
  checking: 'Checking for Docker…',
  pulling: 'Downloading OpenBots. The first time takes a few minutes.',
  starting: 'Starting OpenBots…',
  waiting: 'Waiting for the server to be ready…',
};

const IMAGE_NAMES: Record<StackProgress['image'], string> = {
  server: 'server',
  'sandbox-firewall': 'sandbox firewall',
  computer: 'computer',
};

/**
 * The progress line for a step. While the images come from the GitHub
 * Release (the registry refused them), the download step names the image and
 * how far it is.
 */
export function progressText(phase: StackPhase, progress?: StackProgress): string {
  if (phase !== 'pulling' || !progress) return PHASE_TEXT[phase];
  const name = IMAGE_NAMES[progress.image];
  const which = progress.count > 1 ? ` (${progress.index} of ${progress.count})` : '';
  if (progress.step === 'loading') {
    return `Downloading OpenBots: installing the ${name} image${which}…`;
  }
  const percent = progress.percent == null ? '' : `, ${progress.percent}%`;
  return `Downloading OpenBots: the ${name} image${which}${percent}`;
}

export interface LocalSetupView {
  /** A progress line; `phase` names its setup step when the text alone does not. */
  progress(text: string, phase?: StackPhase): void;
  /** Neither Docker Desktop nor OrbStack: how to install one, and Check again. */
  dockerMissing(): void;
  /** Installed but not running: Open Docker, and Check again. */
  dockerStopped(text: string): void;
  /** Another app holds the stack's port: why, "Use port N" when one is free, and Check again. */
  portTaken(text: string, free: number | null): void;
  /**
   * Another OpenBots stack on this Mac holds the sandbox network: why, "Use
   * a separate network", the output behind "Show details", and Check again.
   */
  networkClash(text: string, detail: string | null): void;
  /** Something went wrong: the sentence, the output behind "Show details", and Check again. */
  failed(message: string, detail: string | null): void;
}

export type LocalSetupResult =
  'missing' | 'stopped' | 'port-taken' | 'network-clash' | 'failed' | 'opened';

/**
 * Runs the bundled stack on this Mac: checks Docker and the stack's port,
 * starts the stack (it downloads the images first when they are not on this
 * Mac, so the download shows as its own step), waits for /readyz and opens
 * the server's setup wizard, or sign-in. `movePort` first moves the stack off
 * a port another app took ("Use port N"); `ownNetwork` first stops the app's
 * own stack (a failed start can leave part of it up) and moves it to a
 * sandbox network of its own ("Use a separate network"). Nothing is saved
 * until the server opens: after a failure the owner can still choose another
 * connection.
 */
export async function runLocalSetup(
  bridge: Pick<AppBridge, 'stack' | 'connect'>,
  view: LocalSetupView,
  options: { movePort?: boolean; ownNetwork?: boolean } = {},
): Promise<LocalSetupResult> {
  view.progress(PHASE_TEXT.checking);
  let unsubscribe: (() => void) | undefined;
  try {
    if (options.ownNetwork) {
      await bridge.stack.stop();
      await bridge.stack.useOwnNetwork();
    }
    const status = options.movePort ? await bridge.stack.changePort() : await bridge.stack.status();
    const { docker } = status;
    if (docker.state === 'missing') {
      view.dockerMissing();
      return 'missing';
    }
    if (docker.state === 'stopped') {
      const names = docker.installed.map((r) => RUNTIME_NAMES[r]).join(' or ') || 'Docker';
      view.dockerStopped(`Docker is not running. Open ${names}, then check again.`);
      return 'stopped';
    }
    if (docker.state === 'no-compose') {
      view.failed('Docker Compose v2 is not available. Update Docker, then check again.', null);
      return 'failed';
    }
    if (status.port?.taken) {
      view.portTaken(portTakenText(status.port.port, status.port.free), status.port.free);
      return 'port-taken';
    }
    unsubscribe = bridge.stack.onProgress((phase, progress) =>
      view.progress(progressText(phase, progress), phase),
    );
    // A start, never an update: it pulls only the images this Mac does not have.
    await bridge.stack.start();
    view.progress(PHASE_TEXT.waiting);
    await bridge.connect.local();
    return 'opened';
  } catch (error) {
    const { message, detail, kind } = errorParts(error);
    if (kind === 'network-clash') {
      view.networkClash(message, detail);
      return 'network-clash';
    }
    view.failed(message, detail);
    return 'failed';
  } finally {
    unsubscribe?.();
  }
}
