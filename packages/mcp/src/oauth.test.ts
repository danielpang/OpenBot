import { afterEach, describe, expect, it } from 'vitest';
import { HttpHost } from './http.js';
import {
  type OAuthSetupError,
  discoverServer,
  finishOAuth,
  needsRefresh,
  parseState,
  refreshOAuth,
  safeEqual,
  startOAuth,
  verifyState,
} from './oauth.js';
import {
  startMockAuthServer,
  startTestHttpServer,
  type MockAuthServer,
  type TestHttpServer,
} from './testing.js';

const REDIRECT = 'http://localhost:3000/api/v1/connectors/oauth/callback';

describe('OAuth 2.1 for HTTP connectors', () => {
  let as: MockAuthServer | undefined;
  let mcp: TestHttpServer | undefined;
  afterEach(async () => {
    await mcp?.close();
    await as?.close();
    mcp = as = undefined;
  });

  const setup = async (options: Parameters<typeof startMockAuthServer>[0] = {}) => {
    as = await startMockAuthServer(options);
    const auth = as;
    mcp = await startTestHttpServer({
      authorize: (a) => auth.validates(a),
      authorizationServer: as.url,
    });
    return { as, mcp };
  };

  it('registers a client, sends PKCE and state, exchanges the code and connects', async () => {
    const { as, mcp } = await setup();
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'conn-1',
      clientName: 'OpenBots',
      scopes: ['read'],
    });
    expect(as.registrations).toBe(1);
    expect(started.client.client_id).toBe('client_1');
    expect(parseState(started.state)).toEqual({ id: 'conn-1', nonce: started.pending.nonce });

    const redirect = await as.consent(started.authorizationUrl);
    const sent = as.lastAuthorize!;
    expect(sent.get('code_challenge_method')).toBe('S256');
    expect(sent.get('code_challenge')).not.toBe(started.pending.codeVerifier);
    expect(sent.get('redirect_uri')).toBe(REDIRECT);
    expect(sent.get('resource')).toBe(mcp.url);
    expect(sent.get('scope')).toBe('read');
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);

    const state = redirect.searchParams.get('state')!;
    verifyState(state, started.pending);
    const tokens = await finishOAuth({
      code: redirect.searchParams.get('code')!,
      pending: started.pending,
      client: started.client,
    });
    expect(tokens.refresh_token).toMatch(/^rt_/);
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
    expect(as.tokenRequests.at(-1)!.get('code_verifier')).toBe(started.pending.codeVerifier);

    const host = new HttpHost({ url: mcp.url, token: () => tokens.access_token });
    await expect(host.start()).resolves.toMatchObject({
      tools: [{ name: 'add' }, { name: 'delete_everything' }],
    });
    await host.close();
  });

  it('fails the exchange when the PKCE verifier does not match', async () => {
    const { as, mcp } = await setup();
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'c',
      clientName: 'OpenBots',
    });
    const redirect = await as.consent(started.authorizationUrl);
    await expect(
      finishOAuth({
        code: redirect.searchParams.get('code')!,
        pending: { ...started.pending, codeVerifier: 'x'.repeat(64) },
        client: started.client,
      }),
    ).rejects.toThrow();
  });

  it('rejects a tampered, missing or expired state', async () => {
    const { mcp } = await setup();
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'c',
      clientName: 'OpenBots',
    });
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        return (err as OAuthSetupError).code;
      }
      return 'ok';
    };
    expect(code(() => verifyState(started.state, started.pending))).toBe('ok');
    expect(code(() => verifyState(`${started.state}x`, started.pending))).toBe('STATE_INVALID');
    expect(code(() => verifyState('c.other', started.pending))).toBe('STATE_INVALID');
    expect(code(() => verifyState('nodot', started.pending))).toBe('STATE_INVALID');
    expect(code(() => verifyState(started.state, undefined))).toBe('STATE_INVALID');
    expect(
      code(() => verifyState(started.state, started.pending, started.pending.expiresAt + 1)),
    ).toBe('STATE_EXPIRED');
  });

  it('needs a client id when the server has no dynamic registration, and uses one when given', async () => {
    const { as, mcp } = await setup({ dynamicRegistration: false });
    await expect(
      startOAuth({
        serverUrl: mcp.url,
        redirectUrl: REDIRECT,
        stateId: 'c',
        clientName: 'OpenBots',
      }),
    ).rejects.toMatchObject({ code: 'CLIENT_REQUIRED' });
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'c',
      clientName: 'OpenBots',
      client: { client_id: 'my-app' },
    });
    expect(as.registrations).toBe(0);
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe('my-app');
  });

  it('adds extra authorization parameters without overriding the flow', async () => {
    const { mcp } = await setup();
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'c',
      clientName: 'OpenBots',
      authorizationParams: { access_type: 'offline', prompt: 'consent', state: 'forged' },
    });
    const params = new URL(started.authorizationUrl).searchParams;
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('state')).toBe(started.state);
  });

  it('refreshes tokens near expiry and keeps the refresh token when none is returned', async () => {
    const { as, mcp } = await setup({ expiresIn: 30 });
    const started = await startOAuth({
      serverUrl: mcp.url,
      redirectUrl: REDIRECT,
      stateId: 'c',
      clientName: 'OpenBots',
    });
    const redirect = await as.consent(started.authorizationUrl);
    const tokens = await finishOAuth({
      code: redirect.searchParams.get('code')!,
      pending: started.pending,
      client: started.client,
    });
    // 30 s left is inside the 60 s refresh window.
    expect(needsRefresh(tokens)).toBe(true);
    const fresh = await refreshOAuth({
      authorizationServerUrl: started.pending.authorizationServerUrl,
      client: started.client,
      tokens,
      resource: started.pending.resource,
    });
    expect(fresh.access_token).not.toBe(tokens.access_token);
    expect(as.validates(`Bearer ${fresh.access_token}`)).toBe(true);
    expect(as.validates(`Bearer ${tokens.access_token}`)).toBe(false);
    expect(needsRefresh({ ...fresh, expires_at: Date.now() + 3_600_000 })).toBe(false);
    expect(needsRefresh({ access_token: 'a', token_type: 'Bearer' })).toBe(false);
  });

  it('compares in constant time without length shortcuts', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  describe('discovering a pasted URL', () => {
    it('finds OAuth with dynamic registration, which needs no client', async () => {
      const { as, mcp } = await setup();
      await expect(discoverServer(mcp.url)).resolves.toEqual({
        auth: 'oauth',
        dynamicRegistration: true,
        authorizationServerUrl: as.url,
      });
      // Nothing was registered just to look.
      expect(as.registrations).toBe(0);
    });

    it('finds OAuth without dynamic registration, which needs a client', async () => {
      const { as, mcp } = await setup({ dynamicRegistration: false });
      await expect(discoverServer(mcp.url)).resolves.toEqual({
        auth: 'oauth',
        dynamicRegistration: false,
        authorizationServerUrl: as.url,
      });
    });

    it('needs no sign-in when the server answers without a token', async () => {
      mcp = await startTestHttpServer();
      await expect(discoverServer(mcp.url)).resolves.toEqual({
        auth: 'none',
        dynamicRegistration: false,
        authorizationServerUrl: null,
      });
    });

    it('asks for a token when the server refuses but names no authorization server', async () => {
      mcp = await startTestHttpServer({ authorize: (a) => a === 'Bearer t' });
      await expect(discoverServer(mcp.url)).resolves.toMatchObject({ auth: 'bearer' });
    });

    it('says so when the server cannot be reached', async () => {
      await expect(discoverServer('http://127.0.0.1:1/mcp')).rejects.toMatchObject({
        code: 'DISCOVERY_FAILED',
      });
    });
  });
});
