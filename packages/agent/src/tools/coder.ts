import {
  CODER_AGENTS,
  CoderAgentSchema,
  CoderModeSchema,
  type CoderAgent,
  type CoderAuthKind,
  type CoderMode,
} from '@openbots/shared';
import { z } from 'zod';
import { WaitFor } from '../gated.js';
import { defineTool, type AnyAgentTool, type ToolGroup } from './types.js';

// The coder tool group (plan 5.4, I9): `code_task` starts a coding agent on
// one of the owner's repositories and parks the run on the `coding_session`
// widget until the session settles, as `request_login` parks on its sign-in
// request. The server implements `CoderServices`; without them the group
// offers no tools. Each action the agent asks to take inside the session is
// judged by `coderActionDecision` (`@openbots/shared`), not by this group's
// tool decision, which only covers starting the task.

/** A repository the Bot may work on, as context assembly and the tool list it. */
export interface RepoRef {
  id: string;
  /** `owner/name`. */
  full_name: string;
  default_branch: string;
  /** Where it is checked out on the computer, when it is. */
  path?: string;
  description?: string;
  /** The checkout's state: `cloning`, `ready`, `behind`, `dirty`, `missing`, `error`. */
  state?: string;
}

/** A coding agent and how it is signed in on the computer (Settings > Coding agents). */
export interface CoderAccountView {
  agent: CoderAgent;
  authKind: CoderAuthKind;
  /** The account as the agent names it: an email, or the plan. */
  label?: string;
}

export interface CoderStartInput {
  agent: CoderAgent;
  /** A repository's id or its full name. */
  repo: string;
  prompt: string;
  /** The session's branch; the runner names one (`bot/<slug>`) when absent. */
  branch?: string;
  /** What the branch starts from; the repository's default branch when absent. */
  base?: string;
  mode: CoderMode;
  /** A session to continue instead of starting a new one. */
  session_id?: string;
}

export interface CoderStarted {
  sessionId: string;
  /**
   * The widget the run waits on: `coding_session`, or `coder_login` when the
   * agent has to be signed in first (CA3). Absent means `coding_session`.
   */
  kind?: 'coding_session' | 'coder_login';
  /** The posted widget, which the run waits on (`WaitFor`). */
  posted: { messageId: string; partIndex: number };
  /** The activity label: "Coding: openbots-relay with Claude Code". */
  label: string;
  /** The widget's props, as posted. */
  props: unknown;
}

export interface CoderServices {
  /** The Bot's `coder.defaultAgent` (CA9), when the owner set one. */
  defaultAgent?: CoderAgent;
  /** The repositories this Bot may use: the owner's, narrowed by `coder.allowedRepos`. */
  repos(): Promise<RepoRef[]>;
  accounts(): Promise<CoderAccountView[]>;
  /** Inserts or reopens the session, posts its widget and enqueues the runner job. */
  start(input: CoderStartInput): Promise<CoderStarted>;
}

/** The longest task prompt `code_task` takes. */
export const CODE_TASK_PROMPT_MAX = 8_000;

export const CodeTaskInputSchema = z.object({
  agent: CoderAgentSchema.optional().describe(
    'The coding agent: claude (Claude Code), codex (Codex) or pi. Omit to use the default: ' +
      "the Bot's default agent, else the first one signed in",
  ),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The repository, as owner/name from your repositories (or its id)'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(CODE_TASK_PROMPT_MAX)
    .describe(
      'The task for the coding agent, complete on its own: what to change and why, what done ' +
        'looks like, and any constraint the owner gave. The agent sees only this and the repository',
    ),
  mode: CoderModeSchema.optional().describe(
    'plan reads and proposes a plan without changing anything; edit (the default) changes ' +
      'and commits on the branch; pr also pushes and opens a pull request, after the owner approves',
  ),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe('The branch to work on; a new bot/<slug> branch when omitted'),
  base: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("What the branch starts from; the repository's default branch when omitted"),
  session_id: z
    .uuid()
    .optional()
    .describe('An earlier session to continue, from its result, with this prompt as the next turn'),
});
export type CodeTaskInput = z.infer<typeof CodeTaskInputSchema>;

/** The tool's result text when the server offers no coding agents. */
export const CODER_UNAVAILABLE = 'Coding agents are not available on this server';

/**
 * The agent a task runs with when the call names none: the Bot's default,
 * else the first agent signed in on the computer, else Claude Code, whose
 * sign-in the server then asks for.
 */
export async function defaultCoderAgent(services: CoderServices): Promise<CoderAgent> {
  if (services.defaultAgent) return services.defaultAgent;
  const accounts = await services.accounts();
  const signedIn = CODER_AGENTS.find((agent) =>
    accounts.some((a) => a.agent === agent && a.authKind !== 'none'),
  );
  return signedIn ?? 'claude';
}

/** The Bot's repository a call names, by id or full name (any case). */
function findRepo(repos: RepoRef[], name: string): RepoRef | undefined {
  const wanted = name.replace(/\.git$/, '').toLowerCase();
  return repos.find((r) => r.id === name || r.full_name.toLowerCase() === wanted);
}

function unknownRepo(name: string, repos: RepoRef[]): string {
  if (!repos.length) {
    return `Unknown repository ${name}: you have no repositories yet. Ask your owner to add it on the Computer page.`;
  }
  const names = repos.map((r) => r.full_name).join(', ');
  return `Unknown repository ${name}. Your repositories: ${names}.`;
}

export const codeTask = defineTool({
  description:
    'Start a coding agent (Claude Code, Codex or pi) on one of your repositories. Use it for any ' +
    'change to a repository: fixes, features, refactors, tests and reviews. Prefer it to bash ' +
    'and edit_file for repository work. The agent works in its own worktree on a new branch and ' +
    'its progress shows in a coding session card; edits, tests and commits inside the worktree ' +
    'run, while pushing, opening a pull request and riskier commands wait for the owner to ' +
    'approve. The run pauses until the session ends, and the result (summary, branch, changed ' +
    'files, commits, pull request) comes back as this tool result. Modes: plan proposes without ' +
    'changing anything, edit (the default) changes and commits, pr also pushes and opens a pull ' +
    'request. To follow up on a session, call again with its session_id and the next prompt.',
  inputSchema: CodeTaskInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false },
  async execute(args, ctx) {
    const coder = ctx.coder;
    if (!coder) throw new Error(CODER_UNAVAILABLE);
    const repos = await coder.repos();
    const repo = findRepo(repos, args.repo);
    if (!repo) throw new Error(unknownRepo(args.repo, repos));
    const input: CoderStartInput = {
      agent: args.agent ?? (await defaultCoderAgent(coder)),
      repo: repo.full_name,
      prompt: args.prompt,
      mode: args.mode ?? 'edit',
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.base ? { base: args.base } : {}),
      ...(args.session_id ? { session_id: args.session_id } : {}),
    };
    const started = await coder.start(input);
    throw new WaitFor({
      reason: 'widget',
      widget: { kind: started.kind ?? 'coding_session', props: started.props },
      label: started.label,
      posted: started.posted,
    });
  },
});

export const coderTools: ToolGroup = {
  name: 'coder',
  tools: (ctx): Record<string, AnyAgentTool> => (ctx.coder ? { code_task: codeTask } : {}),
};
