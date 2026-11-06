import type { CoderAgent, ComputerProviderName } from '@openbots/shared';
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

// Coding agents (I2, I3, I5, I11). The `coder` user runs every coding agent
// and every login; its config directories live on the root-only state
// volume, so the Bot's shell, running as `bot`, cannot read the owner's
// vendor sign-ins (the same arrangement as the cookie store, plan 9.6).

/** The `coder` user's uid. */
export const CODER_ID = 1800;
/** The `coders` group: `coder` and `bot`, so both read and write the repositories. */
export const CODERS_GID = 1800;
/**
 * The runner's own user (uid 1801, group coders): the server's git operations
 * (clone, fetch, scan, rescue) run as it, so a coding session, which runs as
 * `coder`, cannot read their environment and the credentials in it.
 */
export const RUNNER_ID = 1801;
/** The agents' config directories and the sessions' own directories, 0700 `coder`. */
export const CODER_STATE_DIR = `${STATE_DIR}/coders`;
/** Where repositories are cloned, `bot:coders` 2775; one worktree per session under each `.worktrees/`. */
export const REPOS_DIR = `${COMPUTER_HOME}/repos`;
/**
 * A random secret the agent mints per process and puts in its environment; the
 * credential helper sends it with each request. It is not the server's session
 * id, which the Bot can read from the widget, so knowing a session id gives no
 * credentials.
 */
export const CODER_SESSION_ENV = 'OPENBOTS_CODER_SESSION';
/** The unix socket in the session directory that the permission MCP server relays prompts through. */
export const CODER_SOCKET_ENV = 'OPENBOTS_CODER_SOCKET';
/** The unix socket in the session directory that the git credential helper asks. */
export const CODER_CREDENTIAL_SOCKET_ENV = 'OPENBOTS_CODER_CREDENTIAL_SOCKET';
/** The session's own directory under the agent's runtime dir (`{{session_dir}}` in `start`). */
export const CODER_SESSION_DIR_ENV = 'OPENBOTS_CODER_SESSION_DIR';
/** The stdio MCP server Claude Code's `--permission-prompt-tool` points at (I11). */
export const CODER_PERMISSION_MCP = '/app/apps/computer-agent/dist/coder-permission-mcp.js';
/** The pi extension (`pi -e`) whose `tool_call` hook relays each tool call the same way (I11). */
export const CODER_PI_EXTENSION = '/app/apps/computer-agent/dist/coder-pi-extension.js';
/** git's `credential.helper` for `bot` and `coder` (I5). */
export const GIT_CREDENTIAL_HELPER = '/usr/local/bin/openbots-git-credential';

/** Each agent's config directory and the variable that points it there. */
export const CODER_CONFIG_DIRS: Record<CoderAgent, { env: string; dir: string }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', dir: `${CODER_STATE_DIR}/claude` },
  codex: { env: 'CODEX_HOME', dir: `${CODER_STATE_DIR}/codex` },
  pi: { env: 'PI_CODING_AGENT_DIR', dir: `${CODER_STATE_DIR}/pi` },
};
