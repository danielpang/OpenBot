import { describe, expect, it, vi } from 'vitest';
import { ApiError, createAuthClient, createClient, PACKAGE_NAME, unwrap } from './index.js';

function respond(status: number, body: unknown, type = 'application/json') {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } }),
  );
}

describe('@openbots/api-client', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbots/api-client');
  });

  it('calls typed paths with cookie credentials and returns the body', async () => {
    const fetchImpl = respond(200, { oauth: { github: true, google: false } });
    const api = createClient('http://bots.test', fetchImpl);
    const caps = await unwrap(api.GET('/api/v1/capabilities'));
    expect(caps.oauth.github).toBe(true);
    const request = fetchImpl.mock.calls[0]![0] as Request;
    expect(request.url).toBe('http://bots.test/api/v1/capabilities');
    expect(request.credentials).toBe('include');
  });

  it('throws problem documents as ApiError', async () => {
    const fetchImpl = respond(
      403,
      { type: 'about:blank', title: 'Not allowed', status: 403, code: 'FORBIDDEN' },
      'application/problem+json',
    );
    const api = createClient('http://bots.test', fetchImpl);
    const error = await unwrap(api.GET('/api/v1/settings')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Not allowed' });
  });

  it('posts auth calls and surfaces better-auth error codes', async () => {
    const fetchImpl = respond(403, { code: 'INVITE_REQUIRED', message: 'An invite is required' });
    const auth = createAuthClient('', fetchImpl);
    const error = await auth
      .signUpEmail({ name: 'a', email: 'a@b.c', password: 'pw' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: 'INVITE_REQUIRED' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/auth/sign-up/email');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(init!.body as string)).toMatchObject({ email: 'a@b.c' });
  });
});
