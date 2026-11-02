import type { components } from '@openbots/api-client';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { capabilitiesQuery } from './api.js';

// What kind of install the server is (OPENBOTS_DEPLOYMENT, in
// /api/v1/capabilities). Self-hosted, the default, is one person's: one
// account, its owner, so there is no Admin or Audit log tab, no invites or
// members, and no "admin" wording. The managed OpenBots service keeps all of
// it. The owner is an admin internally, so role checks still pass for them.

export type Deployment = components['schemas']['Capabilities']['deployment'];

type Capabilities = components['schemas']['Capabilities'];

const deploymentOf = (capabilities: Capabilities | undefined): Deployment =>
  capabilities?.deployment ?? 'self_hosted';

/**
 * The deployment, for route guards. Loads the capabilities once; a server
 * that cannot be asked counts as self-hosted, so nothing admin shows by mistake.
 */
export async function loadDeployment(queryClient: QueryClient): Promise<Deployment> {
  try {
    return deploymentOf(await queryClient.ensureQueryData(capabilitiesQuery));
  } catch {
    return 'self_hosted';
  }
}

/**
 * Whether this is the managed service. Reads the capabilities the app routes
 * loaded before rendering and never fetches them itself; without them it
 * answers false, as for a self-hosted install.
 */
export function useManaged(): boolean {
  const { data } = useQuery({ ...capabilitiesQuery, enabled: false });
  return deploymentOf(data) === 'managed';
}

/**
 * How the owner signs in (`auth` in the capabilities). `local` is the Mac app
 * running the stack on This Mac: the app signs its owner in itself, so there
 * is no sign-in, sign-up, sign-out or account anywhere, only the owner's name.
 */
export type AuthMode = Capabilities['auth'];

const authModeOf = (capabilities: Capabilities | undefined): AuthMode =>
  capabilities?.auth ?? 'password';

/** The auth mode, for route guards; a server that cannot be asked counts as `password`. */
export async function loadAuthMode(queryClient: QueryClient): Promise<AuthMode> {
  try {
    return authModeOf(await queryClient.ensureQueryData(capabilitiesQuery));
  } catch {
    return 'password';
  }
}

/** Whether the Mac app signs the owner in (see AuthMode). Reads loaded capabilities only, like useManaged. */
export function useLocalAuth(): boolean {
  const { data } = useQuery({ ...capabilitiesQuery, enabled: false });
  return authModeOf(data) === 'local';
}

/** What a blocked connector or tool says: on a self-hosted install the owner set the policy. */
export const blockedText = (managed: boolean) =>
  managed ? 'Disabled by admin' : 'Blocked by policy';

/** "Admin: <label>" on the managed service; just the label, capitalised, when self-hosted. */
export function adminLabel(managed: boolean, label: string): string {
  return managed ? `Admin: ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}
