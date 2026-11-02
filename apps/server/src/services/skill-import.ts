import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { defuse } from '@openbots/agent';
import { SKILL_CONTENT_MAX, SKILL_NAME_MAX } from '@openbots/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDeps, CurrentUser } from '../context.js';
import { BlockedAddressError, guardedFetch } from '../builtins/net.js';
import { schema } from '../db/client.js';
import { DomainError } from '../errors.js';
import { blockRules, isBlocked, oauthAccessToken, openSecrets, readConfig } from './connectors.js';
import { parseSkillFile, SkillFormatError } from './skill-format.js';
import {
  createImportedSkills,
  libraryRoom,
  skillImportOverLimit,
  uniqueSkillName,
  type SkillOrigin,
  type SkillRecord,
} from './skills.js';

// Importing Skills from GitHub (S3; plan 10.1). The owner pastes a link to a
// SKILL.md, a folder or a whole repository; the server resolves the ref to a
// commit, lists the tree once, and finds every SKILL.md under the link (or
// the one markdown file it names). The preview reads each found file for its
// name and description; the import reads them again at the same commit and
// adds every picked Skill, all or none: its name from the frontmatter (else
// the folder or file name), its content the file's markdown.
//
// Everything is fetched here, never in the browser, and only from GitHub's API
// and raw hosts, through the outbound guard (S-8) with caps on files, bytes
// and time. Public repositories need no token. A private one is read with the
// token of the owner's GitHub connector, built-in or MCP, when there is one.
// Without a token GitHub allows 60 API requests an hour per address, so the
// tree listing and the ref are cached briefly and raw file reads, which do
// not count, carry the rest. Imported text is untrusted (P2): it is defused
// so it cannot pass for a data frame or the owner speaking, no Bot uses it
// until the owner enables it, and wherever it reaches a Bot it says where it
// came from. Nothing from the repository is ever run.

type Owner = Pick<CurrentUser, 'id' | 'workspaceId'>;
type ImportDeps = Pick<AppDeps, 'db' | 'config' | 'logger' | 'net' | 'githubFetch'>;

/** The only hosts an import talks to. */
export const GITHUB_HOSTS = ['api.github.com', 'raw.githubusercontent.com'] as const;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export const IMPORT_LIMITS = {
  /** Skills a preview lists from one link. */
  skillsFound: 50,
  /** The largest SKILL.md read. */
  skillFileBytes: 256 * 1024,
  /** Everything one preview or import reads, tree listing aside. */
  totalBytes: 4 * 1024 * 1024,
  /** The tree listing, which for a large repository is long. */
  treeBytes: 8 * 1024 * 1024,
  /** One preview or import, every request included. */
  timeoutMs: 30_000,
  /** How long a tree listing and a resolved ref are reused. */
  treeCacheMs: 5 * 60_000,
  refCacheMs: 60_000,
} as const;

// --- Links ---------------------------------------------------------------------

export type GithubTarget =
  | { owner: string; repo: string; kind: 'repo' }
  /** `rest` is the ref and the path together; a ref may hold slashes, so the split is found later. */
  | { owner: string; repo: string; kind: 'tree' | 'blob'; rest: string[] };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const invalidUrl = (message: string) => new DomainError(400, 'GITHUB_URL_INVALID', message);

/**
 * A GitHub link as an owner, a repository and what it points at:
 * `github.com/owner/repo`, `…/tree/ref/path` (a folder), `…/blob/ref/path`
 * (a file) or `raw.githubusercontent.com/owner/repo/ref/path`. The scheme may
 * be left out; a query or fragment is ignored.
 */
export function parseGithubUrl(input: string): GithubTarget {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalidUrl('Paste a link to a GitHub repository, folder or SKILL.md file.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidUrl('Paste a link to a GitHub repository, folder or SKILL.md file.');
  }
  const host = url.hostname.toLowerCase();
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw invalidUrl('That link is not a valid GitHub address.');
  }
  if (segments.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\'))) {
    throw invalidUrl('That link is not a valid GitHub address.');
  }
  const [owner = '', rawRepo = '', kind, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');
  const named = () => {
    if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
      throw invalidUrl('That link does not name a GitHub repository (github.com/owner/repo).');
    }
  };
  if (host === 'raw.githubusercontent.com') {
    named();
    // raw links may spell the branch as refs/heads/name.
    const parts = kind === 'refs' && rest[0] === 'heads' ? rest.slice(1) : [kind ?? '', ...rest];
    if (parts.length < 2) throw invalidUrl('That raw link does not name a file.');
    return { owner, repo, kind: 'blob', rest: parts };
  }
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw invalidUrl('Only github.com links can be imported.');
  }
  named();
  if (kind === undefined) return { owner, repo, kind: 'repo' };
  if ((kind === 'tree' || kind === 'blob') && rest.length) return { owner, repo, kind, rest };
  throw invalidUrl(
    'Link a repository, a folder (…/tree/branch/path) or a file (…/blob/branch/path/SKILL.md).',
  );
}

