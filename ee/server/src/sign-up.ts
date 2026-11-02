import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, count, desc, eq, gt, lte } from 'drizzle-orm';
import type { ExtensionContext } from '@openbots/server';
import type { Config } from '@openbots/server/config';
import { schema, type Db } from '@openbots/server/db/client';
import { CLIENT_IP_HEADER } from '@openbots/server/client-ip';
import { parseMasterKey } from '@openbots/server/secrets';
import {
  emailEnabled,
  errorText,
  sendSignUpNotice,
  sendVerificationCode,
  type EmailOptions,
} from './email.js';
import { invitationProof } from './invitations.js';

// Email sign-up on the managed service (plan 21.6): email first, credentials
// after, so whoever holds the inbox sets the password.
//
// 1. POST /api/auth/sign-up/start {email, invite?}: no user and no password,
//    only a pending request for the address, bound to a random id in an
//    HttpOnly cookie, and a 6-digit code emailed to the address. When the
//    address already has an account, the email says someone tried to sign
//    up with it instead, and the answer is the same.
// 2. POST /api/auth/sign-up/verify {code}: the code of this request, once.
// 3. POST /api/auth/sign-up/complete {name, password}: creates the account,
//    confirmed, and signs in. An unconfirmed account from before this flow
//    is deleted first, in the same transaction, with everything tied to it
//    (its sign-in methods, sessions, memberships, invitations and API keys),
//    so nothing linked to it keeps access.
//
// Nothing an unauthenticated request does deletes or replaces an account.
// Limits, and why these numbers:
// - Per IP first: 20 sign-ups and 50 code tries an hour.
// - Sends per address: 10 an hour and 20 a day, counted only for a request
//   that passed the policy checks, before anything is made or sent.
// - Tries: 5 per code, then that code is dead; and 15 failed tries per
//   address in a rolling hour across all its codes, after which the address
//   cannot verify until the hour clears. A correct code never counts.
// So guessing one address is bounded by its sends: at most 20 codes times 5
// tries, 100 guesses a day, about 3,000 a month against a million codes
// (about 0.3% a month in the worst case). The worst lockout from failed
// tries is one hour after the last of 15; spending an address's sends
// blocks new codes for it for up to a day. Codes last 10 minutes, are stored as an
// HMAC bound to their request, and compared in constant time. A code
// reaches a log only on a development server without email that sets
// OPENBOTS_DEV_LOG_EMAIL_LINKS (refused in production). The invite of
// /sign-up?invite=<id> travels with the request; invite mode checks it at
// both ends.

export const CODE_LENGTH = 6;
export const CODE_MINUTES = 10;
/** Tries per code; then the code is dead. */
export const CODE_TRIES = 5;
/** Codes (or notices) one address may be sent in an hour, and in a day. */
export const SENDS_PER_HOUR = 10;
export const SENDS_PER_DAY = 20;
/** Failed tries one address may make in a rolling hour, across its codes. */
export const FAILS_PER_HOUR = 15;
/** Sign-ups one IP may start in an hour. */
export const STARTS_PER_IP = 20;
/** Code tries one IP may make in an hour. */
export const TRIES_PER_IP = 50;
export const SIGN_UP_COOKIE = 'openbots_sign_up';
const COOKIE_PATH = '/api/auth/sign-up';

interface Pending {
  email: string;
  /** HMAC of the code, null once used or when the address has an account. */
  mac: string | null;
  invite: string | null;
  /** Tries so far; at CODE_TRIES the code is dead. */
  tries: number;
  confirmed: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The request's row: keyed by a hash, so the database alone completes nothing. */
const identifierOf = (requestId: string) => `sign-up:${sha256(requestId)}`;

function codeMac(config: Pick<Config, 'masterKey'>, identifier: string, code: string) {
  const key = Buffer.from(
    hkdfSync('sha256', parseMasterKey(config.masterKey), '', 'openbots:sign-up-code', 32),
  );
  return createHmac('sha256', key).update(`${identifier}:${code}`).digest('base64url');
}

function sameMac(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const randomCode = () => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

function tooMany(code: string, message: string, retryAfter: number | null) {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { code, message },
    { 'X-Retry-After': String(retryAfter ?? 60) },
  );
}

const invalidCode = () =>
  new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'That code is wrong' });
