import { ApiError, unwrap, type Problem } from '@openbots/api-client';
import type {
  CoderAgent,
  CoderAuthKind,
  CoderChangedFile,
  CoderCommit,
  CoderLoginStatus,
  CoderMode,
  CoderUsage,
  CodingSessionStatus,
} from '@openbots/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// Coding agents (CA2, CA3, CA5, CA7, GH3): the agents' sign-in state on the
// computer, a sign-in in progress, coding sessions and the remembered
// repositories. The generated client has every one of these routes. The
// wrappers below still go through `request` with shapes kept by hand, for
// these reasons: `CoderAccount.lastErrorKind` is newer than `openapi.json`;
// `RepoCheckout.state` is a plain string there, not the union below; pi's
// sign-in answers 409 with a `terminal` body that `request` keeps on the
// error; and the session log is text, not JSON. `CodingSession` matches
// `components['schemas']['CodingSession']` field for field.

/** Why the account's last check or session failed, as the server sorts it. */
export type CoderErrorKind = 'sign_in' | 'key' | 'other';

export interface CoderAccount {
  agent: CoderAgent;
  label: string;
  /** Whether this build has a runner for the agent; every agent has one now. */
  available: boolean;
  authKind: CoderAuthKind;
  accountLabel: string | null;
  signedInAt: string | null;
  version: string | null;
  lastError: string | null;
  providerId: string | null;
  /** Never signed in, or the sign-in lapsed on the computer: the card offers Sign in. */
  needsSignIn: boolean;
  /** `sign_in`: the sign-in lapsed. `key`: the provider rejected the API key. `other`: anything else. */
  lastErrorKind: CoderErrorKind | null;
}

export interface CoderLogin {
  id: string;
  agent: CoderAgent;
  status: CoderLoginStatus;
  url: string | null;
  deviceCode: string | null;
  accountLabel: string | null;
  error: string | null;
  expiresAt: string | null;
}

export interface CodingSession {
  id: string;
  botId: string;
  runId: string | null;
  chatId: string | null;
  messageId: string | null;
  partIndex: number | null;
  agent: CoderAgent;
  repoId: string | null;
  repoFullName: string | null;
  branch: string | null;
  base: string | null;
  mode: CoderMode;
  status: CodingSessionStatus;
  pushAllowed: boolean;
  vendorSessionId: string | null;
  usage: CoderUsage | null;
  summary: string | null;
  changedFiles: CoderChangedFile[];
  commits: CoderCommit[];
  prUrl: string | null;
  /** The Artifact the session's diff was saved as, once it settled with changes. */
  diffArtifactId: string | null;
  error: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Where Open terminal attaches: the worktree, the `coder` user, and the resume command. */
export interface TerminalAttach {
  cwd: string;
  user?: string;
  preset?: string;
}

export type RepoCheckoutState =
  'cloning' | 'updating' | 'ready' | 'behind' | 'dirty' | 'missing' | 'error';

export interface RepoCheckout {
  state: RepoCheckoutState;
  path: string | null;
  ahead: number;
  behind: number;
  headSha: string | null;
  lastFetchAt: string | null;
  /** When the checkout last changed state, when the server says; a clone or update older than 30 minutes is stuck. */
  updatedAt?: string | null;
  error: string | null;
}

export interface Repo {
  id: string;
  fullName: string;
  remoteUrl: string;
  defaultBranch: string | null;
  keepCloned: boolean;
  pinned: boolean;
  description: string | null;
  lastUsedAt: string | null;
  /** ISO time of the last push to the remote, when GitHub gives one (Phase 2). */
  lastRemotePushAt?: string | null;
  /** Remembered from a clone found on the computer (GH6). */
  found?: boolean;
  checkout: RepoCheckout | null;
}

export interface AddRepo {
  remoteUrl: string;
  fullName?: string;
  defaultBranch?: string;
  keepCloned?: boolean;
}

const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
const url = (path: string) => new URL(path, origin).toString();

/** A JSON request with a hand-kept answer type (see the top of this file); throws `ApiError`. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(url(path), {
    method,
    credentials: 'include',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const error: TerminalError = new ApiError(
      response.status,
      data as Partial<Problem> | undefined,
    );
    const terminal = terminalLogin(data);
    if (terminal) error.terminal = terminal;
    throw error;
  }
  return data as T;
}

type TerminalError = ApiError & { terminal?: TerminalLogin };

/** The `{ message, terminal }` of a 409 `CODER_LOGIN_IN_TERMINAL`, when the body is one. */
function terminalLogin(data: unknown): TerminalLogin | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const body = data as { message?: unknown; detail?: unknown; terminal?: unknown };
  const terminal = body.terminal as Partial<TerminalAttach> | undefined;
  if (!terminal || typeof terminal.cwd !== 'string') return undefined;
  const message =
    typeof body.message === 'string'
      ? body.message
      : typeof body.detail === 'string'
        ? body.detail
        : 'Sign in to pi in the terminal on the Computer page.';
  return {
    message,
    terminal: {
      cwd: terminal.cwd,
      ...(typeof terminal.user === 'string' ? { user: terminal.user } : {}),
      ...(typeof terminal.preset === 'string' ? { preset: terminal.preset } : {}),
    },
  };
}