// --- GitHub requests -----------------------------------------------------------

export interface GithubResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  /** The body was cut at `maxBytes`. */
  truncated: boolean;
}

/** One GET to GitHub. The server's goes through `guardedFetch`; tests stand in recorded answers. */
export type GithubFetch = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
  maxBytes: number,
) => Promise<GithubResponse>;

/** The guarded fetch, held to GitHub's hosts on every hop of a redirect. */
export const githubFetch: GithubFetch = (url, init, maxBytes) =>
  guardedFetch(url, { method: 'GET', headers: init.headers }, maxBytes, {
    allowlist: [...GITHUB_HOSTS],
    timeoutMs: init.timeoutMs,
    maxRedirects: 3,
  });

const hostOf = (url: string) => new URL(url).hostname;

/** The commit, tree and files an import reads, with a budget shared by every request. */
class GithubReader {
  private readonly deadline: number;
  private bytes = 0;

  constructor(
    private readonly fetchImpl: GithubFetch,
    readonly owner: string,
    readonly repo: string,
    private token: string | null,
    readonly via: string | null,
  ) {
    this.deadline = Date.now() + IMPORT_LIMITS.timeoutMs;
  }

  get authenticated() {
    return this.token !== null;
  }

  /** Drops the token, after GitHub rejected it, to try the repository as public. */
  anonymous() {
    this.token = null;
  }

  get cacheKey() {
    const who = this.token
      ? createHash('sha256').update(this.token).digest('hex').slice(0, 16)
      : 'anon';
    return `${who}:${this.owner}/${this.repo}`.toLowerCase();
  }

  get repoName() {
    return `${this.owner}/${this.repo}`;
  }

  async get(url: string, accept: string, maxBytes: number): Promise<GithubResponse> {
    if (!(GITHUB_HOSTS as readonly string[]).includes(hostOf(url))) throw hostRefused();
    const timeoutMs = this.deadline - Date.now();
    if (timeoutMs <= 0) throw timedOut();
    const headers: Record<string, string> = {
      accept,
      'user-agent': 'OpenBots',
      'x-github-api-version': '2022-11-28',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(url, { headers, timeoutMs }, maxBytes);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // A redirect off GitHub's hosts, refused by the guard's allowlist.
      if (error instanceof BlockedAddressError) throw hostRefused();
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError' || Date.now() >= this.deadline) {
        throw timedOut();
      }
      throw new DomainError(
        502,
        'GITHUB_UNAVAILABLE',
        `Could not reach GitHub: ${(error as Error).message}`,
      );
    }
  }

  /** An API path, with GitHub's failures as clear errors; 404 and 422 are returned for the caller. */
  async api(path: string, accept = 'application/vnd.github+json', maxBytes = 1024 * 1024) {
    const res = await this.get(`${API}${path}`, accept, maxBytes);
    if (res.status === 404 || res.status === 422 || res.status === 409) return res;
    if (res.status >= 400) throw this.failure(res);
    return res;
  }

  /** The error for a refused request: the rate limit, a rejected token, or GitHub's own message. */
  failure(res: GithubResponse): DomainError {
    const limited =
      (res.status === 403 || res.status === 429) &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
    if (limited) return rateLimited(res.headers, this.authenticated);
    if (res.status === 401) {
      return new DomainError(
        502,
        'GITHUB_TOKEN_REJECTED',
        `GitHub rejected the token of your ${this.via ?? 'GitHub'} connector. Replace it in the connector's settings, then try again.`,
      );
    }
    const message = githubMessage(res.body);
    return new DomainError(
      502,
      'GITHUB_UNAVAILABLE',
      `GitHub answered ${res.status}${message ? `: ${message}` : ''}`,
    );
  }

  /**
   * A file at the commit, at most `maxBytes`. Without a token it comes from
   * raw.githubusercontent.com, which does not count against the API's
   * hourly limit; with one, from the contents API, which reads private
   * repositories.
   */
  async file(sha: string, path: string, maxBytes: number): Promise<Buffer> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = this.token
      ? await this.get(
          `${API}/repos/${this.owner}/${this.repo}/contents/${encoded}?ref=${sha}`,
          'application/vnd.github.raw+json',
          maxBytes,
        )
      : await this.get(`${RAW}/${this.owner}/${this.repo}/${sha}/${encoded}`, '*/*', maxBytes);
    if (res.status >= 400) {
      if (res.status === 404) {
        throw new DomainError(
          404,
          'GITHUB_NOT_FOUND',
          `${path} is not in ${this.repoName} at ${sha.slice(0, 7)}`,
        );
      }
      throw this.failure(res);
    }
    this.bytes += res.body.byteLength;
    if (this.bytes > IMPORT_LIMITS.totalBytes) {
      throw tooLarge(`${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB`);
    }
    return res.body;
  }
}

