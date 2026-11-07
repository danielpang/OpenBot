import { z } from 'zod';
import type { OAuthTokenSet, SealedSecrets } from '@openbots/mcp';

// Fixed GitHub endpoints, not discovery from a user-supplied MCP URL. Only
// the catalog GitHub connector may use these credentials.
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

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

export async function beginGitHubDevice(clientId: string, request: typeof fetch) {
  const result = z
    .object({
      device_code: z.string().min(1).max(1024),
      user_code: z.string().min(1).max(64),
      verification_uri: z.literal('https://github.com/login/device'),
      expires_in: z.number().int().positive().max(3600),
      interval: z.number().int().positive().max(60),
    })
    .parse(
      await post(DEVICE_URL, { client_id: clientId, scope: 'repo read:org read:user' }, request),
    );
  const now = Date.now();
  const device: NonNullable<NonNullable<SealedSecrets['oauth']>['device']> = {
    clientId,
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
      expiresAt: new Date(device.expiresAt).toISOString(),
      interval: device.interval,
    },
  };
}

export type DevicePoll =
  | { status: 'pending'; interval: number }
  | { status: 'connected' }
  | { status: 'error'; message: string };

export async function pollGitHubDevice(
  device: NonNullable<NonNullable<SealedSecrets['oauth']>['device']>,
  request: typeof fetch,
): Promise<{ tokens: OAuthTokenSet } | { error: string; interval?: number }> {
  const result = z
    .object({
      error: z.string().optional(),
      interval: z.number().int().positive().max(3600).optional(),
      access_token: z.string().min(1).optional(),
      token_type: z.string().optional(),
      scope: z.string().optional(),
    })
    .parse(
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
  if (!result.access_token) throw new Error('GitHub did not return an access token.');
  return {
    tokens: {
      access_token: result.access_token,
      token_type: result.token_type ?? 'bearer',
      ...(result.scope ? { scope: result.scope } : {}),
    },
  };
}
