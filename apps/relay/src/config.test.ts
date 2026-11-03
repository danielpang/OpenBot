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
      minClusterSize: 1,
      hostBudgetShare: 0.125,
      cluster: { leaseMs: 30_000, renewMs: 10_000, nodeTtlMs: 15_000, heartbeatMs: 5_000 },
    });
  });

  it('reads the cluster settings, with the node id from FLY_MACHINE_ID by default', () => {
    expect(
      loadConfig({
        RELAY_REDIS_URL: 'redis://redis.internal:6379',
        FLY_MACHINE_ID: '3d8d9e1c2a5e78',
        RELAY_MIN_CLUSTER_SIZE: '2',
        RELAY_LEASE_MS: '9000',
        RELAY_LEASE_RENEW_MS: '3000',
        RELAY_NODE_TTL_MS: '6000',
        RELAY_NODE_HEARTBEAT_MS: '2000',
      }),
    ).toMatchObject({
      redisUrl: 'redis://redis.internal:6379',
      nodeId: '3d8d9e1c2a5e78',
      minClusterSize: 2,
      cluster: { leaseMs: 9000, renewMs: 3000, nodeTtlMs: 6000, heartbeatMs: 2000 },
    });
    expect(loadConfig({ RELAY_NODE_ID: 'relay-a', FLY_MACHINE_ID: 'other' }).nodeId).toBe(
      'relay-a',
    );
    expect(loadConfig({ RELAY_REDIS_URL: '' }).redisUrl).toBeUndefined();
    expect(loadConfig({ RELAY_METRICS_TOKEN: 'a-long-enough-token' }).metricsToken).toBe(
      'a-long-enough-token',
    );
    expect(() => loadConfig({ RELAY_METRICS_TOKEN: 'short' })).toThrow(/RELAY_METRICS_TOKEN/);
    expect(loadConfig({ RELAY_HOST_BUDGET_SHARE: '0.25' }).hostBudgetShare).toBe(0.25);
    for (const bad of ['0', '-0.1', '1.5', 'half']) {
      expect(() => loadConfig({ RELAY_HOST_BUDGET_SHARE: bad })).toThrow(/RELAY_HOST_BUDGET_SHARE/);
    }
  });

  it('refuses cluster timings that could not keep a lease', () => {
    expect(() => loadConfig({ RELAY_LEASE_MS: '5000', RELAY_LEASE_RENEW_MS: '5000' })).toThrow(
      /RELAY_LEASE_RENEW_MS/,
    );
    expect(() => loadConfig({ RELAY_REDIS_URL: 'http://redis' })).toThrow(/RELAY_REDIS_URL/);
    expect(() => loadConfig({ RELAY_NODE_ID: 'has space' })).toThrow(/RELAY_NODE_ID/);
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