const seg = encodeURIComponent;

export const codersQuery = queryOptions({
  queryKey: ['coders'],
  queryFn: () => request<{ agents: CoderAccount[] }>('GET', '/api/v1/coders'),
});

export const startCoderLogin = (agent: CoderAgent) =>
  request<{ login: CoderLogin }>('POST', `/api/v1/coders/${seg(agent)}/login`).then((r) => r.login);

/** pi signs in inside its own terminal UI: the server's 409 says where to open that terminal. */
export interface TerminalLogin {
  message: string;
  terminal: TerminalAttach;
}

/**
 * Starts a sign-in. Codex and Claude Code answer with a login to follow;
 * pi answers 409 `CODER_LOGIN_IN_TERMINAL` with the terminal to open instead.
 */
export async function beginCoderLogin(
  agent: CoderAgent,
): Promise<{ login: CoderLogin } | { terminal: TerminalLogin }> {
  try {
    return { login: await startCoderLogin(agent) };
  } catch (error) {
    const terminal = error instanceof ApiError ? (error as TerminalError).terminal : undefined;
    if (terminal && (error as ApiError).status === 409) return { terminal };
    throw error;
  }
}

/** Asks the agent on the computer whether it is signed in now, and returns the fresh account. */
export const checkCoder = (agent: CoderAgent) =>
  request<{ account: CoderAccount }>('POST', `/api/v1/coders/${seg(agent)}/check`).then(
    (r) => r.account,
  );

export const getCoderLogin = (agent: CoderAgent, loginId: string) =>
  request<{ login: CoderLogin }>('GET', `/api/v1/coders/${seg(agent)}/login/${seg(loginId)}`).then(
    (r) => r.login,
  );

export const sendCoderLoginCode = (agent: CoderAgent, loginId: string, code: string) =>
  request<{ login: CoderLogin }>(
    'POST',
    `/api/v1/coders/${seg(agent)}/login/${seg(loginId)}/code`,
    { code },
  ).then((r) => r.login);

export const cancelCoderLogin = (agent: CoderAgent, loginId: string) =>
  request<void>('DELETE', `/api/v1/coders/${seg(agent)}/login/${seg(loginId)}`);

export const setCoderApiKey = (agent: CoderAgent, providerId: string) =>
  request<{ account: CoderAccount }>('PUT', `/api/v1/coders/${seg(agent)}/api-key`, {
    providerId,
  }).then((r) => r.account);

export const signOutCoder = (agent: CoderAgent) =>
  request<{ account: CoderAccount }>('POST', `/api/v1/coders/${seg(agent)}/sign-out`).then(
    (r) => r.account,
  );

export const codingSessionTerminal = (sessionId: string) =>
  request<TerminalAttach>('GET', `/api/v1/coding-sessions/${seg(sessionId)}/terminal`);

/** The session's full log, as text. */
export async function codingSessionLog(sessionId: string): Promise<string> {
  const response = await fetch(url(`/api/v1/coding-sessions/${seg(sessionId)}/log`), {
    credentials: 'include',
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => undefined)) as Partial<Problem> | undefined;
    throw new ApiError(response.status, problem);
  }
  return response.text();
}

export const reposQuery = queryOptions({
  queryKey: ['repos'],
  queryFn: () => request<{ repos: Repo[] }>('GET', '/api/v1/repos'),
});

export const addRepo = (body: AddRepo) =>
  request<{ repo: Repo }>('POST', '/api/v1/repos', body).then((r) => r.repo);

export const cloneRepo = (id: string) =>
  request<{ repo: Repo }>('POST', `/api/v1/repos/${seg(id)}/clone`).then((r) => r.repo);

export const updateRepo = (id: string) =>
  request<{ repo: Repo }>('POST', `/api/v1/repos/${seg(id)}/update`).then((r) => r.repo);

/** Decides an approval, as the approval widget does (P1). */
export const decideApproval = (id: string, decision: 'approve' | 'deny') =>
  unwrap(
    api.POST('/api/v1/approvals/{id}/decide', { params: { path: { id } }, body: { decision } }),
  ).then(() => undefined);

/** The Computer page's search for a terminal attached to a directory (CA7, I15). */
export function terminalSearch(attach: TerminalAttach): Record<string, string> {
  return {
    cwd: attach.cwd,
    ...(attach.user ? { user: attach.user } : {}),
    ...(attach.preset ? { preset: attach.preset } : {}),
  };
}
