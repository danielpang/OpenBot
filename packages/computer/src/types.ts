import type { ComputerProviderName } from '@openbots/shared';
import type { ComputerAgentClient } from './agent-client.js';

// The provider interface (plan 9.2). `docker` is v1; `remote` points at a
// control agent already running on some machine; firecracker, e2b and daytona
// are later providers (K6). The server owns the `computers` row and calls a
// provider to make the machine behind it exist, run and stop.

/** Resource limits for one computer (plan 9.5). */
export interface ComputerLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /** /dev/shm, which Chromium needs much more of than Docker's 64 MB default. */
  shmMb: number;
  /** Size of the /tmp tmpfs. */
  tmpMb: number;
}

export const DEFAULT_LIMITS: ComputerLimits = {
  memoryMb: 4096,
  cpus: 2,
  pids: 1024,
  shmMb: 1024,
  tmpMb: 1024,
};

/** What to create: one computer for one account (K1). */
export interface ComputerSpec {
  computerId: string;
  ownerId: string;
  image: string;
  /** The bearer token the control agent accepts; the server keeps it sealed. */
  agentToken: string;
  /** The persistent volume mounted at /home/bot (K7); kept when the computer stops. */
  volumeName: string;
  limits?: Partial<ComputerLimits>;
  /**
   * An HTTP proxy the sandbox's web traffic goes through (plan 9.5, optional
   * allowlist), e.g. `http://172.30.255.3:8888`. Set as `HTTP_PROXY` and
   * `HTTPS_PROXY` in both cases, which the browser and the usual command line
   * tools read. docker/sandbox-firewall.sh lets the computers reach it.
   */
  egressProxy?: string;
  /** Hosts that skip `egressProxy` (`NO_PROXY`); defaults to `DEFAULT_NO_PROXY`. */
  noProxy?: string;
  timezone?: string;
}

/** What skips the egress proxy unless `noProxy` says otherwise: the computer itself. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1';

/** Where a created computer lives; stored on the `computers` row. */
export interface ComputerRef {
  provider: ComputerProviderName;
  containerId: string | null;
  agentUrl: string;
  agentToken: string;
  volumeName: string | null;
}

/** What the provider sees; the server's own status adds `creating`, `starting`, `stopping`, `error`. */
export type MachineStatus = 'running' | 'stopped' | 'missing';

export interface ComputerProvider {
  readonly name: ComputerProviderName;
  create(spec: ComputerSpec): Promise<ComputerRef>;
  /** Starts the machine and resolves once its control agent answers. */
  start(ref: ComputerRef): Promise<void>;
  stop(ref: ComputerRef): Promise<void>;
  /** Removes the machine; the home volume is kept (K7). */
  destroy(ref: ComputerRef): Promise<void>;
  status(ref: ComputerRef): Promise<MachineStatus>;
  agent(ref: ComputerRef): ComputerAgentClient;
  /** Fetches the sandbox image ahead of the first `create` (the setup wizard); Docker only. */
  prepareImage?(image: string): Promise<void>;
  /**
   * Pulls an image already present again, so a tag that moves with releases
   * (`latest`, `1.2`) reaches the new release after an upgrade; Docker only.
   */
  refreshImage?(image: string): Promise<void>;
  /**
   * False when the machine was made from another build of `image` than the
   * local one (the tag moved since), so it is made again; Docker only.
   */
  runsImage?(ref: ComputerRef, image: string): Promise<boolean>;
}

/** The persistent home every Bot of the account shares (plan 9.1). */
export const COMPUTER_HOME = '/home/bot';
/** The agent's state volume: the token file and the screens' Chromium profiles, root's (S-7). */
export const STATE_DIR = '/var/lib/openbots';
