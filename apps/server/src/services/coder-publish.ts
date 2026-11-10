import { eq } from 'drizzle-orm';
import type { CoderCommit, CoderPublishInput } from '@openbots/shared';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import type { CodingSessionRow } from './coder-state.js';
import { lockDown, runGit, type GitContext, type RepoRow } from './repos-checkout.js';
import { findOpenPullRequest, openPullRequest, recordPushedSha } from './session-git.js';

export interface PublishResult {
  status: 'published' | 'failed' | 'denied' | 'cancelled' | 'refused';
  sha?: string;
  url?: string;
  note?: string;
  refused?: string;
}

/** One implementation for live tools and final-HEAD reconciliation. No agent credentials. */
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
    signal: AbortSignal;
    authorize(sha: string): Promise<boolean>;
    refusal(): Promise<string | null>;
    stopped(): boolean;
  },
): Promise<PublishResult> {
  const { session, git, commits } = input;
  let sha: string | undefined;
  let pushed = false;
  const cancelled = () => input.signal.aborted || input.stopped();
  const cancellation = (): PublishResult => ({
    status: 'cancelled',
    sha,
    note: pushed
      ? 'The branch was pushed, but publication was cancelled before the PR was confirmed.'
      : 'Publication was cancelled.',
  });
  try {
    if (cancelled()) return cancellation();
    if (session.mode === 'plan')
      return { status: 'denied', note: 'Plan-only sessions cannot publish.' };
    if (!commits.length) return { status: 'failed', note: 'There are no commits to publish.' };
    let refused = await input.refusal();
    if (refused) return { status: 'refused', refused };
    if (cancelled()) return cancellation();
    const status = await runGit(git, ['-C', session.worktreePath!, 'status', '--porcelain'], {
      signal: input.signal,
    });
    if (cancelled()) return cancellation();
    if (status.code !== 0 || status.stdout.trim())
      return { status: 'failed', note: 'Commit or resolve outstanding changes before publishing.' };
    const head = await runGit(git, ['-C', session.worktreePath!, 'rev-parse', 'HEAD'], {
      signal: input.signal,
    });
    if (cancelled()) return cancellation();
    sha = head.stdout.trim();
    if (head.code !== 0 || !/^[0-9a-f]{7,64}$/.test(sha))
      return { status: 'failed', note: 'Could not read the commit to publish.' };
    const [saved] = await deps.db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, session.id));
    const target = {
      owner: { id: session.ownerId, workspaceId: session.workspaceId },
      repo: input.repo,
      session,
      ...(input.githubApi ? { githubApi: input.githubApi } : {}),
      signal: input.signal,
    };
    // A pushed SHA and an old URL are not publication proof. Check the open PR's actual head.
    if (saved?.pushedSha === sha) {
      const existing = await findOpenPullRequest(deps, target);
      if (cancelled()) return cancellation();
      if (existing?.sha === sha) {
        await deps.db
          .update(schema.codingSessions)
          .set({ prUrl: existing.url, updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, session.id));
        return { status: 'published', sha, url: existing.url };
      }
    }
    if (cancelled()) return cancellation();
    const allowed = await input.authorize(sha);
    if (cancelled()) return cancellation();
    if (!allowed)
      return {
        status: 'denied',
        sha,
        note: `Publication of ${session.branch} was not approved. No further automatic publishing will be attempted this turn.`,
      };
    refused = await input.refusal();
    if (refused) return { status: 'refused', sha, refused };
    if (cancelled()) return cancellation();
    // Never -u or force: send only the approved commit, without rewriting config.
    const result = await runGit(
      git,
      ['-C', session.worktreePath!, 'push', 'origin', `${sha}:refs/heads/${session.branch}`],
      { push: true, signal: input.signal },
    );
    if (cancelled()) return cancellation();
    if (result.code !== 0) {
      const why = (result.error ?? result.stderr).trim().split('\n').filter(Boolean).pop();
      return {
        status: 'failed',
        sha,
        note: `The push of ${session.branch} failed: ${why ?? `exit ${result.code}`}`,
      };
    }
    pushed = true;
    await recordPushedSha(deps, session.id, sha);
    await lockDown(git, input.repoPath);
    if (cancelled()) return cancellation();
    const url = await openPullRequest(deps, {
      ...target,
      botName: input.botName,
      summary: input.summary,
      commits,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      reuseExisting: !!saved?.prUrl || saved?.pushedSha === sha,
    });
    if (cancelled()) return cancellation();
    await deps.db
      .update(schema.codingSessions)
      .set({ prUrl: url, updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, session.id));
    return { status: 'published', sha, url };
  } catch (error) {
    if (cancelled()) return cancellation();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      sha,
      note: pushed
        ? `Pushed ${session.branch}, but the pull request was not confirmed: ${message}`
        : `Publication failed: ${message}`,
    };
  }
}
