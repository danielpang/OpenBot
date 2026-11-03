import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('config', () => {
  it('defaults to port 3200 on every interface with no push', () => {
    expect(loadConfig({})).toEqual({
      port: 3200,
      host: '0.0.0.0',
      trustProxy: false,
      logLevel: 'info',
      apnsMissing: [],
    });
  });

  it('reads every setting', () => {
    const config = loadConfig({
      RELAY_PORT: '8443',
      RELAY_HOST: '127.0.0.1',
      RELAY_TRUST_PROXY: 'true',
      RELAY_APNS_KEY_FILE: '/run/secrets/apns.p8',
      RELAY_APNS_KEY_ID: 'ABC123DEFG',
      RELAY_APNS_TEAM_ID: 'TEAM123456',
      RELAY_APNS_TOPIC: 'dev.openbots.app',
      RELAY_APNS_ENVIRONMENT: 'sandbox',
      RELAY_LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      port: 8443,
      host: '127.0.0.1',
      trustProxy: true,
      logLevel: 'debug',
      apns: {
        keyFile: '/run/secrets/apns.p8',
        keyId: 'ABC123DEFG',
        teamId: 'TEAM123456',
        topic: 'dev.openbots.app',
        environment: 'sandbox',
      },
    });
  });

  it('leaves push off and names what is missing when only some APNs settings are set', () => {
    const config = loadConfig({ RELAY_APNS_KEY_ID: 'ABC123DEFG', RELAY_APNS_TOPIC: '' });
    expect(config.apns).toBeUndefined();
    expect(config.apnsMissing).toEqual([
      'RELAY_APNS_KEY_FILE',
      'RELAY_APNS_TEAM_ID',
      'RELAY_APNS_TOPIC',
    ]);
  });

  it('refuses a bad port or environment', () => {
    expect(() => loadConfig({ RELAY_PORT: 'many' })).toThrow(/RELAY_PORT/);
    expect(() => loadConfig({ RELAY_APNS_ENVIRONMENT: 'staging' })).toThrow(
      /RELAY_APNS_ENVIRONMENT/,
    );
  });
});
