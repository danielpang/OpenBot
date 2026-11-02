import { ApiError } from './client.js';

// Accounts and sessions live under `/api/auth/*` (better-auth), outside the
// OpenAPI document, so these few calls are written by hand. Errors keep
// better-auth's `{ code, message }` shape and surface as `ApiError`.

export type SocialProvider = 'github' | 'google';
export type AuthClient = ReturnType<typeof createAuthClient>;

export function createAuthClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}/api/auth${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => undefined)) as
      { code?: string; message?: string } | undefined;
    if (!res.ok) {
      throw new ApiError(res.status, { code: data?.code, detail: data?.message });
    }
    return data as T;
  }

  return {
    /**
     * better-auth's own sign-up. `token` is null when the server wants the
     * email confirmed first. The managed service signs up with the three
     * steps below instead.
     */
    signUpEmail: (input: {
      name: string;
      email: string;
      password: string;
      invite?: string;
      callbackURL?: string;
    }) => post<{ token: string | null }>('/sign-up/email', input),
    signInEmail: (input: { email: string; password: string; callbackURL?: string }) =>
      post<unknown>('/sign-in/email', input),
    /**
     * Managed sign-up, step 1: emails a 6-digit code to the address, for a
     * request kept in an HttpOnly cookie. Again for a new code. `invite` is
     * the invitation the sign-up came from.
     */
    startSignUp: (input: { email: string; invite?: string }) =>
      post<unknown>('/sign-up/start', input),
    /** Step 2: the code of this request. */
    confirmSignUp: (input: { code: string }) => post<unknown>('/sign-up/verify', input),
    /** Step 3: creates the account, confirmed, and signs in. */
    completeSignUp: (input: { name: string; password: string }) =>
      post<unknown>('/sign-up/complete', input),
    /** Returns the provider's authorization URL to navigate to. */
    signInSocial: async (input: {
      provider: SocialProvider;
      callbackURL: string;
      errorCallbackURL?: string;
    }) => (await post<{ url: string }>('/sign-in/social', input)).url,
    signOut: () => post<unknown>('/sign-out', {}),
    /** Changes the signed-in user's own name. */
    updateUser: (input: { name: string }) => post<unknown>('/update-user', input),
  };
}
