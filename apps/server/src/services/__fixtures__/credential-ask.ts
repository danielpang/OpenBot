import type { CredentialAsk } from '../git-credentials.js';

// The git credential tests' request: a fetch of one repository from inside
// a coding session that may not push yet, with what each test changes.

export interface CredentialAskBase {
  repoFullName?: string;
  /** git's path; `<repoFullName lower case>.git` by default. */
  path?: string;
  sessionId?: string;
}

/**
 * A builder of `CredentialAsk`s for one owner. `owner` is read on every
 * call, so it may be filled in a `beforeAll`.
 */
export function credentialAsk(
  owner: () => { ownerId: string; workspaceId: string },
  { repoFullName = 'acme/relay', path, sessionId = 'session-0001' }: CredentialAskBase = {},
): (over?: Partial<CredentialAsk>) => CredentialAsk {
  return (over = {}) => ({
    ...owner(),
    host: 'github.com',
    path: path ?? `${repoFullName.toLowerCase()}.git`,
    username: 'fetch',
    sessionId,
    session: { pushAllowed: false, repoFullName },
    ...over,
  });
}