const hostRefused = () =>
  new DomainError(
    502,
    'GITHUB_HOST_REFUSED',
    `Imports read only from ${GITHUB_HOSTS.join(' and ')}, and GitHub pointed somewhere else.`,
  );

const tooLarge = (cap: string) =>
  new DomainError(
    413,
    'IMPORT_TOO_LARGE',
    `An import reads at most ${cap}. Pick fewer Skills, or link a single folder.`,
  );

const timedOut = () =>
  new DomainError(
    504,
    'GITHUB_TIMEOUT',
    `GitHub took longer than ${IMPORT_LIMITS.timeoutMs / 1000} seconds. Try again, or link a smaller folder.`,
  );

function githubMessage(body: Buffer): string {
  try {
    const data = JSON.parse(body.toString('utf8')) as { message?: unknown };
    return typeof data.message === 'string' ? data.message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

/** "14:05 UTC", with the date when it is not today. */
function utcTime(at: Date): string {
  const time = `${at.toISOString().slice(11, 16)} UTC`;
  const today = new Date().toISOString().slice(0, 10);
  const day = at.toISOString().slice(0, 10);
  return day === today ? time : `${time} on ${day}`;
}

/** GitHub's rate limit as a message with the time it resets. */
export function rateLimited(headers: Headers, authenticated: boolean): DomainError {
  const reset = Number(headers.get('x-ratelimit-reset'));
  const retry = Number(headers.get('retry-after'));
  const at =
    Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000)
      : new Date(Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000);
  const when = `Try again after ${utcTime(at)}`;
  return new DomainError(
    429,
    'GITHUB_RATE_LIMITED',
    authenticated
      ? `GitHub's rate limit for your connector's token is used up. ${when}.`
      : `GitHub allows 60 requests an hour without a token, and they are used up. ${when}, or add the GitHub connector so imports use your token, which allows more.`,
  );
}

// --- Caches --------------------------------------------------------------------

interface Cached<T> {
  at: number;
  value: T;
}

const CACHE_ENTRIES = 100;
const refs = new Map<string, Cached<{ ref: string; sha: string; path: string }>>();
const trees = new Map<string, Cached<Tree>>();

function cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  cache.delete(key);
  return undefined;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** Forgets cached refs and trees; tests start from an empty cache. */
export function clearGithubCache() {
  refs.clear();
  trees.clear();
}

// --- Resolving the link --------------------------------------------------------

const SHA = /^[0-9a-f]{40}$/i;
/** Ref and path splits tried for a link whose branch may hold slashes. */
const MAX_REF_TRIES = 4;

const notFound = (reader: GithubReader) =>
  new DomainError(
    404,
    'GITHUB_NOT_FOUND',
    reader.authenticated
      ? `GitHub found no repository ${reader.repoName} that your ${reader.via ?? 'GitHub'} connector's token can read. Check the link, or give the token read access to the repository's contents.`
      : `GitHub found no public repository ${reader.repoName}. If it is private, add the GitHub connector with a token that can read it, then try again.`,
  );

/** The commit a ref names, or null when there is no such ref. */
async function commitOf(reader: GithubReader, ref: string): Promise<string | null> {
  const encoded = ref.split('/').map(encodeURIComponent).join('/');
  const res = await reader.api(
    `/repos/${reader.owner}/${reader.repo}/commits/${encoded}`,
    'application/vnd.github.sha',
    4096,
  );
  if (res.status === 409) {
    throw new DomainError(404, 'GITHUB_NOT_FOUND', `${reader.repoName} is empty`);
  }
  // GitHub answers 404 for a repository that is missing or private to this
  // caller, and 422 for a ref the repository does not have.
  if (res.status === 404) throw notFound(reader);
  if (res.status === 422) return null;
  const sha = res.body.toString('utf8').trim();
  if (!SHA.test(sha)) throw reader.failure({ ...res, status: 502 });
  return sha.toLowerCase();
}

/** The link's ref as a commit, and the path within the repository. */
async function resolveRef(
  reader: GithubReader,
  target: GithubTarget,
): Promise<{ ref: string; sha: string; path: string }> {
  const key = `${reader.cacheKey}:${target.kind === 'repo' ? '' : target.rest.join('/')}`;
  const hit = cached(refs, key, IMPORT_LIMITS.refCacheMs);
  if (hit) return hit;
  let found: { ref: string; sha: string; path: string } | null = null;
  if (target.kind === 'repo') {
    const ref = await defaultBranch(reader);
    const sha = await commitOf(reader, ref);
    if (sha) found = { ref, sha, path: '' };
  } else if (SHA.test(target.rest[0]!)) {
    const sha = await commitOf(reader, target.rest[0]!);
    if (sha) found = { ref: sha, sha, path: target.rest.slice(1).join('/') };
  } else {
    const tries = Math.min(MAX_REF_TRIES, target.rest.length);
    for (let n = 1; n <= tries && !found; n++) {
      const ref = target.rest.slice(0, n).join('/');
      const sha = await commitOf(reader, ref);
      if (sha) found = { ref, sha, path: target.rest.slice(n).join('/') };
    }
  }
  if (!found) {
    const asked = target.kind === 'repo' ? 'HEAD' : target.rest[0];
    throw new DomainError(
      404,
      'GITHUB_NOT_FOUND',
      `${reader.repoName} has no branch, tag or commit named ${asked}`,
    );
  }
  remember(refs, key, found);
  return found;
}

async function defaultBranch(reader: GithubReader): Promise<string> {
  const res = await reader.api(`/repos/${reader.owner}/${reader.repo}`, undefined, 256 * 1024);
  if (res.status === 404) throw notFound(reader);
  if (res.status >= 400) throw reader.failure(res);
  try {
    const data = JSON.parse(res.body.toString('utf8')) as { default_branch?: unknown };
    return typeof data.default_branch === 'string' ? data.default_branch : 'HEAD';
  } catch {
    return 'HEAD';
  }
}

// --- The tree and the Skills in it ---------------------------------------------

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number;
}

