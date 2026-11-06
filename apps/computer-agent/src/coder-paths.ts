import path from 'node:path';
import {
  CODER_CONFIG_ENV,
  CODER_HOME_NAME,
  CODER_STATE_NAME,
  REPOS_REL,
  RUNNER_HOME_NAME,
  type CoderAgent,
} from '@openbots/shared';

// Where the coding agents keep their state in the computer (I2, I3). The
// names, paths and uids are defined once in @openbots/shared
// (coder-runtime.ts), which @openbots/computer re-exports for the server. The
// agent derives the directories from its own state and runtime directories,
// so tests can point both at temporary ones.

export {
  CODER_CONFIG_ENV,
  CODER_CREDENTIAL_SOCKET_ENV,
  CODER_HOME_NAME,
  CODER_SESSION_DIR_ENV,
  CODER_SESSION_ENV,
  CODER_SOCKET_ENV,
  GIT_CREDENTIAL_HELPER,
  REPOS_REL,
  RUNNER_HOME_NAME,
} from '@openbots/shared';

export const CODER_AGENT_DIRS = ['claude', 'codex', 'pi'] as const satisfies readonly CoderAgent[];
export type CoderAgentDir = (typeof CODER_AGENT_DIRS)[number];

/** The permission relay's socket in each session's directory (I11). */
export const PERMISSION_SOCKET = 'permission.sock';

/** The credential relay's socket in each session's directory (I5). */
export const CREDENTIAL_SOCKET = 'credential.sock';

/**
 * What the credential relay writes back to git's helper: one JSON line, then
 * it closes the connection. The request is `GitCredentialRequest` (protocol.ts).
 */
export type CredentialRelayReply = { username: string; password: string } | { denied: string };

/** What the permission MCP server writes to the socket: one JSON line. */
export interface PermissionRelayRequest {
  /** The MCP server's own id for the prompt; the agent gives the server one of its own. */
  request_id?: string;
  tool_name: string;
  input: unknown;
}

/** What the agent writes back: one JSON line, then it closes the connection. */
export interface PermissionRelayReply {
  decision: 'allow' | 'deny';
  message?: string;
}

export interface CoderPaths {
  /** `<stateDir>/coders`: root's, 0711. */
  stateDir: string;
  /**
   * `<stateDir>/coders/home`: the coder user's HOME, its own and 0700
   * (CODER_HOME in the image). The
   * state directory itself is root's; Claude Code writes ~/.claude.json and
   * other tools ~/.config and ~/.cache, so HOME must be writable.
   */
  homeDir: string;
  /**
   * `<stateDir>/coders/runner-home`: the runner user's HOME, its own and
   * 0700. Some git versions want a writable HOME; nothing else lives there.
   */
  runnerHomeDir: string;
  /** `<stateDir>/coders/<agent>`: the coder user's alone, 0700. */
  configDir(agent: CoderAgentDir): string;
  /** `<runtimeDir>/coders`: one directory per running session. */
  sessionsDir: string;
}

export function coderPaths(runtimeDir: string, stateDir: string): CoderPaths {
  const state = path.join(stateDir, CODER_STATE_NAME);
  return {
    stateDir: state,
    homeDir: path.join(state, CODER_HOME_NAME),
    runnerHomeDir: path.join(state, RUNNER_HOME_NAME),
    configDir: (agent) => path.join(state, agent),
    sessionsDir: path.join(runtimeDir, 'coders'),
  };
}

/** Every agent's config directory variable, for any process the coder user runs. */
export function coderConfigEnv(paths: CoderPaths): Record<string, string> {
  return Object.fromEntries(
    CODER_AGENT_DIRS.map((agent) => [CODER_CONFIG_ENV[agent], paths.configDir(agent)]),
  );
}

/**
 * git configuration through the environment (GIT_CONFIG_COUNT, git 2.31+),
 * after any the caller's `env` already sets: the system credential helper is
 * cleared and, with `helper`, replaced by the OpenBots one, which asks for
 * the URL's path too so a token can be scoped to one repository (I5). These
 * apply after every config file, so a repository's own config cannot point
 * git at another helper for the session. `safe` names the directories git
 * may work in although another user owns them (the bot user's clone, the
 * coder user's worktree): only the session's own, never `*`.
 */
export function gitConfigEnv(
  env: NodeJS.ProcessEnv,
  helper?: string,
  safe: string[] = [],
): Record<string, string> {
  const start = Number(env.GIT_CONFIG_COUNT ?? 0);
  const base = Number.isInteger(start) && start > 0 ? start : 0;
  const entries: [string, string][] = [['credential.helper', '']];
  if (helper) entries.push(['credential.helper', helper], ['credential.useHttpPath', 'true']);
  for (const dir of safe) entries.push(['safe.directory', dir]);
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(base + entries.length) };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  return out;
}

/**
 * The directories of a session's checkout that git must trust whoever owns
 * them: the working directory and, for a worktree under
 * `repos/<owner>/<name>/`, that repository, whose `.git` it shares. This is
 * the fallback for a start that names none (`safe_directories`).
 */
export function sessionSafeDirectories(home: string, cwd: string): string[] {
  const rel = path.relative(home, cwd);
  if (rel === '' || rel.startsWith('..')) return [];
  const parts = rel.split(path.sep);
  const safe = [cwd];
  if (parts[0] === REPOS_REL && parts.length > 3) safe.push(path.join(home, ...parts.slice(0, 3)));
  return safe;
}

/** A directory the start names for safe.directory: absolute, normalised, inside the home. */
export function isSafeDirectory(home: string, dir: string): boolean {
  if (!path.isAbsolute(dir) || dir.includes('\0') || path.normalize(dir) !== dir) return false;
  const rel = path.relative(home, dir);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
