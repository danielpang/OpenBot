import { posix } from 'node:path';
import type { CoderChangedFile, CoderCommit } from '@openbots/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../context.js';
import { schema } from '../db/client.js';
import { GITHUB_API } from '../builtins/github.js';
import { createArtifact, writeArtifact } from './artifacts.js';
import type { CoderSessionSpec } from './coder-adapters/types.js';
import type { CodingSessionRow } from './coder-state.js';
import { pullRequestToken } from './git-credentials.js';
import { remoteOf, runGit, type GitContext, type RepoRow } from './repos-checkout.js';

// The runner's own git around a session, once the CLI has ended
// (docs/TECHNICAL_PLAN.md 22.2 step 7 and 22.13): the Bot's git identity, the
// branch's commits and files against its base, the safety-net commit, the
// diff Artifact and the pull request. Every call here runs after
// `assertRunnable` passed on the checkout.

type Owner = { id: string; workspaceId: string };

/** Who a session's commits are by, and the owner credited on each. */
export type SessionIdentity = Pick<CoderSessionSpec, 'gitIdentity' | 'coAuthor'>;

/** A name fit for a git identity or trailer: one line, no angle brackets. */
const identityName = (text: string) =>
  text
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Who the commits are by (GH8), from the owner's git identity
 * (git-identity.ts). By default the Bot is author and committer,
 * `<Bot name> (OpenBots)` at `<bot handle>@openbots.local`, and the owner is
 * credited as co-author with the name and address they saved, else their
 * account's. With `commitAs: 'owner'` the owner is author and committer, and
 * there is no co-author.
 */
export async function sessionIdentity(
  deps: Pick<AppDeps, 'db'>,
  bot: Pick<typeof schema.bots.$inferSelect, 'name' | 'handle'>,
  ownerId: string,
  workspaceId?: string,
): Promise<Required<Pick<SessionIdentity, 'gitIdentity'>> & SessionIdentity> {
  const [owner] = await deps.db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .catch(() => []);
  const [saved] = workspaceId
    ? await deps.db
        .select()
        .from(schema.gitIdentities)
        .where(
          and(
            eq(schema.gitIdentities.ownerId, ownerId),
            eq(schema.gitIdentities.workspaceId, workspaceId),
          ),
        )
        .catch(() => [])
    : [];
  const botIdentity = {
    name: `${identityName(bot.name)} (OpenBots)`,
    email: `${bot.handle}@openbots.local`,
  };
  const email = saved?.email || owner?.email || '';
  const usable = !!email && !/[<>\s]/.test(email);
  const name = identityName(saved?.name || owner?.name || '') || email.split('@')[0] || email;
  if (saved?.commitAs === 'owner') {
    const ownEmail =
      saved.email || (owner && !PLACEHOLDER_EMAIL.test(owner.email) ? owner.email : '');
    if (ownEmail && !/[<>\s]/.test(ownEmail)) {
      return { gitIdentity: { name: name || ownEmail, email: ownEmail } };
    }
  }
  return usable
    ? { gitIdentity: botIdentity, coAuthor: { name, email } }
    : { gitIdentity: botIdentity };
}

/** The Mac app's local owner address: no one on GitHub, so never a commit's author. */
const PLACEHOLDER_EMAIL = /@openbots\.local$/i;

/** What the branch has against its base, from git; empty when git cannot say. */
export async function branchResult(
  git: GitContext,
  worktree: string,
  base: string,
): Promise<{ files: CoderChangedFile[]; commits: CoderCommit[] }> {
  const range = `origin/${base}...HEAD`;
  const [numstat, names, log] = await Promise.all([
    runGit(git, ['-C', worktree, 'diff', '--numstat', range]),
    runGit(git, ['-C', worktree, 'diff', '--name-status', '--no-renames', range]),
    runGit(git, ['-C', worktree, 'log', '--format=%H%x09%s', `origin/${base}..HEAD`]),
  ]);
  const kinds = new Map<string, CoderChangedFile['kind']>();
  if (names.code === 0) {
    for (const line of names.stdout.split('\n')) {
      const [status, file] = line.split('\t');
      if (!status || !file) continue;
      kinds.set(file, status === 'A' ? 'create' : status === 'D' ? 'delete' : 'edit');
    }
  }
  const files: CoderChangedFile[] = [];
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const [added, removed, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      files.push({
        path: file,
        // Binary files show `-`.
        added: Number(added) || 0,
        removed: Number(removed) || 0,
        kind: kinds.get(file) ?? 'edit',
      });
    }
  }
  const commits: CoderCommit[] = [];
  if (log.code === 0) {
    for (const line of log.stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      commits.push({ sha: line.slice(0, tab), title: line.slice(tab + 1) });
    }
  }
  return { files, commits };
}

/**
 * The head of `branch` on the remote, from `git ls-remote` in `dir`: its
 * SHA, null when the remote has no such branch, undefined when git could
 * not say. The exact ref is read: a pattern also matches
 * `refs/heads/<anything>/<branch>`.
 */