export interface Tree {
  entries: TreeEntry[];
  /** GitHub listed only part of a very large repository. */
  truncated: boolean;
}

// What the repository says is untrusted (P2): a path may hold a newline that
// would start a line of its own in text a Bot reads, or a bidi override that
// shows the owner something else. Such paths are left out of the tree, and
// imported content and names lose those characters.
const MAX_PATH = 500;
// Control characters are what these match, on purpose.
/* eslint-disable no-control-regex */
const UNSAFE_PATH =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/** A path the import will list or read: short, without control or bidi characters. */
export const safePath = (path: string) => path.length <= MAX_PATH && !UNSAFE_PATH.test(path);

/** Imported text without hidden control and bidi characters, defused like other framed data. */
export const cleanText = (text: string) => defuse(text.replace(HIDDEN, ''));

/** A name from a repository (or typed over one) on one line, defused. */
export const cleanName = (name: string) =>
  cleanText(name.replace(new RegExp(UNSAFE_PATH.source, 'g'), ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SKILL_NAME_MAX)
    .trim();

async function treeAt(reader: GithubReader, sha: string): Promise<Tree> {
  const key = `${reader.cacheKey}@${sha}`;
  const hit = cached(trees, key, IMPORT_LIMITS.treeCacheMs);
  if (hit) return hit;
  const res = await reader.api(
    `/repos/${reader.owner}/${reader.repo}/git/trees/${sha}?recursive=1`,
    undefined,
    IMPORT_LIMITS.treeBytes,
  );
  if (res.status >= 400) {
    throw new DomainError(
      404,
      'GITHUB_NOT_FOUND',
      `${reader.repoName} has no commit ${sha.slice(0, 7)}`,
    );
  }
  if (res.truncated) {
    throw new DomainError(
      413,
      'IMPORT_TOO_LARGE',
      `${reader.repoName} is too large to list. Link the folder that holds the Skills instead.`,
    );
  }
  const data = JSON.parse(res.body.toString('utf8')) as {
    tree?: { path?: unknown; type?: unknown; size?: unknown }[];
    truncated?: unknown;
  };
  const tree: Tree = {
    entries: (data.tree ?? []).flatMap((e) =>
      typeof e.path === 'string' && (e.type === 'blob' || e.type === 'tree') && safePath(e.path)
        ? [{ path: e.path, type: e.type, size: typeof e.size === 'number' ? e.size : 0 }]
        : [],
    ),
    truncated: data.truncated === true,
  };
  remember(trees, key, tree);
  return tree;
}

const SKILL_FILE = /^skill\.md$/i;
const MARKDOWN = /\.(md|markdown)$/i;
/** Never read: hidden files and folders, dependencies. */
const ignored = (path: string) =>
  path.split('/').some((part) => part.startsWith('.') || part === 'node_modules');

/** A Skill file found in the tree. */
export interface FoundSkill {
  /** The Skill's file in the repository. */
  path: string;
  /** Its folder ('' at the root); only a SKILL.md brings a folder, which names it. */
  folder: string | null;
}

const folderOf = (path: string) => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};
const under = (path: string, folder: string) => !folder || path.startsWith(`${folder}/`);