const expired = () =>
  new APIError('BAD_REQUEST', { code: 'OTP_EXPIRED', message: 'That code expired' });
const dead = () =>
  new APIError('BAD_REQUEST', {
    code: 'TOO_MANY_ATTEMPTS',
    message: 'Too many tries. Send a new code',
  });

/** The caller's address, as the server's edge saw it; none for a call without a socket. */
const ipOf = (request: Request | undefined) => request?.headers.get(CLIENT_IP_HEADER) ?? null;

/** Invite mode lets in the first user and someone with a pending invitation for the address. */
export async function signUpAllowed(
  config: Pick<Config, 'signupMode'>,
  db: Db,
  email: string,
  invite: unknown,
): Promise<boolean> {
  if (config.signupMode === 'open') return true;
  const [users] = await db.select({ n: count() }).from(schema.users);
  if (!users?.n) return true;
  return (await invitationProof(db, email, invite)) !== null;
}

export function inviteRequired() {
  // Not FORBIDDEN: better-auth answers that from a user hook with a fake
  // success, to hide which addresses have accounts.
  return new APIError('BAD_REQUEST', {
    code: 'INVITE_REQUIRED',
    message: 'Signing up here needs the link from your invite',
  });
}

export function signUpPlugin(
  { config, db, logger, infra }: ExtensionContext,
  email: EmailOptions = {},
): BetterAuthPlugin {
  const cookie = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.publicUrl.startsWith('https://'),
    path: COOKIE_PATH,
  };

  /** The request behind the cookie, unexpired. */
  async function pendingOf(requestId: string | null) {
    if (!requestId) throw invalidCode();
    const identifier = identifierOf(requestId);
    const [row] = await db
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.identifier, identifier));
    if (!row) throw invalidCode();
    if (row.expiresAt.getTime() <= Date.now()) throw expired();
    return { row, identifier, pending: JSON.parse(row.value) as Pending };
  }

  async function deliver(to: string, code: string | null) {
    if (!emailEnabled(email)) {
      // The code is a credential: logged only where asked, on a development server.
      if (code && email.logLinks) logger.info({ email: to, code }, 'email verification code');
      else logger.warn('sign-up email not sent: no email set up');
      return;
    }
    const log = (err: unknown) => logger.warn({ err: errorText(err) }, 'verification email failed');
    if (code) await sendVerificationCode(email, { to, code }, log);
    else await sendSignUpNotice(email, { to }, log);
  }

  return {
    id: 'openbots-sign-up',
    rateLimit: [
      { pathMatcher: (path) => path === '/sign-up/start', window: 600, max: 10 },
      { pathMatcher: (path) => path === '/sign-up/verify', window: 600, max: 30 },
      { pathMatcher: (path) => path === '/sign-up/complete', window: 600, max: 10 },
    ],
    endpoints: {
      signUpStart: createAuthEndpoint(
        '/sign-up/start',
        {
          method: 'POST',
          body: z.object({ email: z.email().max(254), invite: z.string().max(64).optional() }),
        },
        async (ctx) => {
          const ip = ipOf(ctx.request);
          if (ip) {
            const starts = await infra.limiter.consume(`sign-up-ip:${ip}`, {
              window: 3600,
              max: STARTS_PER_IP,
            });
            if (!starts.allowed) {
              throw tooMany(
                'TOO_MANY_REQUESTS',
                'Too many sign-ups. Try again later',
                starts.retryAfter,
              );
            }
          }
          const address = ctx.body.email.trim().toLowerCase();
          const invite = ctx.body.invite ?? null;
          if (!(await signUpAllowed(config, db, address, invite))) throw inviteRequired();
          // Counted against the address only now, and before anything is made or sent.
          const sends = await infra.limiter.consume(`sign-up-send:${address}`, {
            window: 3600,
            max: SENDS_PER_HOUR,
          });
          if (!sends.allowed) {
            throw tooMany('TOO_MANY_CODES', 'Too many codes for this email', sends.retryAfter);
          }
          const daily = await infra.limiter.consume(`sign-up-send-day:${address}`, {
            window: 86_400,
            max: SENDS_PER_DAY,
          });
          if (!daily.allowed) {
            throw tooMany('TOO_MANY_CODES', 'Too many codes for this email', daily.retryAfter);
          }
          const [user] = await db
            .select({ verified: schema.users.emailVerified })
            .from(schema.users)
            .where(eq(schema.users.email, address));
          const requestId = randomBytes(32).toString('base64url');
          const identifier = identifierOf(requestId);
          // An account already has the address: no code, a notice instead, and the same answer.
          const code = user?.verified ? null : randomCode();
          const pending: Pending = {
            email: address,
            mac: code ? codeMac(config, identifier, code) : null,
            invite,
            tries: 0,
            confirmed: false,
          };
          await db.insert(schema.verifications).values({
            identifier,
            value: JSON.stringify(pending),
            expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
          });
          await deliver(address, code);
          ctx.setCookie(SIGN_UP_COOKIE, requestId, { ...cookie, maxAge: 2 * CODE_MINUTES * 60 });
          return ctx.json({ sent: true });
        },
      ),

      signUpVerify: createAuthEndpoint(
        '/sign-up/verify',
        { method: 'POST', body: z.object({ code: z.string().trim().max(16) }) },
        async (ctx) => {
          const { row, identifier, pending } = await pendingOf(ctx.getCookie(SIGN_UP_COOKIE));
          if (pending.confirmed) return ctx.json({ confirmed: true });
          const ip = ipOf(ctx.request);
          if (ip) {
            const tries = await infra.limiter.consume(`sign-up-try-ip:${ip}`, {
              window: 3600,
              max: TRIES_PER_IP,
            });
            if (!tries.allowed) {
              throw tooMany(
                'TOO_MANY_REQUESTS',
                'Too many tries. Try again later',
                tries.retryAfter,
              );
            }
          }
          const locked = await lockedFor(db, pending.email);
          if (locked !== null) {
            throw tooMany('TOO_MANY_FAILURES', 'Too many wrong codes. Try again later', locked);
          }
          if (pending.tries >= CODE_TRIES) throw dead();
          // The try counts before the comparison, once: only the row as read is updated.
          const counted: Pending = { ...pending, tries: pending.tries + 1 };
          const tried = await swap(db, row.id, row.value, counted);
          if (!tried) throw invalidCode();
          const right =
            pending.mac !== null &&
            sameMac(codeMac(config, identifier, ctx.body.code), pending.mac);
          if (!right) {
            await recordFailure(db, pending.email);
            throw counted.tries >= CODE_TRIES ? dead() : invalidCode();
          }
          // Used once: the code is gone, and the request is confirmed.
          const used = await swap(
            db,
            row.id,
            tried,
            { ...counted, mac: null, confirmed: true },
            true,
          );
          if (!used) throw invalidCode();
          return ctx.json({ confirmed: true });
        },
      ),

      signUpComplete: createAuthEndpoint(
        '/sign-up/complete',
        {
          method: 'POST',
          body: z.object({ name: z.string().trim().min(1).max(100), password: z.string() }),
        },
        async (ctx) => {
          const { row, pending } = await pendingOf(ctx.getCookie(SIGN_UP_COOKIE));
          if (!pending.confirmed) {
            throw new APIError('BAD_REQUEST', {
              code: 'EMAIL_NOT_VERIFIED',
              message: 'Enter the code first',
            });
          }
          const { password } = ctx.body;
          const limits = ctx.context.password.config;
          if (password.length < limits.minPasswordLength) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_TOO_SHORT',
              message: 'Password too short',
            });
          }
          if (password.length > limits.maxPasswordLength) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_TOO_LONG',
              message: 'Password too long',
            });
          }
          // The invite may have been revoked since step 1.
          if (!(await signUpAllowed(config, db, pending.email, pending.invite))) {
            throw inviteRequired();
          }
          // Once: the request is gone whatever happens next.
          const [taken] = await db
            .delete(schema.verifications)
            .where(
              and(eq(schema.verifications.id, row.id), eq(schema.verifications.value, row.value)),
            )
            .returning({ id: schema.verifications.id });
          if (!taken) throw invalidCode();

          const hash = await ctx.context.password.hash(password);
          const userId = await createConfirmed(db, pending.email, ctx.body.name, hash);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) throw invalidCode();
          const session = await ctx.context.internalAdapter.createSession(userId);
          await setSessionCookie(ctx, { session, user });
          ctx.setCookie(SIGN_UP_COOKIE, '', { ...cookie, maxAge: 0 });
          return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
        },
      ),
    },
  };
}

