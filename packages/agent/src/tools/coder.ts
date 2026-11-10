import {
  normalizeFullName,
  CODER_AGENTS,
  CoderAgentSchema,
  CoderModeSchema,
  CoderModelNameSchema,
  type CoderAgent,
  type CoderAuthKind,
  type CoderMode,
} from '@openbots/shared';
import { validateWidgetProps } from '@openbots/widgets';
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
  /** The owner's default agent (Settings > Coding agents). */
  isDefault?: boolean;
  /** The owner's default model for this agent (Settings > Coding agents). */
  model?: string;
  /** False when this build cannot run the agent; absent means it can. */
  available?: boolean;
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
  /**
   * The model the session runs with, as the agent's CLI names it; kept on
   * the session, so a continued session keeps its own and ignores this.
   */
  model?: string;
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
  /** The Bot's `coder.models` (CA9): a model per agent, where the owner set one. */
  models?: Partial<Record<CoderAgent, string>>;
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
    'The coding agent: claude (Claude Code), codex (Codex) or pi. Only when the owner named ' +
      'one; omit to use their default. With no default set, the owner is asked to choose',
  ),
  model: CoderModelNameSchema.optional().describe(
    "The model, as the agent's CLI names it. Only one the owner named or chose; omit to use " +
      'their default. With no default set, the owner is asked to choose',
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
    .describe(
      'The branch to work on, which must start with bot/; a new bot/<slug> branch when omitted',
    ),
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
 * The agent and model a new task runs with (CA9): what the call names,
 * else the Bot's settings, else the owner's defaults from Settings > Coding
 * agents. Either can be missing, and then `code_task` asks the owner.
 */
export function resolveCoderChoice(
  services: Pick<CoderServices, 'defaultAgent' | 'models'>,
  accounts: readonly CoderAccountView[],
  call: { agent?: CoderAgent; model?: string } = {},
): { agent?: CoderAgent; model?: string } {
  const agent =
    call.agent ?? services.defaultAgent ?? accounts.find((a) => a.isDefault)?.agent ?? undefined;
  if (!agent) return {};
  const model =
    call.model ?? services.models?.[agent] ?? accounts.find((a) => a.agent === agent)?.model;
  return model ? { agent, model } : { agent };
}

/** The agent a continued session's call is sent with; the server keeps the session's own. */
export async function defaultCoderAgent(services: CoderServices): Promise<CoderAgent> {
  if (services.defaultAgent) return services.defaultAgent;
  const accounts = await services.accounts();
  return (
    accounts.find((a) => a.isDefault)?.agent ??
    CODER_AGENTS.find((agent) =>
      accounts.some((a) => a.agent === agent && a.authKind !== 'none'),
    ) ??
    'claude'
  );
}

/** The longest task excerpt the `coder_choice` card shows. */
const EXCERPT_MAX = 300;

/**
 * The `coder_choice` card (CA9) for a task with no agent or model set: every
 * agent this build runs, with whether it is signed in and the model already
 * set for it, the one already named offered first.
 */
export function coderChoiceProps(
  services: Pick<CoderServices, 'models'>,
  accounts: readonly CoderAccountView[],
  chosen: { agent?: CoderAgent },
  task: { repo: string; prompt: string },
): unknown {
  const agents = CODER_AGENTS.flatMap((agent) => {
    const account = accounts.find((a) => a.agent === agent);
    if (account?.available === false) return [];
    const model = services.models?.[agent] ?? account?.model;
    return [
      { agent, signed_in: !!account && account.authKind !== 'none', ...(model ? { model } : {}) },
    ];
  });
  const excerpt = task.prompt.replace(/\s+/g, ' ').trim();
  return {
    agents,
    ...(chosen.agent && agents.some((a) => a.agent === chosen.agent)
      ? { agent: chosen.agent }
      : {}),
    repo: task.repo,
    ...(excerpt
      ? {
          prompt_excerpt:
            excerpt.length > EXCERPT_MAX ? `${excerpt.slice(0, EXCERPT_MAX - 1)}…` : excerpt,
        }
      : {}),
  };
}

/** The Bot's repository a call names, by id or full name (any case). */
function findRepo(repos: RepoRef[], name: string): RepoRef | undefined {
  const wanted = normalizeFullName(name)?.toLowerCase();
  return repos.find((r) => r.id === name || (!!wanted && r.full_name.toLowerCase() === wanted));
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
    let agent: CoderAgent;
    let model: string | undefined;
    if (args.session_id) {
      // A continued session keeps its own agent and model (the server's).
      agent = args.agent ?? (await defaultCoderAgent(coder));
    } else {
      const accounts = await coder.accounts();
      const chosen = resolveCoderChoice(coder, accounts, args);
      if (!chosen.agent || !chosen.model) {
        const props = coderChoiceProps(coder, accounts, chosen, {
          repo: repo.full_name,
          prompt: args.prompt,
        });
        const checked = validateWidgetProps('coder_choice', props);
        if (!checked.ok) throw new Error(checked.error);
        throw new WaitFor({
          reason: 'widget',
          widget: { kind: 'coder_choice', props: checked.value },
          label: 'Waiting for you to choose a coding agent',
        });
      }
      agent = chosen.agent;
      model = chosen.model;
    }
    const input: CoderStartInput = {
      agent,
      ...(model ? { model } : {}),
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
