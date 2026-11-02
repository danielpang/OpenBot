import { describe, expect, it, vi } from 'vitest';
import { notarizeApp, notarizeCredentials, type AfterSignContext } from './notarize.js';

const context: AfterSignContext = {
  electronPlatformName: 'darwin',
  appOutDir: '/build/release/mac-universal',
  packager: { appInfo: { productFilename: 'OpenBots' } },
};

const API_KEY_ENV = {
  APPLE_API_KEY: '/tmp/AuthKey.p8',
  APPLE_API_KEY_ID: 'T9GPZ92M7K',
  APPLE_API_ISSUER: 'c055ca8c-e5a8-4836-b61d-aa5794eeb3f4',
};
const APPLE_ID_ENV = {
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'ABCDE12345',
};

describe('notarizeCredentials', () => {
  it('prefers the App Store Connect API key', () => {
    expect(notarizeCredentials({ ...APPLE_ID_ENV, ...API_KEY_ENV })).toEqual({
      appleApiKey: '/tmp/AuthKey.p8',
      appleApiKeyId: 'T9GPZ92M7K',
      appleApiIssuer: 'c055ca8c-e5a8-4836-b61d-aa5794eeb3f4',
    });
  });

  it('falls back to Apple ID, app-specific password and team', () => {
    expect(notarizeCredentials(APPLE_ID_ENV)).toEqual({
      appleId: 'release@example.com',
      appleIdPassword: 'abcd-efgh-ijkl-mnop',
      teamId: 'ABCDE12345',
    });
  });

  it('needs every part of a credential set', () => {
    expect(notarizeCredentials({ APPLE_API_KEY: '/tmp/k.p8' })).toBeNull();
    expect(notarizeCredentials({ APPLE_ID: 'a', APPLE_TEAM_ID: 'b' })).toBeNull();
    expect(notarizeCredentials({})).toBeNull();
  });
});

describe('notarizeApp', () => {
  it('notarizes the signed .app with the CI credentials', async () => {
    const notarize = vi.fn(async () => undefined);
    await notarizeApp(context, { env: API_KEY_ENV, notarize, log: () => undefined });
    expect(notarize).toHaveBeenCalledWith({
      appPath: '/build/release/mac-universal/OpenBots.app',
      appleApiKey: '/tmp/AuthKey.p8',
      appleApiKeyId: 'T9GPZ92M7K',
      appleApiIssuer: 'c055ca8c-e5a8-4836-b61d-aa5794eeb3f4',
    });
  });

  it('skips without credentials: the unsigned dev build', async () => {
    const notarize = vi.fn(async () => undefined);
    const log = vi.fn();
    await notarizeApp(context, { env: {}, notarize, log });
    expect(notarize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping notarization/));
  });

  it('fails a release that requires notarization but has no credentials', async () => {
    const notarize = vi.fn(async () => undefined);
    await expect(
      notarizeApp(context, { env: { OPENBOTS_REQUIRE_NOTARIZATION: '1' }, notarize }),
    ).rejects.toThrow(/credentials are missing/);
  });

  it('does nothing for other platforms', async () => {
    const notarize = vi.fn(async () => undefined);
    await notarizeApp(
      { ...context, electronPlatformName: 'linux' },
      { env: API_KEY_ENV, notarize },
    );
    expect(notarize).not.toHaveBeenCalled();
  });
});
