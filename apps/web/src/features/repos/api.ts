import type {
  FoundRepo,
  GitActAs,
  GitConnectionView,
  RemoteRepo,
  RepoCheckoutState,
  RepoRescueResult,
} from '@openbots/shared';
import { unwrap, type components } from '@openbots/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../app/api.js';

// Remembered repositories and git connections (GH1 to GH6, GH8): the
// repository list and its checkouts on the computer, the GitHub App, the
// owner's connections, the repository picker, clones found on the computer,
// and rescue before loss.

export type { FoundRepo, GitConnectionView, RemoteRepo, RepoRescueResult };

/** A repository's checkout on the computer; `state` is the shared union, a plain string in `openapi.json`. */
export type RepoCheckout = Omit<NonNullable<components['schemas']['RepoCheckout']>, 'state'> & {
  state: RepoCheckoutState;
};
export type Repo = Omit<components['schemas']['Repo'], 'checkout'> & {
  checkout: RepoCheckout | null;
};
export type AddRepo = components['schemas']['RepoInput'];

/** Whether this install has a GitHub App, and where it came from. */
export type GithubAppStatus = components['schemas']['GithubAppStatus'];
export type GitDeviceStart = components['schemas']['GitDeviceStart'];
export type GitDeviceInput = components['schemas']['GitDeviceInput'];
export type RescueStatus = components['schemas']['RepoRescueStatus'];
export type RepoForgotten = components['schemas']['RepoForgotten'];
/** A sync answer; `needsReauthorize` when GitHub wants the owner to grant access again. */
export type SyncAnswer = components['schemas']['GitConnectionSync'];

const byId = (id: string) => ({ params: { path: { id } } });
const asRepo = (repo: components['schemas']['Repo']) => repo as Repo;

export const reposQuery = queryOptions({
  queryKey: ['repos'],
  queryFn: () => unwrap(api.GET('/api/v1/repos')).then((r) => ({ repos: r.repos.map(asRepo) })),
});

export const addRepo = (body: AddRepo) =>
  unwrap(api.POST('/api/v1/repos', { body })).then((r) => asRepo(r.repo));

export const cloneRepo = (id: string) =>
  unwrap(api.POST('/api/v1/repos/{id}/clone', byId(id))).then((r) => asRepo(r.repo));

export const updateRepo = (id: string) =>
  unwrap(api.POST('/api/v1/repos/{id}/update', byId(id))).then((r) => asRepo(r.repo));

/** The server's code when "Act as me" needs a GitHub sign-in the owner has not made. */
export const ACT_AS_NEEDS_SIGN_IN = 'ACT_AS_NEEDS_SIGN_IN';

export const gitConnectionsQuery = queryOptions({
  queryKey: ['git-connections'],
  queryFn: () => unwrap(api.GET('/api/v1/git-connections')).then((r) => r.connections),
});

export const githubAppQuery = queryOptions({
  queryKey: ['git-connections', 'github-app'],
  queryFn: () => unwrap(api.GET('/api/v1/git-connections/github-app')),
});

export const remoteReposQuery = (connectionId: string, q: string) =>
  queryOptions({
    queryKey: ['git-connections', connectionId, 'repositories', q],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/git-connections/{id}/repositories', {
          params: { path: { id: connectionId }, query: q ? { q } : {} },
        }),
      ).then((r) => r.repositories),
  });

/** Where the browser goes to install the App; GitHub sends it back with `?connection=<id>`. */
export const GITHUB_APP_INSTALL_PATH = '/api/v1/git-connections/github-app/install';

export const startGitDevice = (body: GitDeviceInput = {}) =>
  unwrap(api.POST('/api/v1/git-connections/github-app/device', { body }));

export const pollGitDevice = (id: string) =>
  unwrap(api.POST('/api/v1/git-connections/{id}/device', byId(id)));

/** Starts the manifest flow; `organization` makes the App on that organization instead of the viewer's account. */
export const startAppManifest = (organization?: string) =>
  unwrap(
    api.POST('/api/v1/git-connections/github-app/manifest', {
      body: organization ? { organization } : {},
    }),
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

export const removeGithubApp = () =>
  unwrap(api.DELETE('/api/v1/git-connections/github-app')).then(() => undefined);

export const updateConnection = (id: string, actAs: GitActAs) =>
  unwrap(api.PATCH('/api/v1/git-connections/{id}', { ...byId(id), body: { actAs } })).then(
    (r) => r.connection,
  );

export const syncConnection = (id: string) =>
  unwrap(api.POST('/api/v1/git-connections/{id}/sync', byId(id)));

/** Where the browser goes so GitHub can refresh what the connection may reach. */
export const reauthorizePath = (id: string) =>
  `/api/v1/git-connections/${encodeURIComponent(id)}/reauthorize`;

export const disconnect = (id: string) =>
  unwrap(api.DELETE('/api/v1/git-connections/{id}', byId(id))).then(() => undefined);

export const addTokenConnection = (token: string) =>
  unwrap(api.POST('/api/v1/git-connections/token', { body: { token } })).then((r) => r.connection);

export const rememberRepos = (connectionId: string, fullNames: string[]) =>
  unwrap(api.POST('/api/v1/repos/remember', { body: { fullNames, connectionId } })).then((r) =>
    r.repos.map(asRepo),
  );

export const foundReposQuery = queryOptions({
  queryKey: ['repos', 'found'],
  queryFn: () => unwrap(api.GET('/api/v1/repos/found')).then((r) => r.found),
});

export const rememberFound = (path: string) =>
  unwrap(api.POST('/api/v1/repos/found/remember', { body: { path } })).then((r) => asRepo(r.repo));

/** Starts rescue before loss (GH5); poll `rescueStatus` with the request id until `done`. */
export const startRescue = () => unwrap(api.POST('/api/v1/repos/rescue'));

export const rescueStatus = (requestId: string) =>
  unwrap(api.GET('/api/v1/repos/rescue/{requestId}', { params: { path: { requestId } } }));

export const patchRepo = (id: string, body: components['schemas']['RepoPatch']) =>
  unwrap(api.PATCH('/api/v1/repos/{id}', { ...byId(id), body })).then((r) => asRepo(r.repo));

/** Queues a scan for clones nobody remembered; the server answers 202 and `/repos/found` changes later. */
export const scanRepos = () => unwrap(api.POST('/api/v1/repos/scan')).then(() => undefined);

/** Forgets a repository; `note` says what happened to its files on the computer. */
export const forgetRepo = (id: string, deleteFiles: boolean): Promise<RepoForgotten> =>
  unwrap(
    api.DELETE('/api/v1/repos/{id}', {
      params: { path: { id }, query: deleteFiles ? { deleteFiles: 'true' } : {} },
    }),
  );

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
