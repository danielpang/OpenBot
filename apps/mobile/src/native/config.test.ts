import type { ConfigContext, ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it } from 'vitest';
import appConfig from '../../app.config';

function loadConfig(): ExpoConfig {
  return appConfig({ config: {} } as ConfigContext);
}

function intentData(config: ExpoConfig) {
  return (config.android?.intentFilters ?? []).flatMap((filter) => {
    const data = filter.data;
    return data === undefined ? [] : Array.isArray(data) ? data : [data];
  });
}

describe('Expo Android project config', () => {
  const previousPackage = process.env.OPENBOTS_ANDROID_PACKAGE;
  const previousVersionCode = process.env.OPENBOTS_ANDROID_VERSION_CODE;

  afterEach(() => {
    if (previousPackage === undefined) delete process.env.OPENBOTS_ANDROID_PACKAGE;
    else process.env.OPENBOTS_ANDROID_PACKAGE = previousPackage;
    if (previousVersionCode === undefined) delete process.env.OPENBOTS_ANDROID_VERSION_CODE;
    else process.env.OPENBOTS_ANDROID_VERSION_CODE = previousVersionCode;
  });

  it('includes Android and iOS with the default package and pairing App Link', () => {
    delete process.env.OPENBOTS_ANDROID_PACKAGE;
    delete process.env.OPENBOTS_ANDROID_VERSION_CODE;
    const config = loadConfig();
    expect(config.platforms).toEqual(['ios', 'android']);
    expect(config.android?.package).toBe('dev.openbots.mobile');
    expect(config.android?.versionCode).toBe(1);
    expect(intentData(config)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scheme: 'openbots' }),
        expect.objectContaining({ scheme: 'https', host: 'openbots.dev', path: '/pair' }),
      ]),
    );
  });
});