/** One row per failed try of an address, kept for an hour. */
const failuresOf = (email: string) => `sign-up-fail:${sha256(email)}`;

/**
 * Seconds until the address may try again, when its failed tries in the
 * last hour reached FAILS_PER_HOUR; else null.
 */
async function lockedFor(db: Db, email: string): Promise<number | null> {
  const rows = await db
    .select({ expiresAt: schema.verifications.expiresAt })
    .from(schema.verifications)
    .where(
      and(
        eq(schema.verifications.identifier, failuresOf(email)),
        gt(schema.verifications.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.verifications.expiresAt))
    .limit(FAILS_PER_HOUR);
  if (rows.length < FAILS_PER_HOUR) return null;
  // Open again when the oldest of the last FAILS_PER_HOUR expires.
  return Math.max(1, Math.ceil((rows.at(-1)!.expiresAt.getTime() - Date.now()) / 1000));
}

async function recordFailure(db: Db, email: string) {
  const identifier = failuresOf(email);
  await db
    .delete(schema.verifications)
    .where(
      and(
        eq(schema.verifications.identifier, identifier),
        lte(schema.verifications.expiresAt, new Date()),
      ),
    );
  await db
    .insert(schema.verifications)
    .values({ identifier, value: '', expiresAt: new Date(Date.now() + 3_600_000) });
}

/** Replaces the row as read with `next`; the new value, or null when it changed meanwhile. */
async function swap(db: Db, id: string, value: string, next: Pending, renew = false) {
  const text = JSON.stringify(next);
  const [row] = await db
    .update(schema.verifications)
    .set({
      value: text,
      ...(renew ? { expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) } : {}),
    })
    .where(and(eq(schema.verifications.id, id), eq(schema.verifications.value, value)))
    .returning({ id: schema.verifications.id });
  return row ? text : null;
}

