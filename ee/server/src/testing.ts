import { vi } from 'vitest';
import { ORIGIN, type TestApp } from '@openbots/server/test-app';
import { SIGN_UP_COOKIE } from './sign-up.js';

// Test helpers for the managed server (not built): a fake Resend that keeps
// what it was sent, and the three steps of an email sign-up.

export const PASSWORD = 'correct horse battery';

export interface Mailbox {
  fetch: typeof fetch;
  sent: { to: string; subject: string; text: string }[];
  /** The newest code sent to `to`. */
  code(to: string): string | undefined;
}

export function mailbox(): Mailbox {
  const sent: Mailbox['sent'] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as {
      to: string[];
      subject: string;
      text: string;
    };
    sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
    return Response.json({ id: 'email' });
  });
  return {
    fetch,
    sent,
    code: (to) =>
      sent
        .filter((m) => m.to === to)
        .at(-1)
        ?.text.match(/\b(\d{6})\b/)?.[1],
  };
}

/** Email options that send to `mail`. */
export const emailTo = (mail: Mailbox) => ({
  apiKey: 're_test',
  from: 'OpenBots <hi@example.com>',
  fetch: mail.fetch,
});

export function post(t: TestApp, path: string, body: unknown, cookie?: string) {
  return t.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** `name=value` of the cookie `name` a response sets, if any. */
export function cookieOf(res: Response, name: string) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`) || c.includes(`${name}=`));
}

export const sessionOf = (res: Response) => cookieOf(res, 'session_token');

/** Step 1: returns the response and the request's cookie. */
export async function startSignUp(t: TestApp, email: string, invite?: string) {
  const res = await post(t, '/api/auth/sign-up/start', { email, ...(invite ? { invite } : {}) });
  return { res, request: cookieOf(res, SIGN_UP_COOKIE) };
}

export const verifyCode = (t: TestApp, request: string | undefined, code: string) =>
  post(t, '/api/auth/sign-up/verify', { code }, request);

export const completeSignUp = (
  t: TestApp,
  request: string | undefined,
  { name = 'Someone', password = PASSWORD }: { name?: string; password?: string } = {},
) => post(t, '/api/auth/sign-up/complete', { name, password }, request);

/**
 * All three steps, reading the code from `mail`. Returns the last response
 * and the session; a step that fails ends it there.
 */
export async function signUpByEmail(
  t: TestApp,
  mail: Mailbox,
  email: string,
  { invite, name, password }: { invite?: string; name?: string; password?: string } = {},
) {
  const start = await startSignUp(t, email, invite);
  if (!start.res.ok) return { res: start.res, cookie: undefined };
  const verified = await verifyCode(t, start.request, mail.code(email) ?? '');
  if (!verified.ok) return { res: verified, cookie: undefined };
  const res = await completeSignUp(t, start.request, { name, password });
  return { res, cookie: sessionOf(res) };
}

export const signIn = (t: TestApp, email: string, password = PASSWORD) =>
  post(t, '/api/auth/sign-in/email', { email, password });

/**
 * An account made by a server call, with no request (as a script would),
 * which the sign-up policy still checks: `invite` proves an invitation.
 * Not confirmed; tests that need it confirmed set it.
 */
export function createAccount(t: TestApp, email: string, extra: Record<string, unknown> = {}) {
  const api = t.deps.auth.api as unknown as {
    signUpEmail(input: { body: Record<string, unknown>; asResponse: true }): Promise<Response>;
  };
  return api.signUpEmail({
    body: { name: email.split('@')[0], email, password: PASSWORD, ...extra },
    asResponse: true,
  });
}
