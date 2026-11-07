import { z } from 'zod';

// Git connections and remembered repositories (GH1 to GH9, CA11; I17 to I19).
// The value sets of `git_connections` and `repo_checkouts.state`, the views
// the Connectors page and the Computer page's Repositories section read, the
// GitHub App's webhook path and events, the repository job intervals, the
// rescue branch naming, and the coding Routine templates.

/**
 * `git_connections.kind`: `app` is an installation of a GitHub App (the
 * managed service's shared App, or a self-hoster's own one made through the
 * manifest flow), `oauth` the owner's sign-in token, `token` a pasted
 * fine-grained token. The App is preferred (GH1).
 */
export const GitConnectionKindSchema = z.enum(['app', 'device', 'oauth', 'token']);
export type GitConnectionKind = z.infer<typeof GitConnectionKindSchema>;

/**
 * `git_connections.act_as` (GH8): `bot` opens pull requests as the App,
 * `owner` as the owner, with the owner's OAuth token.
 */
export const GitActAsSchema = z.enum(['bot', 'owner']);
export type GitActAs = z.infer<typeof GitActAsSchema>;

/**
 * `git_connections.status`: `needs_reinstall` when the App's permissions
 * changed or the installation was suspended, `revoked` when it was removed
 * on GitHub (or the token no longer works), `error` for anything else, in
 * `error`.
 */
export const GitConnectionStatusSchema = z.enum([
  'pending',
  'connected',
  'needs_reinstall',
  'revoked',
  'error',
]);
export type GitConnectionStatus = z.infer<typeof GitConnectionStatusSchema>;

/**
 * `repo_checkouts.state`, from the last fetch on the computer: `cloning` and
 * `updating` while a job runs, `ready`, `behind` (the remote is ahead),
 * `dirty` (local commits or changes not pushed), `missing` (not on this
 * computer, so re-cloned when `keep_cloned`), `error`.
 */
export const RepoCheckoutStateSchema = z.enum([
  'cloning',
  'updating',
  'ready',
  'behind',
  'dirty',
  'missing',
  'error',
]);
export type RepoCheckoutState = z.infer<typeof RepoCheckoutStateSchema>;

