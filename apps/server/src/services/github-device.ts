import { z } from 'zod';
import type { OAuthTokenSet, SealedSecrets } from '@openbots/mcp';

// Public GitHub App identifiers only. Device authorization and refresh both
// work without a private key or client secret. Never discover these endpoints
// from a user-supplied MCP URL.
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .max(100);
export const githubInstallationUrl = (slug: string) =>
  `https://github.com/apps/${slugSchema.parse(slug)}/installations/new`;

async function post(url: string, body: Record<string, string>, request: typeof fetch) {
  const response = await request(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('GitHub could not complete the request. Try again.');
  return response.json();
}

export async function beginGitHubDevice(clientId: string, appSlug: string, request: typeof fetch) {
  const installationUrl = githubInstallationUrl(appSlug);
  const result = z
    .object({
      device_code: z.string().min(1).max(1024),
      user_code: z.string().min(1).max(64),
      verification_uri: z.literal('https://github.com/login/device'),
      expires_in: z.number().int().positive().max(3600),
      interval: z.number().int().positive().max(60),
    })
    .parse(await post(DEVICE_URL, { client_id: clientId }, request));
  // GitHub Apps use their registered permissions, not the OAuth repo scope.
  const now = Date.now();
  const device: NonNullable<NonNullable<SealedSecrets['oauth']>['device']> = {
    clientId,
    appSlug,
    deviceCode: result.device_code,
    expiresAt: now + result.expires_in * 1000,
    interval: result.interval,
    nextPollAt: now + result.interval * 1000,
  };
  return {
    device,
    public: {
      userCode: result.user_code,
      verificationUrl: result.verification_uri,
      installationUrl,
      expiresAt: new Date(device.expiresAt).toISOString(),
      interval: device.interval,
    },
  };
}

export type DevicePoll =
  | { status: 'pending'; interval: number }
  | { status: 'connected' }
  | { status: 'error'; message: string };

export class GitHubAppAuthorizationError extends Error {}

const tokenResponse = z.object({
  error: z.string().optional(),
  interval: z.number().int().positive().max(3600).optional(),
  access_token: z.string().optional(),
  token_type: z.literal('bearer').optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().startsWith('ghr_').optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

function tokensFrom(result: z.infer<typeof tokenResponse>): OAuthTokenSet {
  if (result.access_token && !result.access_token.startsWith('ghu_')) {
    throw new GitHubAppAuthorizationError(
      'Use a GitHub App, not an OAuth App. Configure its client ID and app slug, then Connect again.',
    );
  }
  if (result.error || !result.access_token || (result.expires_in && !result.refresh_token)) {
    throw new Error('GitHub App authorization could not be renewed. Connect again.');
  }
  const now = Date.now();
  return {
    access_token: result.access_token,
    token_type: 'bearer',
    ...(result.expires_in ? { expires_at: now + result.expires_in * 1000 } : {}),
    ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
    ...(result.refresh_token_expires_in
      ? { refresh_expires_at: now + result.refresh_token_expires_in * 1000 }
      : {}),
  };
}

export async function pollGitHubDevice(
  device: NonNullable<NonNullable<SealedSecrets['oauth']>['device']>,
  request: typeof fetch,
): Promise<{ tokens: OAuthTokenSet } | { error: string; interval?: number }> {
  const result = tokenResponse.parse(
    await post(
      TOKEN_URL,
      {
        client_id: device.clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      request,
    ),
  );
  if (result.error)
    return { error: result.error, ...(result.interval ? { interval: result.interval } : {}) };
  return { tokens: tokensFrom(result) };
}

/** GitHub explicitly exempts device-flow refreshes from client_secret. */
export async function refreshGitHubDevice(
  clientId: string,
  tokens: OAuthTokenSet,
  request: typeof fetch,
): Promise<OAuthTokenSet> {
  if (
    !tokens.refresh_token ||
    (tokens.refresh_expires_at && Date.now() >= tokens.refresh_expires_at)
  ) {
    throw new Error('The GitHub App authorization expired. Connect again.');
  }
  return tokensFrom(
    tokenResponse.parse(
      await post(
        TOKEN_URL,
        {
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        },
        request,
      ),
    ),
  );
}

/** Authorization alone does not install an app. Require a live installation
 * of this app visible to the authorizing user before calling it connected. */
export async function hasGitHubInstallation(
  token: string,
  appSlug: string,
  request: typeof fetch,
): Promise<boolean> {
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'OpenBots',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error('Could not verify the GitHub App installation.');
    const result = z
      .object({
        installations: z.array(
          z.object({ app_slug: z.string(), suspended_at: z.string().nullable() }),
        ),
      })
      .parse(await response.json());
    if (result.installations.some((i) => i.app_slug === appSlug && i.suspended_at === null))
      return true;
    if (result.installations.length < 100) return false;
  }
  return false;
}