/** Postgres's foreign key violation, from postgres.js or PGlite. */
function foreignKeyViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

/**
 * The account, confirmed, with its password, in one transaction. An
 * unconfirmed account with the address, left from before this flow, is
 * deleted first with everything tied to it: sign-in methods (a linked
 * GitHub or Google identity too), sessions, memberships, invitations it
 * sent and API keys all cascade. Should it own anything else, nothing
 * changes and the sign-up is refused.
 */
async function createConfirmed(db: Db, email: string, name: string, hash: string) {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.users.id, verified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .for('update');
      if (existing?.verified) {
        throw new APIError('BAD_REQUEST', {
          code: 'ACCOUNT_EXISTS',
          message: 'This email has an account. Sign in instead',
        });
      }
      if (existing) {
        await tx
          .delete(schema.users)
          .where(and(eq(schema.users.id, existing.id), eq(schema.users.emailVerified, false)));
      }
      const [user] = await tx
        .insert(schema.users)
        .values({ email, name, emailVerified: true })
        .returning({ id: schema.users.id });
      await tx.insert(schema.accounts).values({
        userId: user!.id,
        providerId: 'credential',
        accountId: user!.id,
        password: hash,
      });
      return user!.id;
    });
  } catch (error) {
    if (!foreignKeyViolation(error)) throw error;
    throw new APIError('BAD_REQUEST', {
      code: 'ACCOUNT_IN_USE',
      message: 'This email cannot sign up here. Contact support',
    });
  }
}