/** The Skill a file is. */
const skillAt = (path: string): FoundSkill => ({
  path,
  folder: SKILL_FILE.test(posix.basename(path)) ? folderOf(path) : null,
});

/**
 * The Skills a link points at: the file it names, or every SKILL.md under
 * the folder, at most `IMPORT_LIMITS.skillsFound`.
 */
export function findSkills(
  tree: Tree,
  path: string,
  repoName: string,
): { found: FoundSkill[]; more: boolean } {
  const skillFiles = tree.entries
    .filter((e) => e.type === 'blob' && SKILL_FILE.test(posix.basename(e.path)) && !ignored(e.path))
    .map((e) => e.path)
    .sort();
  const entry = path ? tree.entries.find((e) => e.path === path) : { type: 'tree' as const };
  if (!entry) {
    throw new DomainError(404, 'GITHUB_NOT_FOUND', `${repoName} has no file or folder ${path}`);
  }
  if (entry.type === 'blob') {
    if (!MARKDOWN.test(path)) {
      throw new DomainError(
        400,
        'NOT_A_SKILL',
        `${posix.basename(path)} is not a markdown file. Link a SKILL.md, or the folder that holds it.`,
      );
    }
    return { found: [skillAt(path)], more: false };
  }
  const inside = skillFiles.filter((p) => under(p, path));
  return {
    found: inside.slice(0, IMPORT_LIMITS.skillsFound).map(skillAt),
    more: inside.length > IMPORT_LIMITS.skillsFound,
  };
}

// --- The owner's token ---------------------------------------------------------

/**
 * The token of the owner's GitHub connector, for private repositories: the
 * built-in's personal access token, else the GitHub MCP connector's token or
 * OAuth sign-in. A connector an admin blocked, or whose token cannot be read,
 * is passed over.
 */
export async function githubToken(
  deps: ImportDeps,
  owner: Owner,
): Promise<{ token: string; connector: string } | null> {
  const rows = await deps.db
    .select()
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.ownerId, owner.id),
        eq(schema.connectors.workspaceId, owner.workspaceId),
        inArray(schema.connectors.kind, ['builtin', 'mcp_http']),
      ),
    );
  const rules = await blockRules(deps.db, owner.workspaceId);
  const candidates = rows
    .flatMap((row) => {
      let stored;
      try {
        stored = readConfig(row);
      } catch {
        return [];
      }
      const transport = stored.transport;
      if (isBlocked(row, rules)) return [];
      if (transport.transport === 'builtin' && transport.builtin === 'github') {
        return [{ row, rank: 0, secret: 'GITHUB_TOKEN', oauth: false }];
      }
      if (transport.transport === 'http' && row.catalogId === 'github') {
        return [
          {
            row,
            rank: 1,
            secret: transport.bearerSecret ?? 'GITHUB_PERSONAL_ACCESS_TOKEN',
            oauth: transport.auth === 'oauth',
          },
        ];
      }
      return [];
    })
    .sort((a, b) => a.rank - b.rank);
  for (const { row, secret, oauth } of candidates) {
    try {
      const token = oauth
        ? await oauthAccessToken(deps, row.id)
        : openSecrets(deps, row).values[secret];
      if (token) return { token, connector: row.name };
    } catch (error) {
      deps.logger.warn({ err: error, connectorId: row.id }, 'GitHub connector token unreadable');
    }
  }
  return null;
}

