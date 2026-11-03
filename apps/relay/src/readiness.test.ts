import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  checkReadiness,
  minClusterSizeFromEnv,
  readyHandler,
  relayConditions,
  type RelayReadinessInputs,
} from './readiness.js';

function inputs(overrides: Partial<RelayReadinessInputs> = {}): RelayReadinessInputs {
  return {
    draining: () => false,
    registryReachable: () => true,
    clusterSize: () => 3,
    minClusterSize: 2,
    atCapacity: () => false,
    ...overrides,
  };
}

async function get(conditions: ReturnType<typeof relayConditions>, timeoutMs?: number) {
  const app = new Hono();
  app.get('/ready', readyHandler(conditions, timeoutMs === undefined ? {} : { timeoutMs }));
  const response = await app.request('/ready');
  return { status: response.status, body: (await response.json()) as unknown, response };
}

describe('readiness', () => {
  it('is ready when nothing stands in the way', async () => {
    const { status, body, response } = await get(relayConditions(inputs()));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is unready while draining', async () => {
    const { status, body } = await get(relayConditions(inputs({ draining: () => true })));
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'unready', reasons: ['draining'] });
  });

  it('stays ready without the registry, and reports the degradation', async () => {
    const result = await checkReadiness(
      relayConditions(inputs({ registryReachable: async () => false })),
    );
    expect(result).toEqual({ ready: true, degraded: ['registry_unreachable'] });
    const { status, body } = await get(
      relayConditions(inputs({ registryReachable: async () => false })),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', degraded: ['registry_unreachable'] });
  });

  it('is unready below the minimum cluster size', async () => {
    const result = await checkReadiness(
      relayConditions(inputs({ clusterSize: async () => 1, minClusterSize: 2 })),
    );
    expect(result).toEqual({ ready: false, reasons: ['cluster_too_small'], degraded: [] });
    expect(
      await checkReadiness(relayConditions(inputs({ clusterSize: () => 2, minClusterSize: 2 }))),
    ).toEqual({ ready: true, degraded: [] });
  });

  it('is unready at the socket ceiling', async () => {
    const result = await checkReadiness(relayConditions(inputs({ atCapacity: () => true })));
    expect(result).toEqual({ ready: false, reasons: ['at_capacity'], degraded: [] });
  });

  it('reports every reason at once, in a fixed order', async () => {
    const { status, body } = await get(
      relayConditions({
        draining: () => true,
        registryReachable: () => false,
        clusterSize: () => 0,
        minClusterSize: 3,
        atCapacity: () => true,
      }),
    );
    expect(status).toBe(503);
    expect(body).toEqual({
      status: 'unready',
      reasons: ['draining', 'cluster_too_small', 'at_capacity'],
      degraded: ['registry_unreachable'],
    });
  });

  it('counts a check that throws, rejects or hangs against readiness', async () => {
    const result = await checkReadiness(
      relayConditions(
        inputs({
          registryReachable: () => new Promise<boolean>(() => undefined),
          clusterSize: () => Promise.reject(new Error('redis gone')),
          atCapacity: () => {
            throw new Error('no ledger');
          },
        }),
      ),
      { timeoutMs: 20 },
    );
    expect(result).toEqual({
      ready: false,
      reasons: ['cluster_too_small', 'at_capacity'],
      degraded: ['registry_unreachable'],
    });
  });

  it('asks only draining and capacity on a single machine without Redis', async () => {
    const conditions = relayConditions({ draining: () => false, atCapacity: () => false });
    expect(conditions.map((c) => c.reason)).toEqual(['draining', 'at_capacity']);
    expect(await checkReadiness(conditions)).toEqual({ ready: true, degraded: [] });
  });

  it('skips the cluster size with a minimum of 1', () => {
    const conditions = relayConditions(inputs({ minClusterSize: 1, clusterSize: () => 0 }));
    expect(conditions.map((c) => c.reason)).not.toContain('cluster_too_small');
  });

  it('takes conditions the relay adds', async () => {
    const result = await checkReadiness([
      ...relayConditions(inputs()),
      { reason: 'memory_pressure', unready: () => true },
    ]);
    expect(result).toEqual({ ready: false, reasons: ['memory_pressure'], degraded: [] });
  });

  it('reads RELAY_MIN_CLUSTER_SIZE', () => {
    expect(minClusterSizeFromEnv({})).toBe(1);
    expect(minClusterSizeFromEnv({ RELAY_MIN_CLUSTER_SIZE: '2' })).toBe(2);
    expect(() => minClusterSizeFromEnv({ RELAY_MIN_CLUSTER_SIZE: '0' })).toThrow();
  });
});
