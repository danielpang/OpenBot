import { ApiError, unwrap, type components, type Problem } from '@openbots/api-client';
import type { CoderAgent } from '@openbots/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// Coding agents (CA2, CA3, CA5, CA7): the agents' sign-in state on the
// computer, a sign-in in progress, and what a coding session widget asks of
// the app. Everything goes through the generated client except the two
// helpers that say why.

/** `link`: open a link and paste a code back. `device`: enter a code on the vendor's page. `terminal`: sign in inside the agent's own terminal UI. */
export type CoderSignIn = 'link' | 'device' | 'terminal';

// Local until the client is regenerated: the server's view now carries these three.
export type CoderAccount = components['schemas']['CoderAccount'] & {
  /** Whose plan a subscription sign-in bills, when the agent says. */
  planProvider: 'anthropic' | 'openai' | 'other' | null;
  /** Whether the card offers Check. */
  checkAvailable: boolean;
  signIn: CoderSignIn;
};
export type CoderLogin = components['schemas']['CoderLogin'];
export type CodingSession = components['schemas']['CodingSession'];

/** Where Open terminal attaches: the worktree, the `coder` user, and the command typed there. */
export interface TerminalAttach {
  cwd: string;
  user?: string;
  preset?: string;
}

/** pi signs in inside its own terminal UI: the server's 409 says where to open that terminal. */
export interface TerminalLogin {
  message: string;
  terminal: TerminalAttach;
}

const asAccount = (account: components['schemas']['CoderAccount']) => account as CoderAccount;

const path = (agent: CoderAgent) => ({ params: { path: { agent } } });
const loginPath = (agent: CoderAgent, loginId: string) => ({
  params: { path: { agent, loginId } },
});

export const codersQuery = queryOptions({
  queryKey: ['coders'],
  queryFn: () =>
    unwrap(api.GET('/api/v1/coders')).then((r) => ({ ...r, agents: r.agents.map(asAccount) })),
});

/**
 * Starts a sign-in. Codex and Claude Code answer with a login to follow;
 * pi answers 409 `CODER_LOGIN_IN_TERMINAL` with the terminal to open instead.
 */
export async function beginCoderLogin(
  agent: CoderAgent,
): Promise<{ login: CoderLogin } | { terminal: TerminalLogin }> {
  // Not `unwrap`: it throws a 409 away as an error, and pi's 409 body is the
  // answer here, the terminal to sign in in.
  const { data, error, response } = await api.POST('/api/v1/coders/{agent}/login', path(agent));
  if (data) return { login: data.login };
  const terminal = response.status === 409 ? terminalLogin(error) : undefined;
  if (terminal) return { terminal };
  throw new ApiError(response.status, error as Partial<Problem> | undefined);
}

/** The `{ message, terminal }` of a 409 `CODER_LOGIN_IN_TERMINAL`, when the body is one. */
function terminalLogin(body: unknown): TerminalLogin | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { message, detail, terminal } = body as {
    message?: unknown;
    detail?: unknown;
    terminal?: Partial<Record<keyof TerminalAttach, unknown>>;
  };
  if (!terminal || typeof terminal.cwd !== 'string') return undefined;
  return {
    message:
      typeof message === 'string'
        ? message
        : typeof detail === 'string'
          ? detail
          : 'Sign in to pi in the terminal on the Computer page.',
    terminal: {
      cwd: terminal.cwd,
      ...(typeof terminal.user === 'string' ? { user: terminal.user } : {}),
      ...(typeof terminal.preset === 'string' ? { preset: terminal.preset } : {}),
    },
  };
}

/** Asks the agent on the computer whether it is signed in now, and returns the fresh account. */
export const checkCoder = (agent: CoderAgent) =>
  unwrap(api.POST('/api/v1/coders/{agent}/check', path(agent))).then((r) => asAccount(r.account));

export const getCoderLogin = (agent: CoderAgent, loginId: string) =>
  unwrap(api.GET('/api/v1/coders/{agent}/login/{loginId}', loginPath(agent, loginId))).then(
    (r) => r.login,
  );

export const sendCoderLoginCode = (agent: CoderAgent, loginId: string, code: string) =>
  unwrap(
    api.POST('/api/v1/coders/{agent}/login/{loginId}/code', {
      ...loginPath(agent, loginId),
      body: { code },
    }),
  ).then((r) => r.login);

export const cancelCoderLogin = (agent: CoderAgent, loginId: string) =>
  unwrap(api.DELETE('/api/v1/coders/{agent}/login/{loginId}', loginPath(agent, loginId))).then(
    () => undefined,
  );

export const setCoderApiKey = (agent: CoderAgent, providerId: string) =>
  unwrap(api.PUT('/api/v1/coders/{agent}/api-key', { ...path(agent), body: { providerId } })).then(
    (r) => asAccount(r.account),
  );

export const signOutCoder = (agent: CoderAgent) =>
  unwrap(api.POST('/api/v1/coders/{agent}/sign-out', path(agent))).then((r) =>
    asAccount(r.account),
  );

export const codingSessionTerminal = (id: string): Promise<TerminalAttach> =>
  unwrap(api.GET('/api/v1/coding-sessions/{id}/terminal', { params: { path: { id } } }));

/** The owner's coding sessions for the drawer (CA15), newest first. */
export const codingSessionsQuery = queryOptions({
  queryKey: ['coding-sessions'],
  queryFn: () =>
    unwrap(api.GET('/api/v1/coding-sessions', { params: { query: { limit: 100 } } })).then(
      (r) => r.sessions,
    ),
});

/** The owner's pending approvals; a coding session's carry its `sessionId`. */
export const pendingApprovalsQuery = queryOptions({
  queryKey: ['approvals', 'pending'],
  queryFn: () => unwrap(api.GET('/api/v1/approvals')).then((r) => r.items),
});
export type PendingApproval = components['schemas']['PendingApproval'];

export const stopCodingSession = (id: string) =>
  unwrap(api.POST('/api/v1/coding-sessions/{id}/stop', { params: { path: { id } } })).then(
    (r) => r.session,
  );

/** One page of a session's transcript after `after`, oldest first. */
export const codingSessionEvents = (id: string, after = 0, limit = 200) =>
  unwrap(
    api.GET('/api/v1/coding-sessions/{id}/events', {
      params: { path: { id }, query: { after, limit } },
    }),
  );

/** The owner's next prompt to the agent, once the session has ended. */
export const sendCodingTurn = (id: string, prompt: string, attachments: string[] = []) =>
  unwrap(
    api.POST('/api/v1/coding-sessions/{id}/turns', {
      params: { path: { id } },
      body: { prompt, ...(attachments.length ? { attachments } : {}) },
    }),
  ).then((r) => r.session);

/** The session's full log, as text. */
export async function codingSessionLog(sessionId: string): Promise<string> {
  // Not the generated client: this route answers `text/plain`, and with
  // `parseAs: 'text'` the client reads a failure as text too, which loses
  // the problem document `ApiError` is made from.
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(`/api/v1/coding-sessions/${encodeURIComponent(sessionId)}/log`, origin);
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const problem = (await response.json().catch(() => undefined)) as Partial<Problem> | undefined;
    throw new ApiError(response.status, problem);
  }
  return response.text();
}

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
