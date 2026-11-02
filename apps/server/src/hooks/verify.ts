import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { WebhookSignature } from '@openbots/shared';

// Who may deliver to an endpoint (plan 11, H3): the IP allowlist, the
// endpoint token (bearer, `X-OpenBots-Token` or the last path segment) and the
// HMAC presets for GitHub, Slack, Stripe and a generic header. Every
// comparison of a secret value is constant-time.

/** Endpoint tokens look like `whk_<43 base64url characters>`; slugs may not start with `whk_`. */
export const TOKEN_PREFIX = 'whk_';

/** Slack and Stripe sign a timestamp; older than this is a replay. */
export const SIGNATURE_TOLERANCE_S = 5 * 60;

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** A signing secret for presets where we choose it (GitHub, generic). */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time equality of two strings (by their bytes). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare against itself on a length mismatch so the time does not depend on where it differs.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Checks a presented token against the stored hash, in constant time. */
export function tokenMatches(presented: string, tokenHash: string): boolean {
  return safeEqual(hashToken(presented), tokenHash);
}

/** The token from `Authorization: Bearer`, `X-OpenBots-Token`, or the path. */
export function presentedToken(
  headers: Record<string, string>,
  pathToken: string | undefined,
): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers['authorization'] ?? '')?.[1];
  return bearer ?? headers['x-openbots-token'] ?? pathToken;
}

// IP allowlist

/** True when `ip` is inside one of the CIDR ranges (or no ranges are set). */
export function ipAllowed(ip: string | null, ranges: string[] | null | undefined): boolean {
  if (!ranges?.length) return true;
  if (!ip) return false;
  const address = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const range of ranges) {
    const [net, bits] = range.split('/');
    const netFamily = isIP(net ?? '');
    if (!netFamily) continue;
    const type = netFamily === 4 ? 'ipv4' : 'ipv6';
    list.addSubnet(net!, Number(bits ?? (netFamily === 4 ? 32 : 128)), type);
  }
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// HMAC presets (H3)

export type SignatureResult = { ok: true } | { ok: false; reason: string };

const hmacHex = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

const fail = (reason: string): SignatureResult => ({ ok: false, reason });

/**
 * Verifies a delivery's signature with the endpoint's preset. `now` is in
 * seconds (tests pin it). Headers are lowercased.
 */
export function verifySignature(
  signature: WebhookSignature,
  secret: string,
  headers: Record<string, string>,
  body: Buffer,
  now = Math.floor(Date.now() / 1000),
): SignatureResult {
  switch (signature.preset) {
    case 'github': {
      // X-Hub-Signature-256: sha256=<hex HMAC of the body>
      const sent = headers['x-hub-signature-256'];
      if (!sent) return fail('Missing X-Hub-Signature-256');
      return safeEqual(sent, `sha256=${hmacHex(secret, body)}`)
        ? { ok: true }
        : fail('X-Hub-Signature-256 does not match');
    }
    case 'slack': {
      // X-Slack-Signature: v0=<hex HMAC of "v0:<timestamp>:<body>">
      const sent = headers['x-slack-signature'];
      const ts = headers['x-slack-request-timestamp'];
      if (!sent || !ts) return fail('Missing X-Slack-Signature or X-Slack-Request-Timestamp');
      if (!fresh(ts, now)) return fail('X-Slack-Request-Timestamp is too old');
      const base = Buffer.concat([Buffer.from(`v0:${ts}:`), body]);
      return safeEqual(sent, `v0=${hmacHex(secret, base)}`)
        ? { ok: true }
        : fail('X-Slack-Signature does not match');
    }
    case 'stripe': {
      // Stripe-Signature: t=<timestamp>,v1=<hex HMAC of "<timestamp>.<body>">[,v1=...]
      const sent = headers['stripe-signature'];
      if (!sent) return fail('Missing Stripe-Signature');
      const fields = sent.split(',').map((kv) => kv.trim().split('=') as [string, string?]);
      const ts = fields.find(([k]) => k === 't')?.[1];
      const candidates = fields.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
      if (!ts || !candidates.length) return fail('Stripe-Signature has no t or v1');
      if (!fresh(ts, now)) return fail('Stripe-Signature timestamp is too old');
      const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${ts}.`), body]));
      // Check every candidate so the time does not depend on which one matched.
      const matched = candidates.map((v) => safeEqual(v, expected)).includes(true);
      return matched ? { ok: true } : fail('Stripe-Signature does not match');
    }
    case 'generic': {
      // <header>: [sha256=]<hex or base64 HMAC of the body>
      const name = (signature.header ?? 'X-Signature').toLowerCase();
      const sent = headers[name]?.replace(/^sha256=/i, '');
      if (!sent) return fail(`Missing ${signature.header ?? 'X-Signature'}`);
      const digest = createHmac('sha256', secret).update(body).digest();
      const hex = safeEqual(sent.toLowerCase(), digest.toString('hex'));
      const b64 = safeEqual(sent, digest.toString('base64'));
      return hex || b64
        ? { ok: true }
        : fail(`${signature.header ?? 'X-Signature'} does not match`);
    }
  }
}

function fresh(ts: string, now: number): boolean {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && Math.abs(now - seconds) <= SIGNATURE_TOLERANCE_S;
}
