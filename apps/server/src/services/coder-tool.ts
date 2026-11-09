import type { CoderAccountView, CoderServices, RepoRef } from '@openbots/agent';
import { resolveToolPolicy } from '@openbots/shared';
import type { AppDeps, CurrentUser } from '../context.js';
import { listCoderAccounts, toAccountView } from './coder-accounts.js';
import { startCodingSession, type CoderRun } from './coding-sessions.js';
import type { BotRow } from './bots.js';
import { allowedRepos, reposForContext } from './repos.js';

// What `code_task` and context assembly see of coding (docs/TECHNICAL_PLAN.md
// 22.2, 22.7): the Bot's repositories, the signed-in agents, and `start`.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;

/** `ToolContext.coder` for one run. `repos` and `accounts` are one query each and start nothing. */
export function coderServices(deps: AppDeps, run: CoderRun): CoderServices {
  const owner = { id: run.bot.ownerId, workspaceId: run.bot.workspaceId };
  const policy = resolveToolPolicy(run.bot.toolPolicy);
  return {
    ...(policy.coder.defaultAgent ? { defaultAgent: policy.coder.defaultAgent } : {}),
    ...(policy.coder.models ? { models: policy.coder.models } : {}),
    repos: async () => allowedRepos(await reposForContext(deps, owner), policy.coder.allowedRepos),
    accounts: async () => (await listCoderAccounts(deps, owner)).map(toAccountView),
    start: (input) => startCodingSession(deps, run, input),
  };
}

/** What context assembly tells the Bot about coding: its repositories and the agents. */
export async function coderContextFor(
  deps: Pick<AppDeps, 'db'>,
  owner: Owner,
  bot: Pick<BotRow, 'toolPolicy'>,
): Promise<{ repos: RepoRef[]; accounts: CoderAccountView[] }> {
  const policy = resolveToolPolicy(bot.toolPolicy);
  const [repos, accounts] = await Promise.all([
    reposForContext(deps, owner),
    listCoderAccounts(deps, owner),
  ]);
  return {
    repos: allowedRepos(repos, policy.coder.allowedRepos),
    accounts: accounts.map(toAccountView),
  };
}