// --- Preview -------------------------------------------------------------------

export interface ImportSource {
  url: string;
  repo: string;
  ref: string;
  sha: string;
  path: string;
}

export interface PreviewSkill {
  path: string;
  name: string;
  /** The name it would get: `name`, suffixed when the library or an earlier one has it. */
  suggestedName: string;
  description: string;
  /** Why it cannot be imported; null when it can. */
  error: string | null;
}

export interface ImportPreview {
  source: ImportSource;
  skills: PreviewSkill[];
  /** More Skills were found than a preview lists. */
  more: boolean;
  /** Imported with the owner's connector token. */
  authenticated: boolean;
  /** Skills the library has room for. */
  room: number;
  limit: number;
}

/** A reader for the link's repository, with the owner's token when they have one. */
async function open(deps: ImportDeps, owner: Owner, url: string) {
  const target = parseGithubUrl(url);
  const auth = await githubToken(deps, owner);
  const reader = new GithubReader(
    deps.githubFetch ?? githubFetch,
    target.owner,
    target.repo,
    auth?.token ?? null,
    auth?.connector ?? null,
  );
  return { target, reader };
}

/**
 * Runs `fn`, and once more without the token when GitHub rejects it, so a
 * revoked token does not stop a public import. When the repository is not
 * public either, the rejected token is the error that explains it.
 */
async function tokenOptional<T>(reader: GithubReader, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof DomainError && error.code === 'GITHUB_TOKEN_REJECTED')) throw error;
    reader.anonymous();
    try {
      return await fn();
    } catch (retry) {
      throw retry instanceof DomainError && retry.code === 'GITHUB_NOT_FOUND' ? error : retry;
    }
  }
}

const MAX_READS = 6;

/** Runs `fn` over `items`, `MAX_READS` at a time, in order. */
async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += MAX_READS) {
    out.push(...(await Promise.all(items.slice(i, i + MAX_READS).map(fn))));
  }
  return out;
}

/** The name a Skill falls back to: its folder's, or its file's without `.md`. */
function fallbackName(found: FoundSkill, repo: string): string {
  if (found.folder !== null) return posix.basename(found.folder) || repo;
  return posix.basename(found.path).replace(MARKDOWN, '') || repo;
}

/** What the link holds (S3): each Skill found, with its name and description, before importing. */
export async function previewSkillImport(
  deps: ImportDeps,
  owner: Owner,
  url: string,
): Promise<ImportPreview> {
  const { target, reader } = await open(deps, owner, url);
  const { ref, sha, path, tree } = await tokenOptional(reader, async () => {
    const resolved = await resolveRef(reader, target);
    return { ...resolved, tree: await treeAt(reader, resolved.sha) };
  });
  const { found, more } = findSkills(tree, path, reader.repoName);
  const library = await libraryRoom(deps, owner);
  const taken = new Set(library.names.map((n) => n.toLowerCase()));
  const read = await inBatches(found, async (skill) => {
    try {
      const parsed = parseSkillFile(await readSkillFile(reader, sha, skill.path));
      return { parsed, error: tooLong(skill.path, parsed.content) };
    } catch (error) {
      if (error instanceof SkillFormatError) return { parsed: null, error: error.message };
      if (error instanceof DomainError && error.code === 'SKILL_FILE_TOO_LARGE') {
        return { parsed: null, error: error.message };
      }
      throw error;
    }
  });
  const skills = found.map((skill, i): PreviewSkill => {
    const { parsed, error } = read[i]!;
    const name = cleanName(parsed?.name || fallbackName(skill, reader.repo)) || reader.repo;
    const suggestedName = uniqueSkillName(name, taken);
    if (!error) taken.add(suggestedName.toLowerCase());
    return {
      path: skill.path,
      name,
      suggestedName,
      description: parsed?.description ?? '',
      error,
    };
  });
  return {
    source: { url: url.trim(), repo: reader.repoName, ref, sha, path },
    skills,
    more,
    authenticated: reader.authenticated,
    room: library.room,
    limit: library.limit,
  };
}