export async function remoteHead(
  git: GitContext,
  dir: string,
  branch: string,
): Promise<string | null | undefined> {
  const ref = `refs/heads/${branch}`;
  const listed = await runGit(git, ['-C', dir, 'ls-remote', '--exit-code', 'origin', ref]);
  // `--exit-code`: 2 when nothing matched.
  if (listed.code === 2) return null;
  if (listed.code !== 0) return undefined;
  const head = listed.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, name]) => name?.trim() === ref)?.[0]
    ?.trim();
  return head || null;
}

/** Records the commit the session's branch was pushed at, for Discard's guard. */
export async function recordPushedSha(
  deps: Pick<AppDeps, 'db'>,
  sessionId: string,
  sha: string,
): Promise<void> {
  await deps.db
    .update(schema.codingSessions)
    .set({ pushedSha: sha, updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, sessionId));
}

/**
 * After a session in which the owner approved a push and the agent may
 * have pushed itself: the branch's head on the remote is recorded as the
 * session's `pushed_sha` only when it is a commit the session made, one of
 * `git rev-list origin/<base>..HEAD` in its worktree. Anything else (a head
 * someone else pushed, or the base) leaves `pushed_sha` as it was. Never
 * throws: a failure only keeps Discard from deleting the branch.
 */
export async function recordAgentPush(
  deps: Pick<AppDeps, 'db' | 'logger'>,
  git: GitContext,
  session: Pick<CodingSessionRow, 'id' | 'worktreePath' | 'branch' | 'base'>,
): Promise<string | null> {
  const { worktreePath: wt, branch, base } = session;
  if (!wt || !branch || !base) return null;
  try {
    const head = await remoteHead(git, wt, branch);
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return null;
    const made = await runGit(git, ['-C', wt, 'rev-list', `origin/${base}..HEAD`]);
    if (made.code !== 0 || !made.stdout.split('\n').some((line) => line.trim() === head)) {
      return null;
    }
    await recordPushedSha(deps, session.id, head);
    return head;
  } catch (error) {
    deps.logger.warn({ err: error, sessionId: session.id }, 'the pushed head was not recorded');
    return null;
  }
}

/** The commit message of what a session left uncommitted. */
export const leftoverCommitMessage = (label: string) =>
  `${label}: changes from an OpenBots session`;

/**
 * Files the safety-net commit never adds, since they may hold secrets:
 * matched on the file's name, ignoring case.
 */
const SECRET_FILES = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_rsa/,
  /^id_ed25519/,
  /credentials/,
  /\.secret/,
  /token/,
];

/** Whether a file's name reads like one that holds a secret (SECRET_FILES). */
export function looksSecret(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  return SECRET_FILES.some((pattern) => pattern.test(name));
}

/** What the safety-net commit did. */
export interface LeftoverCommit {
  committed: boolean;
  /** Changed or new files it did not commit; they stay in the worktree. */
  left: string[];
  /** Those of `left` the agent did touch, left out because they may hold secrets. */
  secrets: string[];
}

/**
 * `git status --porcelain -z --untracked-files=all`: every changed, deleted
 * or new path, relative to the worktree (a rename gives both its paths).
 */
export function porcelainPaths(stdout: string): string[] {
  const out: string[] = [];
  const entries = stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') {
      const from = entries[++i];
      if (from) out.push(from);
    }
  }
  return out;
}

/**
 * A path the agent reported changing, relative to the worktree; null when it
 * is not inside it.
 */
export function worktreeRelative(worktree: string, path: string): string | null {
  const root = posix.normalize(worktree).replace(/\/+$/, '');
  const full = posix.normalize(path.startsWith('/') ? path : posix.join(root, path));
  if (!full.startsWith(`${root}/`)) return null;
  return full.slice(root.length + 1);
}

/**
 * The safety net under every `edit` and `pr` session, whatever the agent:
 * what the agent itself changed and left uncommitted (the paths of its
 * `file_change` events, `touched`) is committed by the runner, one commit by
 * the Bot with the owner's `Co-Authored-By` trailer, so the branch, its diff
 * and a pull request carry it. Anything else git reports as changed or new
 * stays uncommitted and is listed, and so is a touched file whose name reads
 * like a secret (`looksSecret`). The worktree is the session's own, so no
 * other session's work is in it; what is listed there came from a command
 * the agent ran, a build or a test. Nothing when the tree is clean. Throws
 * when git fails; the caller logs it and the changes stay.
 */
