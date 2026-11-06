import { DEFAULT_PROCESS_LIMITS } from './limits.js';
import type { CoderAgent } from './policy.js';

// The coding agents' runtime inside the computer (I2, I3, I5, I11): the
// users, paths and environment variable names the server's launches and the
// control agent's sessions must agree on. @openbots/computer re-exports them
// for the server; the control agent imports them from here. The uids are
// also in apps/computer-agent/native/runas.c and docker/computer.Dockerfile,
// which cannot import them.

/** The persistent home every Bot of the account shares (plan 9.1). */
export const COMPUTER_HOME = '/home/bot';
/** The agent's state volume: the token file and the screens' Chromium profiles, root's (S-7). */
export const COMPUTER_STATE_DIR = '/var/lib/openbots';

/** The `coder` user's uid: every coding agent and every login runs as it. */
export const CODER_ID = 1800;
/** The `coders` group: `coder`, `runner` and `bot`, so all of them read and write the repositories. */
export const CODERS_GID = 1800;
/**
 * The runner's own user (group coders): the server's git operations (clone,
 * fetch, scan, rescue) run as it, so a coding session, which runs as
 * `coder`, cannot read their environment and the credentials in it.
 */
export const RUNNER_ID = 1801;

/** The coders' directory under the state volume, and its name there. */
export const CODER_STATE_NAME = 'coders';
/** The agents' config directories and the sessions' own directories, 0700 `coder`. */
export const CODER_STATE_DIR = `${COMPUTER_STATE_DIR}/${CODER_STATE_NAME}`;
/** The coder user's HOME under the coders state directory, its own and 0700. */
export const CODER_HOME_NAME = 'home';
export const CODER_HOME = `${CODER_STATE_DIR}/${CODER_HOME_NAME}`;
/** The runner user's HOME under the coders state directory, its own and 0700. */
export const RUNNER_HOME_NAME = 'runner-home';
export const RUNNER_HOME = `${CODER_STATE_DIR}/${RUNNER_HOME_NAME}`;

/** The repositories, relative to the home. */
export const REPOS_REL = 'repos';
/** Where repositories are cloned, `bot:coders` 2775; one worktree per session under each `.worktrees/`. */
export const REPOS_DIR = `${COMPUTER_HOME}/${REPOS_REL}`;

/**
 * A random secret the agent mints per process and puts in its environment; the
 * credential helper sends it with each request. It is not the server's session
 * id, which the Bot can read from the widget, so knowing a session id gives no
 * credentials.
 */
export const CODER_SESSION_ENV = 'OPENBOTS_CODER_SESSION';
/** The unix socket in the session directory that the permission relay listens on (I11). */
export const CODER_SOCKET_ENV = 'OPENBOTS_CODER_SOCKET';
/** The unix socket in the session directory that the git credential helper asks (I5). */
export const CODER_CREDENTIAL_SOCKET_ENV = 'OPENBOTS_CODER_CREDENTIAL_SOCKET';
/** The session's own directory under the agent's runtime dir (`{{session_dir}}` in `start`). */
export const CODER_SESSION_DIR_ENV = 'OPENBOTS_CODER_SESSION_DIR';
/** The session's mode (`plan`, `edit`, `pr`), which the server's launch of pi sets. */
export const CODER_MODE_ENV = 'OPENBOTS_CODER_MODE';
/**
 * How long a permission prompt waits for the owner, in milliseconds, which
 * the server's launch sets. It mirrors OPENBOTS_APPROVAL_TTL_MINUTES, so a
 * prompt inside a session expires when the server's approval does.
 */
export const CODER_APPROVAL_TTL_ENV = 'OPENBOTS_APPROVAL_TTL_MS';

/** The stdio MCP server Claude Code's `--permission-prompt-tool` points at (I11). */
export const CODER_PERMISSION_MCP = '/app/apps/computer-agent/dist/coder-permission-mcp.js';
/** The pi extension (`pi -e`) whose `tool_call` hook relays each tool call the same way (I11). */
export const CODER_PI_EXTENSION = '/app/apps/computer-agent/dist/coder-pi-extension.js';
/** git's `credential.helper` for `bot` and `coder` (I5), installed by docker/computer.Dockerfile. */
export const GIT_CREDENTIAL_HELPER = '/usr/local/bin/openbots-git-credential';

/** The variable each agent reads its config directory from. */
export const CODER_CONFIG_ENV: Record<CoderAgent, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  pi: 'PI_CODING_AGENT_DIR',
};

/** Each agent's config directory and the variable that points it there. */
export const CODER_CONFIG_DIRS: Record<CoderAgent, { env: string; dir: string }> = {
  claude: { env: CODER_CONFIG_ENV.claude, dir: `${CODER_STATE_DIR}/claude` },
  codex: { env: CODER_CONFIG_ENV.codex, dir: `${CODER_STATE_DIR}/codex` },
  pi: { env: CODER_CONFIG_ENV.pi, dir: `${CODER_STATE_DIR}/pi` },
};

/** A permission prompt's wait without CODER_APPROVAL_TTL_ENV: the server's default approval TTL. */
export const DEFAULT_CODER_APPROVAL_TTL_MS = DEFAULT_PROCESS_LIMITS.approvalTtlMinutes * 60_000;

/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long a permission prompt waits for the owner: CODER_APPROVAL_TTL_ENV
 * when it is a positive whole number of milliseconds (at most what a timer
 * takes), else DEFAULT_CODER_APPROVAL_TTL_MS.
 */
export function coderApprovalTtlMs(env: Record<string, string | undefined>): number {
  const raw = env[CODER_APPROVAL_TTL_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_CODER_APPROVAL_TTL_MS;
  const ms = Number(raw);
  return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_CODER_APPROVAL_TTL_MS;
}
