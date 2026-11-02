import { ConnectorNeedsLogin, type GithubApi, type GithubIssueQuery } from '@openbots/agent';

// The GitHub built-in (decision 5 in plan 20, T2): a thin REST client with
// the connector's personal access token, covering issues and pull requests
// (list, get, comment) and opening issues. Anything more is the GitHub MCP
// server's job, which stays in the catalog. Results are trimmed to the fields
// a Bot needs; a 401 means the token is gone or revoked and blocks the Bot
// until the owner replaces it.

export const GITHUB_API = 'https://api.github.com';
const MAX_BODY = 8_000;

export interface GithubOptions {
  baseUrl?: string;
}

type Json = Record<string, unknown>;

const clip = (text: unknown) =>
  typeof text === 'string' && text.length > MAX_BODY
    ? `${text.slice(0, MAX_BODY)}…`
    : (text ?? null);

function issue(raw: Json, withBody: boolean) {
  const labels = (raw.labels as (Json | string)[] | undefined) ?? [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: (raw.user as Json | null)?.login ?? null,
    labels: labels.map((l) => (typeof l === 'string' ? l : l.name)),
    comments: raw.comments,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    url: raw.html_url,
    ...(withBody ? { body: clip(raw.body) } : {}),
  };
}

function pull(raw: Json, withBody: boolean) {
  return {
    ...issue(raw, withBody),
    draft: raw.draft ?? false,
    merged: raw.merged ?? (raw.merged_at ? true : false),
    head: (raw.head as Json | undefined)?.ref ?? null,
    base: (raw.base as Json | undefined)?.ref ?? null,
    ...(withBody
      ? {
          additions: raw.additions,
          deletions: raw.deletions,
          changed_files: raw.changed_files,
          mergeable: raw.mergeable ?? null,
        }
      : {}),
  };
}

export function githubApi(
  token: string,
  connector: { id: string; name: string },
  options: GithubOptions = {},
): GithubApi {
  const base = (options.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'OpenBots',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) {
      throw new ConnectorNeedsLogin(
        connector.id,
        connector.name,
        `GitHub rejected the token for ${connector.name} (401)`,
      );
    }
    const data = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok) {
      const message = typeof data?.message === 'string' ? data.message : res.statusText;
      throw new Error(`GitHub answered ${res.status}: ${message}`);
    }
    return data;
  };
  const repoPath = (repo: string) => {
    const [owner, name] = repo.split('/');
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
  };
  const list = (q: GithubIssueQuery, kind: 'issues' | 'pulls') =>
    request('GET', `${repoPath(q.repo)}/${kind}?state=${q.state}&per_page=${q.limit}`) as Promise<
      Json[]
    >;

  return {
    async listIssues(q) {
      // The issues endpoint lists pull requests too; they have their own tool.
      return (await list(q, 'issues')).filter((i) => !i.pull_request).map((i) => issue(i, false));
    },
    async getIssue(repo, number) {
      return issue((await request('GET', `${repoPath(repo)}/issues/${number}`)) as Json, true);
    },
    async listPullRequests(q) {
      return (await list(q, 'pulls')).map((p) => pull(p, false));
    },
    async getPullRequest(repo, number) {
      return pull((await request('GET', `${repoPath(repo)}/pulls/${number}`)) as Json, true);
    },
    async comment(repo, number, body) {
      const raw = (await request('POST', `${repoPath(repo)}/issues/${number}/comments`, {
        body,
      })) as Json;
      return { id: raw.id, url: raw.html_url };
    },
    async createIssue(repo, input) {
      return issue((await request('POST', `${repoPath(repo)}/issues`, input)) as Json, false);
    },
  };
}