export async function commitLeftovers(
  git: GitContext,
  worktree: string,
  label: string,
  touched: Iterable<string>,
  { gitIdentity, coAuthor }: SessionIdentity,
): Promise<LeftoverCommit> {
  const status = await runGit(git, [
    '-C',
    worktree,
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || `git status exited ${status.code}`);
  }
  const changed = [...new Set(porcelainPaths(status.stdout))];
  if (!changed.length) return { committed: false, left: [], secrets: [] };
  const mine = new Set(
    [...touched].map((path) => worktreeRelative(worktree, path)).filter((p) => p !== null),
  );
  const secrets = changed.filter((path) => mine.has(path) && looksSecret(path));
  const staged = changed.filter((path) => mine.has(path) && !looksSecret(path));
  const left = changed.filter((path) => !staged.includes(path));
  if (!staged.length) return { committed: false, left, secrets };
  // `-A` with the paths named: their deletions are staged too, and nothing else.
  const added = await runGit(git, [
    '-C',
    worktree,
    'add',
    '-A',
    '--',
    ...staged.map((path) => `:(literal)${path}`),
  ]);
  if (added.code !== 0) throw new Error(added.stderr.trim() || `git add exited ${added.code}`);
  const who = gitIdentity
    ? ['-c', `user.name=${gitIdentity.name}`, '-c', `user.email=${gitIdentity.email}`]
    : [];
  const trailer = coAuthor ? ['-m', `Co-Authored-By: ${coAuthor.name} <${coAuthor.email}>`] : [];
  const committed = await runGit(git, [
    ...who,
    '-C',
    worktree,
    'commit',
    '--no-verify',
    '-m',
    leftoverCommitMessage(label),
    ...trailer,
  ]);
  if (committed.code !== 0) {
    throw new Error(committed.stderr.trim() || `git commit exited ${committed.code}`);
  }
  return { committed: true, left, secrets };
}

/** The most of a branch's diff that goes into its Artifact. */
export const DIFF_MAX_CHARS = 1024 * 1024;
export const DIFF_TRUNCATED = '\n[openbots] The diff is longer than 1 MB; the rest is not shown\n';

/**
 * CA5 View diff: `git diff origin/<base>...HEAD` in the worktree (at most
 * DIFF_MAX_CHARS, then a marker) as a code Artifact of the owner's, by the
 * session's Bot. A continued session's settle writes a new version of the
 * Artifact its last settle made, so they do not pile up; a new one only
 * when that is gone. Null when git or the store says no; the session
 * settles either way. Discard leaves the Artifact.
 */
export async function diffArtifact(
  deps: AppDeps,
  git: GitContext,
  owner: Owner,
  session: CodingSessionRow,
): Promise<string | null> {
  const wt = session.worktreePath;
  if (!wt || !session.base || !session.branch) return null;
  try {
    const diff = await runGit(git, ['-C', wt, 'diff', `origin/${session.base}...HEAD`], {
      headChars: DIFF_MAX_CHARS,
    });
    if (diff.code !== 0 && !diff.truncated) return null;
    const content = diff.truncated ? `${diff.stdout}${DIFF_TRUNCATED}` : diff.stdout;
    const author = session.runId ? { runId: session.runId } : { userId: session.ownerId };
    const previous = session.diffArtifactId;
    if (previous) {
      const updated = await writeArtifact(deps, owner, previous, { content }, author).catch(
        (error: unknown) => {
          deps.logger.info({ err: error, sessionId: session.id }, 'the last diff Artifact is gone');
          return null;
        },
      );
      if (updated) return updated.artifact.id;
    }
    const { artifact } = await createArtifact(
      deps,
      owner,
      {
        title: `Diff: ${session.branch}`,
        kind: 'code',
        botId: session.botId,
        chatId: session.chatId,
        content,
      },
      author,
    );
    return artifact.id;
  } catch (error) {
    deps.logger.warn({ err: error, sessionId: session.id }, 'the diff Artifact was not made');
    return null;
  }
}

/**
 * POST /repos/{owner}/{name}/pulls through the repository's git connection
 * (GH8): the App opens it with an installation token, or the owner with
 * their OAuth token when the connection acts as them; with no connection,
 * the owner's GitHub connector token. Returns the pull request's url.
 */
export async function openPullRequest(
  deps: AppDeps,
  input: {
    owner: Owner;
    repo: RepoRow;
    session: Pick<CodingSessionRow, 'branch' | 'base'>;
    botName: string;
    summary: string;
    commits: CoderCommit[];
    githubApi?: string;
  },
): Promise<string> {
  const { summary, commits, session } = input;
  const { fullName } = remoteOf(input.repo);
  const token = await pullRequestToken(deps, input.owner, fullName);
  if (!token) throw new Error('there is no GitHub token on the Connectors page');
  const [owner, name] = fullName.split('/') as [string, string];
  const firstLine = summary
    .split('\n')
    .find((line) => line.trim())
    ?.trim();
  const title =
    commits.length === 1 || !firstLine
      ? commits[commits.length - 1]!.title
      : firstLine.slice(0, 200);
  const body = `${summary.trim()}\n\nOpened by ${input.botName} with OpenBots`.trim();
  const base = (input.githubApi ?? GITHUB_API).replace(/\/+$/, '');
  const res = await fetch(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'OpenBots',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title, head: session.branch, base: session.base, body }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = (await res.json().catch(() => null)) as {
    html_url?: string;
    message?: string;
  } | null;
  if (!res.ok || !data?.html_url) {
    throw new Error(`GitHub answered ${res.status}: ${data?.message ?? res.statusText}`);
  }
  return data.html_url;
}
