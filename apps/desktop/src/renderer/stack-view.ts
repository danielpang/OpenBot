import type { StackStatus } from '../stack/manager.js';

// What the start page shows for the local stack: one line of status and which
// buttons make sense. Plain, so it is tested without a DOM.

export interface StackView {
  text: string;
  canStart: boolean;
  canStop: boolean;
  /** Docker is installed but not running: offer to open it. */
  canOpenRuntime: boolean;
  /** Every service is up (and healthy where it has a health check). */
  running: boolean;
  /** The app is a newer release than the stack runs: what Update says, or null. */
  upgrade: string | null;
  /** Update moves the stack to the app's release (Docker is ready). */
  canUpgrade: boolean;
  /** Another app took the stack's port: the free port "Use port N" moves it to, or null. */
  freePort: number | null;
}

/** What the page says when another app took the stack's port. */
export function portTakenText(port: number, free: number | null): string {
  return free == null
    ? `Port ${port} is in use and no nearby port is free. Quit the app using it, then check again.`
    : `Port ${port} is in use by another app. OpenBots can use port ${free} instead.`;
}

export const RUNTIME_NAMES = {
  orbstack: 'OrbStack',
  'docker-desktop': 'Docker Desktop',
  other: 'Docker',
} as const;

export function stackView(status: StackStatus): StackView {
  const { docker, services } = status;
  const upgrade = status.upgrade
    ? `This Mac runs OpenBots ${status.upgrade.from}. Update to ${status.upgrade.to}, the app's version.`
    : null;
  const none = {
    canStart: false,
    canStop: false,
    canOpenRuntime: false,
    running: false,
    upgrade,
    canUpgrade: false,
    freePort: null,
  };
  switch (docker.state) {
    case 'missing':
      return {
        ...none,
        text: 'Docker is not installed. Install OrbStack or Docker Desktop to run OpenBots on this Mac.',
      };
    case 'stopped':
      return {
        ...none,
        canOpenRuntime: docker.installed.length > 0,
        text: `Docker is not running. Open ${docker.installed.map((r) => RUNTIME_NAMES[r]).join(' or ') || 'Docker'}.`,
      };
    case 'no-compose':
      return { ...none, text: 'Docker Compose v2 is not available. Update Docker.' };
    case 'ready': {
      const up = services.filter(
        (s) => s.state === 'running' && (s.health === '' || s.health === 'healthy'),
      );
      const running = services.length > 0 && up.length === services.length;
      const runtime = RUNTIME_NAMES[docker.runtime];
      const port = status.port;
      if (port?.taken) {
        // Starting would fail; moving the port is the way forward.
        return {
          ...none,
          text: portTakenText(port.port, port.free),
          canStop: services.length > 0,
          freePort: port.free,
        };
      }
      const text = running
        ? `Running on ${runtime}.`
        : services.length === 0
          ? `Not started. ${runtime} is ready.`
          : `Starting: ${up.length} of ${services.length} services ready.`;
      return {
        ...none,
        text,
        running,
        canStart: !running,
        canStop: services.length > 0,
        canUpgrade: upgrade != null,
      };
    }
  }
}
