import { normalizeFullName, type GitConnectionRepoAccess } from '@openbots/shared';
import { z } from 'zod';
import { netFetch } from '../builtins/net.js';
import type { AppDeps } from '../context.js';
import { DomainError } from '../errors.js';
import type { InstallationRepo } from './github-app-types.js';
import { GithubApiError } from './github-app.js';

type Deps = Partial<Pick<AppDeps, 'net'>>;
const githubId = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform(String);
const account = z.object({ id: githubId, login: z.string().min(1) });
const installation = z.object({
  id: githubId,
  app_slug: z.string(),
  suspended_at: z.string().nullable(),
  permissions: z.object({ contents: z.string().optional() }).default({}),
});
const repoSchema = z.object({
  id: githubId,
  full_name: z.string().refine((name) => normalizeFullName(name) === name),
  private: z.boolean(),
  default_branch: z.string().min(1).default('main'),
  description: z.string().nullable().default(null),
  pushed_at: z.string().nullable().default(null),
  permissions: z
    .object({ push: z.boolean().optional(), admin: z.boolean().optional() })
    .default({}),
});

/** Fixed GitHub API origin and no redirects: never send the bearer to a feed/user URL. */
type Budget = { remaining: number; deadline: number };
async function get(deps: Deps, token: string, path: string, budget: Budget): Promise<unknown> {
  if (--budget.remaining < 0 || Date.now() >= budget.deadline)
    throw new DomainError(
      502,
      'GITHUB_ERROR',
      'GitHub repository lookup exceeded its limit. Retry or select fewer repositories.',
    );
  let response: Response;
  try {
    response = await netFetch({ ...deps.net, allowlist: ['api.github.com'], maxRedirects: 0 })(
      `https://api.github.com${path}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'OpenBots',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, budget.deadline - Date.now()))),
      },
    );
  } catch {
    throw new DomainError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached. Try again.');
  }
  if (!response.ok)
    throw new GithubApiError(
      response.status,
      'GitHub did not accept this repository authorization. Reconnect GitHub or check the installation.',
    );
  try {
    return await response.json();
  } catch {
    throw new DomainError(502, 'GITHUB_ERROR', 'GitHub returned an invalid response.');
  }
}

async function pages<T>(
  deps: Deps,
  token: string,
  path: string,
  parse: (json: unknown) => T[],
  budget: Budget,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = parse(await get(deps, token, `${path}?per_page=100&page=${page}`, budget));
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new DomainError(
    502,
    'GITHUB_ERROR',
    'Too many GitHub results. Limit the App to the repositories you need.',
  );
}

/** /user/repos alone includes repositories outside the selected installations.
 * Use /user/installations/{id}/repositories instead: GitHub intersects the
 * App installation and THIS user's access. Do not accept installation IDs
 * or repository lists from the browser, and ignore suspended/other apps.
 */
export async function userAppRepositories(deps: Deps, token: string, appSlug: string) {
  // Bound the complete traversal, not just each page/installation. These calls
  // can happen while an authorization row is locked.
  const budget = { remaining: 128, deadline: Date.now() + 60_000 };
  const user = account.parse(await get(deps, token, '/user', budget));
  const installations = (
    await pages(
      deps,
      token,
      '/user/installations',
      (json) => z.object({ installations: z.array(installation) }).parse(json).installations,
      budget,
    )
  ).filter((i) => i.app_slug === appSlug && i.suspended_at === null);
  const repos = new Map<string, InstallationRepo & GitConnectionRepoAccess>();
  for (const install of installations) {
    const rows = await pages(
      deps,
      token,
      `/user/installations/${install.id}/repositories`,
      (json) => z.object({ repositories: z.array(repoSchema) }).parse(json).repositories,
      budget,
    );
    for (const row of rows) {
      repos.set(row.full_name.toLowerCase(), {
        id: row.id,
        fullName: row.full_name,
        private: row.private,
        defaultBranch: row.default_branch,
        description: row.description,
        pushedAt: row.pushed_at,
        remembered: false,
        push: row.permissions.push === true && install.permissions.contents === 'write',
        admin: row.permissions.admin === true,
      });
    }
  }
  return { user, installed: installations.length > 0, repositories: [...repos.values()] };
}
