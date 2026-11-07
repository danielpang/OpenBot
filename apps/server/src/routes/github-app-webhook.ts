import { GITHUB_APP_WEBHOOK_PATH } from '@openbots/shared';
import { Hono, type Context } from 'hono';
import { clientIp, INTERNAL_HEADERS } from '../client-ip.js';
import type { AppEnv } from '../context.js';
import { DomainError } from '../errors.js';
import { parsePayload } from '../hooks/endpoints.js';
import { verifySignature } from '../hooks/verify.js';
import { observeWebhook } from '../metrics.js';
import { loadGithubApp } from '../services/github-app-store.js';
import { handleGithubAppDelivery } from '../services/github-app-webhook.js';

// The GitHub App's webhook (I19): `POST /api/v1/github/app/webhook`, outside
// the authenticated API like the ingress (hooks/ingress.ts), and in its
// order: the caller's rate limit before the body is read, the size limit,
// then `X-Hub-Signature-256` with the App's webhook secret (the `github`
// preset, a constant-time compare). 401 when no App is configured or the
// signature fails, with failed checks on their own bucket per address. After
// verification the answer is 202, whatever the delivery did (the installation's
// rate limit, 429, aside), so GitHub never retries a delivery we already
// have; services/github-app-webhook.ts does the work.

const tooLarge = (limit: number) =>
  new DomainError(413, 'PAYLOAD_TOO_LARGE', `Webhook payloads can be at most ${limit} bytes`);
const badSignature = (reason: string) => new DomainError(401, 'INVALID_SIGNATURE', reason);

/** Reads the body up to `limit` bytes; 413 past it, whatever Content-Length said. */
async function readBody(c: Context<AppEnv>, limit: number): Promise<Buffer> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > limit) throw tooLarge(limit);
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function throttle(c: Context<AppEnv>, key: string, max: number, what: string) {
  const { allowed, retryAfter } = await c.var.deps.infra.limiter.consume(key, { window: 60, max });
  if (allowed) return;
  observeWebhook('inbound', 'rate_limited');
  c.header('retry-after', String(retryAfter ?? 60));
  throw new DomainError(429, 'RATE_LIMITED', `Too many deliveries ${what}; retry in a minute`);
}

const lowerHeaders = (c: Context<AppEnv>) =>
  Object.fromEntries(
    [...c.req.raw.headers.entries()]
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .filter(([k]) => !INTERNAL_HEADERS.has(k)),
  );

async function receive(c: Context<AppEnv>) {
  const { deps } = c.var;
  const { limits } = deps.config;
  const remoteIp = clientIp(c);
  if (remoteIp) {
    await throttle(c, `hook-ip:${remoteIp}`, limits.webhookIpRatePerMin, 'from this address');
  }
  const body = await readBody(c, limits.webhookPayloadBytes);
  const headers = lowerHeaders(c);
  const secret = (await loadGithubApp(deps))?.app.webhookSecret;
  const result = secret
    ? verifySignature({ preset: 'github' }, secret, headers, body)
    : { ok: false as const, reason: 'No GitHub App is configured on this install' };
  if (!result.ok) {
    observeWebhook('inbound', 'rejected');
    deps.logger.warn({ remoteIp, reason: result.reason }, 'github app webhook rejected');
    await throttle(
      c,
      `hook-fail:github-app:${remoteIp ?? 'unknown'}`,
      limits.webhookFailedAuthPerMin,
      'failing verification from this address',
    );
    throw badSignature(result.reason);
  }
  const event = headers['x-github-event'] ?? '';
  const deliveryId = headers['x-github-delivery'];
  const outcome = await handleGithubAppDelivery(deps, {
    event,
    deliveryId,
    headers,
    body,
    payload: parsePayload(body, headers['content-type']),
    remoteIp,
  }).catch((error: unknown) => {
    if (error instanceof DomainError && error.status === 429) {
      observeWebhook('inbound', 'rate_limited');
      c.header('retry-after', '60');
      throw error;
    }
    // Verified: GitHub gets its 202 and the failure stays in the log.
    deps.logger.error({ err: error, event, deliveryId }, 'github app webhook failed');
    return null;
  });
  observeWebhook('inbound', outcome?.started.length ? 'started' : 'unmatched');
  return c.json(
    { delivery_id: deliveryId ?? null, run_ids: outcome?.started ?? [], accepted: true },
    202,
  );
}

export const githubAppWebhookRoutes = new Hono<AppEnv>().post(GITHUB_APP_WEBHOOK_PATH, receive);
