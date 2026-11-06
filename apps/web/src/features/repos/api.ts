import type {
  CodingRoutineTemplate,
  FoundRepo,
  GitActAs,
  GitConnectionView,
  RemoteRepo,
  RepoRescueResult,
} from '@openbots/shared';
import { unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { request, type Repo } from '../coders/api.js';

// Git connections and remembered repositories, Phase 2 (GH1 to GH6, GH8,
// CA11): the GitHub App, the owner's connections, the repository picker,
// clones found on the computer, rescue before loss, and the coding Routine
// templates. Rescue, scan, forget and the templates go through the generated
// client. The git connection routes and the repository list still go through
// `request` with the shapes typed here, because their answers carry fields
// (`publicUrlOk`, `needsReauthorize`, `Repo.checkout`) that `openapi.json`
// has not caught up with; switch them to `api` once it has.

export type { FoundRepo, GitConnectionView, RemoteRepo, RepoRescueResult };

/** Whether this install has a GitHub App, and where it came from. */
export interface GithubAppStatus {
  configured: boolean;
  /** `config` for GITHUB_APP_* settings, `instance` for one made through the manifest flow. */
  source: 'config' | 'instance' | null;
  slug: string | null;
  /** GET /git-connections/github-app/install leads somewhere. */
  installUrlAvailable: boolean;
  /** POST /git-connections/github-app/manifest may make an App (self-hosted, none yet). */
  manifestAvailable: boolean;
  /** OPENBOTS_PUBLIC_URL is an https URL GitHub can reach; the manifest flow needs it. */
  publicUrlOk: boolean;
}

export type RescueStatus = components['schemas']['RepoRescueStatus'];
export type RepoForgotten = components['schemas']['RepoForgotten'];

/** A sync answer; `needsReauthorize` when GitHub wants the owner to grant access again. */
export interface SyncAnswer {
  connection: GitConnectionView;
  needsReauthorize?: boolean;
}

/** The server's code when "Act as me" needs a GitHub sign-in the owner has not made. */
export const ACT_AS_NEEDS_SIGN_IN = 'ACT_AS_NEEDS_SIGN_IN';

const seg = encodeURIComponent;

export const gitConnectionsQuery = queryOptions({
  queryKey: ['git-connections'],
  queryFn: () =>
    request<{ connections: GitConnectionView[] }>('GET', '/api/v1/git-connections').then(
      (r) => r.connections,
    ),
});

export const githubAppQuery = queryOptions({
  queryKey: ['git-connections', 'github-app'],
  queryFn: () => request<GithubAppStatus>('GET', '/api/v1/git-connections/github-app'),
});

export const remoteReposQuery = (connectionId: string, q: string) =>
  queryOptions({
    queryKey: ['git-connections', connectionId, 'repositories', q],
    queryFn: () =>
      request<{ repositories: RemoteRepo[] }>(
        'GET',
        `/api/v1/git-connections/${seg(connectionId)}/repositories${q ? `?q=${seg(q)}` : ''}`,
      ).then((r) => r.repositories),
  });

/** Where the browser goes to install the App; GitHub sends it back with `?connection=<id>`. */
export const GITHUB_APP_INSTALL_PATH = '/api/v1/git-connections/github-app/install';

/** Starts the manifest flow; `organization` makes the App on that organization instead of the viewer's account. */
export const startAppManifest = (organization?: string) =>
  request<{ url: string; manifest: unknown }>(
    'POST',
    '/api/v1/git-connections/github-app/manifest',
    organization ? { organization } : {},
  );

/**
 * GitHub's manifest flow takes a form POST with one field, `manifest`, the
 * JSON string. GitHub shows its create form, then the server stores the App.
 */
export function submitManifest(url: string, manifest: unknown) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = url;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  form.append(field);
  document.body.append(form);
  form.submit();
}

export const removeGithubApp = () => request<void>('DELETE', '/api/v1/git-connections/github-app');

export const updateConnection = (id: string, actAs: GitActAs) =>
  request<{ connection: GitConnectionView }>('PATCH', `/api/v1/git-connections/${seg(id)}`, {
    actAs,
  }).then((r) => r.connection);

export const syncConnection = (id: string) =>
  request<SyncAnswer>('POST', `/api/v1/git-connections/${seg(id)}/sync`);

/** Where the browser goes so GitHub can refresh what the connection may reach. */
export const reauthorizePath = (id: string) => `/api/v1/git-connections/${seg(id)}/reauthorize`;

export const disconnect = (id: string) =>
  request<void>('DELETE', `/api/v1/git-connections/${seg(id)}`);

export const addTokenConnection = (token: string) =>
  request<{ connection: GitConnectionView }>('POST', '/api/v1/git-connections/token', {
    token,
  }).then((r) => r.connection);

export const rememberRepos = (connectionId: string, fullNames: string[]) =>
  request<{ repos: Repo[] }>('POST', '/api/v1/repos/remember', { fullNames, connectionId }).then(
    (r) => r.repos,
  );

export const foundReposQuery = queryOptions({
  queryKey: ['repos', 'found'],
  queryFn: () => request<{ found: FoundRepo[] }>('GET', '/api/v1/repos/found').then((r) => r.found),
});

export const rememberFound = (path: string) =>
  request<{ repo: Repo }>('POST', '/api/v1/repos/found/remember', { path }).then((r) => r.repo);

/** Starts rescue before loss (GH5); poll `rescueStatus` with the request id until `done`. */
export const startRescue = () => unwrap(api.POST('/api/v1/repos/rescue'));

export const rescueStatus = (requestId: string) =>
  unwrap(api.GET('/api/v1/repos/rescue/{requestId}', { params: { path: { requestId } } }));

export const patchRepo = (id: string, body: { keepCloned?: boolean; pinned?: boolean }) =>
  request<{ repo: Repo }>('PATCH', `/api/v1/repos/${seg(id)}`, body).then((r) => r.repo);

/** Queues a scan for clones nobody remembered; the server answers 202 and `/repos/found` changes later. */
export const scanRepos = () => unwrap(api.POST('/api/v1/repos/scan')).then(() => undefined);

/** Forgets a repository; `note` says what happened to its files on the computer. */
export const forgetRepo = (id: string, deleteFiles: boolean): Promise<RepoForgotten> =>
  unwrap(
    api.DELETE('/api/v1/repos/{id}', {
      params: { path: { id }, query: deleteFiles ? { deleteFiles: 'true' } : {} },
    }),
  );

export const routineTemplatesQuery = queryOptions({
  queryKey: ['routine-templates'],
  queryFn: async () =>
    (await unwrap(api.GET('/api/v1/routines/templates'))).templates as CodingRoutineTemplate[],
  staleTime: Infinity,
});

/** "4 min ago", "3 days ago": how long since an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
