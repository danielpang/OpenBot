import { eq } from 'drizzle-orm';
import type { CoderCommit, CoderPublishInput } from '@openbots/shared';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import type { CodingSessionRow } from './coder-state.js';
import { lockDown, runGit, type GitContext, type RepoRow } from './repos-checkout.js';
import { openPullRequest, recordPushedSha } from './session-git.js';

export interface PublishResult {
  url?: string;
  note?: string;
  refused?: string;
}

/** One implementation for the live tool and the end-of-session fallback. No agent credentials. */
export async function publishSessionPullRequest(
  deps: AppDeps,
  input: {
    git: GitContext;
    session: CodingSessionRow;
    repo: RepoRow;
    repoPath: string;
    botName: string;
    summary: string;
    commits: CoderCommit[];
    metadata?: CoderPublishInput;
    githubApi?: string;
    authorize(sha: string): Promise<boolean>;
    refusal(): Promise<string | null>;
    stopped(): boolean;
  },
): Promise<PublishResult> {
  const { session, git, commits } = input;
  if (session.mode === 'plan') return { note: 'Plan-only sessions cannot publish.' };
  if (!commits.length) return { note: 'There are no commits to publish.' };
  let refused = await input.refusal();
  if (refused) return { refused };
  const status = await runGit(git, ['-C', session.worktreePath!, 'status', '--porcelain']);
  if (status.code !== 0 || status.stdout.trim())
    return { note: 'Commit or resolve outstanding changes before publishing.' };
  const head = await runGit(git, ['-C', session.worktreePath!, 'rev-parse', 'HEAD']);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{7,64}$/.test(sha))
    return { note: 'Could not read the commit to publish.' };
  const [saved] = await deps.db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, session.id));
  // Same commit and PR: no second approval, push, or duplicate PR on repeated calls.
  if (saved?.prUrl && saved.pushedSha === sha) return { url: saved.prUrl };
  if (input.stopped() || !(await input.authorize(sha)) || input.stopped()) {
    return {
      note: `The owner did not approve the push, so ${session.branch} is only on the computer.`,
    };
  }
  refused = await input.refusal();
  if (refused) return { refused };
  if (input.stopped()) return { note: 'The session was stopped before publishing.' };
  // Push the exact approved commit to the session's branch. Never set upstream:
  // -u rewrites .git/config and is unnecessary for runner-owned publication.
  const pushed = await runGit(
    git,
    ['-C', session.worktreePath!, 'push', 'origin', `${sha}:refs/heads/${session.branch}`],
    { push: true },
  );
  if (pushed.code !== 0) {
    const why = (pushed.error ?? pushed.stderr).trim().split('\n').filter(Boolean).pop();
    return { note: `The push of ${session.branch} failed: ${why ?? `exit ${pushed.code}`}` };
  }
  await recordPushedSha(deps, session.id, sha);
  // Defensive hygiene after trusted Git commands, never a repair of untrusted ownership.
  await lockDown(git, input.repoPath);
  if (input.stopped())
    return { note: 'The branch was pushed, but the session stopped before creating the PR.' };
  try {
    const url = await openPullRequest(deps, {
      owner: { id: session.ownerId, workspaceId: session.workspaceId },
      repo: input.repo,
      session,
      botName: input.botName,
      summary: input.summary,
      commits,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.githubApi ? { githubApi: input.githubApi } : {}),
      reuseExisting: !!saved?.prUrl,
    });
    await deps.db
      .update(schema.codingSessions)
      .set({ prUrl: url, updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, session.id));
    return { url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { note: `Pushed ${session.branch}, but the pull request was not opened: ${message}` };
  }
}