// --- Import --------------------------------------------------------------------

const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text, or null for anything binary (a NUL byte or invalid UTF-8). */
export function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Why content is too long for a Skill; null when it fits. */
function tooLong(path: string, content: string): string | null {
  return content.length > SKILL_CONTENT_MAX
    ? `${posix.basename(path)} is longer than ${SKILL_CONTENT_MAX.toLocaleString('en-US')} characters`
    : null;
}

async function readSkillFile(reader: GithubReader, sha: string, path: string): Promise<string> {
  const bytes = await reader.file(sha, path, IMPORT_LIMITS.skillFileBytes + 1);
  if (bytes.byteLength > IMPORT_LIMITS.skillFileBytes) {
    throw new DomainError(
      413,
      'SKILL_FILE_TOO_LARGE',
      `${posix.basename(path)} is larger than ${IMPORT_LIMITS.skillFileBytes / 1024} KB`,
    );
  }
  const text = textOf(bytes);
  if (text === null) throw new SkillFormatError(`${posix.basename(path)} is not a text file`);
  return text;
}

export interface ImportRequest {
  url: string;
  ref: string;
  sha: string;
  skills: { path: string; name: string }[];
}

export interface ImportedSkill {
  record: SkillRecord;
  path: string;
}

/** Reads one picked Skill at the commit: its name, content and origin. */
async function readSkill(
  reader: GithubReader,
  request: ImportRequest,
  found: FoundSkill,
  name: string,
): Promise<{ name: string; content: string; origin: SkillOrigin }> {
  const notASkill = (message: string) =>
    new DomainError(400, 'NOT_A_SKILL', `${found.path}: ${message}`);
  let parsed;
  try {
    parsed = parseSkillFile(await readSkillFile(reader, request.sha, found.path));
  } catch (error) {
    if (error instanceof SkillFormatError) throw notASkill(error.message);
    throw error;
  }
  const long = tooLong(found.path, parsed.content);
  if (long) throw new DomainError(400, 'NOT_A_SKILL', long);
  const origin: SkillOrigin = {
    kind: 'github',
    url: request.url.trim(),
    permalink: `https://github.com/${reader.owner}/${reader.repo}/blob/${request.sha}/${found.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
    repo: reader.repoName,
    ref: request.ref,
    sha: request.sha,
    path: found.path,
    license: parsed.license,
    importedAt: new Date().toISOString(),
  };
  const chosen = cleanName(name) || cleanName(parsed.name || fallbackName(found, reader.repo));
  return { name: chosen || reader.repo, content: cleanText(parsed.content), origin };
}

/**
 * Imports the picked Skills at the previewed commit (S3). The
 * limit is checked before anything is read, and again as they are added,
 * all or none.
 */
export async function importSkillsFromGithub(
  deps: ImportDeps,
  owner: Owner,
  request: ImportRequest,
): Promise<ImportedSkill[]> {
  const library = await libraryRoom(deps, owner);
  if (request.skills.length > library.room) {
    throw skillImportOverLimit(request.skills.length, library.limit, library.room, deps.config);
  }
  const { reader } = await open(deps, owner, request.url);
  const sha = request.sha.toLowerCase();
  const tree = await tokenOptional(reader, () => treeAt(reader, sha));
  const picked = request.skills.map((s) => {
    const entry = tree.entries.find((e) => e.path === s.path && e.type === 'blob');
    if (!entry || !MARKDOWN.test(s.path) || ignored(s.path)) {
      throw new DomainError(
        400,
        'NOT_A_SKILL',
        `${s.path} is not a Skill in ${reader.repoName} at ${sha.slice(0, 7)}`,
      );
    }
    return { found: skillAt(s.path), name: s.name };
  });
  if (new Set(picked.map((p) => p.found.path)).size !== picked.length) {
    throw new DomainError(400, 'NOT_A_SKILL', 'The same Skill is picked twice');
  }
  const read: Awaited<ReturnType<typeof readSkill>>[] = [];
  for (const { found, name } of picked) {
    read.push(await readSkill(reader, { ...request, sha }, found, name));
  }
  const records = await createImportedSkills(deps, owner, read);
  return records.map((record, i) => ({ record, path: picked[i]!.found.path }));
}