/** A git connection as the Connectors page shows it. No secret ever leaves the server. */
export const GitConnectionViewSchema = z.strictObject({
  id: z.uuid(),
  provider: z.literal('github'),
  kind: GitConnectionKindSchema,
  /** Public GitHub App slug for a device-authorized connection's installation link. */
  appSlug: z.string().optional(),
  /** The App installation's id; null for `oauth` and `token`. */
  installationId: z.string().nullable(),
  /** The GitHub user or organization the connection reaches. */
  accountLogin: z.string(),
  accountType: z.enum(['user', 'organization']).nullable(),
  actAs: GitActAsSchema,
  status: GitConnectionStatusSchema,
  /** ISO time of the last repository listing. */
  lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Remembered repositories that came through this connection. */
  repoCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /**
   * ISO time the App connection's repository access was last read with the
   * owner's own GitHub authorization; null for `oauth` and `token`, and for an
   * App connection that must be authorized again before it reaches anything.
   */
  repositoriesSyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type GitConnectionView = z.infer<typeof GitConnectionViewSchema>;

/** A repository the connection can reach, as the picker lists it (GH2). */
export const RemoteRepoSchema = z.strictObject({
  /** `owner/name`. */
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
  /** ISO time of the last push, when GitHub gives one. */
  pushedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Already in the owner's remembered list. */
  remembered: z.boolean(),
});
export type RemoteRepo = z.infer<typeof RemoteRepoSchema>;

/** A clone on the computer that nobody remembered (GH6): "On the computer, not remembered". */
export const FoundRepoSchema = z.strictObject({
  /** Absolute, under /home/bot. */
  path: z.string(),
  /** The `origin` remote's URL. */
  remoteUrl: z.string(),
  /** `owner/name` when the remote is on GitHub, else null. */
  fullName: z.string().nullable(),
});
export type FoundRepo = z.infer<typeof FoundRepoSchema>;

/** What rescue before loss (GH5) did for one remembered repository. */
export const RepoRescueResultSchema = z.strictObject({
  repoId: z.uuid(),
  fullName: z.string(),
  /** The rescue branch pushed to; null when nothing was pushed. */
  branch: z.string().nullable(),
  pushed: z.boolean(),
  /** In plain words: what was saved, or why it could not be. */
  note: z.string(),
});
export type RepoRescueResult = z.infer<typeof RepoRescueResultSchema>;

/** Where the GitHub App delivers its webhooks (I19); unauthenticated, HMAC checked. */
export const GITHUB_APP_WEBHOOK_PATH = '/api/v1/github/app/webhook';

/** The events the App subscribes to, in its manifest (I17). */
export const GITHUB_APP_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'check_run',
  'push',
  'installation',
  'installation_repositories',
] as const;
export type GithubAppEvent = (typeof GITHUB_APP_EVENTS)[number];

/**
 * The events the App's manifest subscribes to (`default_events`). GitHub
 * delivers `installation` and `installation_repositories` to every App
 * without a subscription, and may refuse a manifest that lists them, so they
 * are in `GITHUB_APP_EVENTS` (what the webhook handles) only.
 */
export const GITHUB_APP_MANIFEST_EVENTS = GITHUB_APP_EVENTS.filter(
  (event) => event !== 'installation' && event !== 'installation_repositories',
);

/**
 * One repository an App connection reaches for its owner (H1): the
 * installation's repositories the owner's own GitHub authorization lists,
 * with what the owner may do there. `push` allows a write token.
 */
export const GitConnectionRepoAccessSchema = z.strictObject({
  /** `owner/name`. */
  fullName: z.string(),
  push: z.boolean(),
  admin: z.boolean(),
});
export type GitConnectionRepoAccess = z.infer<typeof GitConnectionRepoAccessSchema>;

/**
 * A repository by its full name on its host: `owner/name`, letters, digits,
 * dots, dashes and underscores. Neither part is dots only, so a path made
 * from it (`~/repos/<owner>/<name>`) stays where it says.
 */
export const REPO_FULL_NAME = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/**
 * `owner/name` as given, trimmed and without a trailing `.git`, or null when
 * it is not one (REPO_FULL_NAME). The case is kept: compare with
 * `toLowerCase()`, as GitHub does.
 */
export function normalizeFullName(raw: string): string | null {
  const name = raw.trim().replace(/\.git$/, '');
  return REPO_FULL_NAME.test(name) ? name : null;
}

/** How often the computer fetches every remembered repository while it is up. */
export const REPO_FETCH_INTERVAL_MS = 15 * 60_000;

/** How deep under /home/bot the scan looks for `.git` directories (GH6). */
export const REPO_SCAN_DEPTH = 3;

/** Rescue branches (GH5) are named this, then the time. */
export const RESCUE_BRANCH_PREFIX = 'openbots/rescue/';

/** `openbots/rescue/2026-11-05T10-30`: the UTC minute, with no colon (git refs allow none). */
export function rescueBranchName(date: Date): string {
  return `${RESCUE_BRANCH_PREFIX}${date.toISOString().slice(0, 16).replace(':', '-')}`;
}

export type CodingRoutineTemplateId =
  'fix-labeled-issues' | 'review-pull-requests' | 'weekly-dependency-update';

/** A template's trigger; the client turns it into a `RoutineTriggerInput`. */
export type CodingRoutineTemplateTrigger =
  | {
      type: 'event';
      source: 'github';
      /** A `GithubEvent`. */
      event: 'label_added' | 'pr_opened';
      /** The label to wait for; `{{label}}` in the prompt is filled with it. */
      label?: string;
    }
  | {
      type: 'schedule';
      preset: 'weekly';
      /** Sunday is 0, as in cron. */
      day: number;
      /** `HH:MM`, 24-hour, in the Routine's timezone. */
      time: string;
    };

export interface CodingRoutineTemplate {
  id: CodingRoutineTemplateId;
  name: string;
  description: string;
  trigger: CodingRoutineTemplateTrigger;
  /**
   * What the Routine asks the Bot. `{{repo}}` is the repository's
   * `owner/name` and `{{label}}` the trigger's label, filled in when the
   * owner picks them.
   */
  prompt: string;
}

/** The three coding Routine templates (CA11), each a GitHub trigger or schedule plus a prompt. */
export const CODING_ROUTINE_TEMPLATES: readonly CodingRoutineTemplate[] = [
  {
    id: 'fix-labeled-issues',
    name: 'Fix issues labeled bot',
    description:
      'When an issue in the repository gets the label, the Bot works on a fix and opens a pull request for you to review.',
    trigger: { type: 'event', source: 'github', event: 'label_added', label: 'bot' },
    prompt:
      'An issue in {{repo}} was labeled {{label}}. Read the issue and its comments, then use code_task in pr mode on {{repo}} to fix it. Keep the change small and add a test when the repository has tests. Open a pull request that links the issue. If the issue is unclear, comment on it with your questions instead of guessing.',
  },
  {
    id: 'review-pull-requests',
    name: 'Review new pull requests',
    description:
      'When a pull request is opened, the Bot reads the change and posts a review with what it found.',
    trigger: { type: 'event', source: 'github', event: 'pr_opened' },
    prompt:
      'A pull request was opened in {{repo}}. Use code_task in plan mode on {{repo}} to check out its branch and review the change: correctness, missing tests, and anything risky. Then post one review comment on the pull request that lists what you found, most important first. Do not push any changes.',
  },
  {
    id: 'weekly-dependency-update',
    name: 'Weekly dependency update',
    description:
      'Every Monday morning, the Bot updates the repository dependencies, runs the tests, and opens a pull request when they pass.',
    trigger: { type: 'schedule', preset: 'weekly', day: 1, time: '09:00' },
    prompt:
      'Use code_task in pr mode on {{repo}} to update its dependencies to the latest versions its version ranges allow. Run the install and the tests. If they pass, open a pull request that lists each updated package. If something breaks, leave that package as it was and say why in the pull request.',
  },
];
