import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { NodeBudget } from './budget.js';
import { metricsHandler, RelayMetrics } from './metrics.js';

function app(metrics: RelayMetrics, token: string | undefined) {
  const hono = new Hono();
  hono.get('/metrics', metricsHandler(metrics, token));
  return hono;
}

describe('RelayMetrics', () => {
  it('counts what happens', async () => {
    const metrics = new RelayMetrics({ defaultMetrics: false });
    metrics.replayed('host');
    metrics.replayed('client');
    metrics.replayed('client');
    metrics.rejected('sockets');
    metrics.rejected('draining');
    metrics.forwarded('to_client', 1_000);
    metrics.forwarded('to_client', 24);
    metrics.forwarded('to_host', 7);
    metrics.shed('client');
    metrics.leaseRenewed(true);
    metrics.leaseRenewed(false);
    metrics.leaseLost('newer_epoch');
    const text = await metrics.render();
    expect(text).toContain('openbots_relay_replays_total{kind="host"} 1');
    expect(text).toContain('openbots_relay_replays_total{kind="client"} 2');
    expect(text).toContain('openbots_relay_rejections_total{reason="sockets"} 1');
    expect(text).toContain('openbots_relay_rejections_total{reason="draining"} 1');
    expect(text).toContain('openbots_relay_bytes_forwarded_total{direction="to_client"} 1024');
    expect(text).toContain('openbots_relay_bytes_forwarded_total{direction="to_host"} 7');
    expect(text).toContain('openbots_relay_shed_peers_total{kind="client"} 1');
    expect(text).toContain('openbots_relay_lease_renewals_total{result="ok"} 1');
    expect(text).toContain('openbots_relay_lease_renewals_total{result="failed"} 1');
    expect(text).toContain('openbots_relay_lease_losses_total{reason="newer_epoch"} 1');
  });

  it('reads the gauges from the live state at scrape time', async () => {
    const metrics = new RelayMetrics({ defaultMetrics: false });
    const budget = new NodeBudget({ maxBytes: 1_000, maxSockets: 10 });
    let streams = 0;
    let draining = false;
    metrics.observe({
      sockets: () => budget.snapshot().socketsByKind,
      hostsOwned: () => 4,
      streams: () => streams,
      pausedSources: () => 2,
      blockedDestinations: () => 1,
      budget: () => budget.snapshot(),
      draining: () => draining,
      clusterSize: () => 3,
    });
    const admission = budget.admit('client');
    if (!admission.ok) throw new Error('expected an admission');
    admission.ticket.reserve(300);
    budget.admit('host');
    streams = 5;
    draining = true;
    const text = await metrics.render();
    expect(text).toContain('openbots_relay_sockets{kind="host"} 1');
    expect(text).toContain('openbots_relay_sockets{kind="client"} 1');
    expect(text).toContain('openbots_relay_hosts_owned 4');
    expect(text).toContain('openbots_relay_streams 5');
    expect(text).toContain('openbots_relay_paused_sources 2');
    expect(text).toContain('openbots_relay_blocked_destinations 1');
    expect(text).toContain('openbots_relay_budget_bytes 300');
    expect(text).toContain('openbots_relay_budget_bytes_limit 1000');
    expect(text).toContain('openbots_relay_budget_sockets_limit 10');
    expect(text).toContain('openbots_relay_draining 1');
    expect(text).toContain('openbots_relay_cluster_size 3');

    admission.ticket.close();
    streams = 0;
    const later = await metrics.render();
    expect(later).toContain('openbots_relay_budget_bytes 0');
    expect(later).toContain('openbots_relay_sockets{kind="client"} 0');
    expect(later).toContain('openbots_relay_streams 0');
  });

  it('reads 0 for a gauge with no source', async () => {
    const metrics = new RelayMetrics({ defaultMetrics: false });
    metrics.observe({ streams: () => 1 });
    const text = await metrics.render();
    expect(text).toContain('openbots_relay_streams 1');
    expect(text).toContain('openbots_relay_hosts_owned 0');
    expect(text).toContain('openbots_relay_cluster_size 0');
    expect(text).not.toContain('openbots_relay_sockets{');
  });

  it('includes Node process metrics by default, under the relay prefix', async () => {
    const metrics = new RelayMetrics();
    expect(await metrics.render()).toContain('openbots_relay_process_cpu_user_seconds_total');
  });

  it('keeps one registry per instance', async () => {
    const a = new RelayMetrics({ defaultMetrics: false });
    const b = new RelayMetrics({ defaultMetrics: false });
    a.rejected('bytes');
    expect(await b.render()).not.toContain('reason="bytes"} 1');
  });
});

describe('GET /metrics', () => {
  it('answers 404 when no token is configured', async () => {
    for (const token of [undefined, '']) {
      const response = await app(new RelayMetrics({ defaultMetrics: false }), token).request(
        '/metrics',
        { headers: { authorization: 'Bearer anything' } },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('answers 401 without the bearer token or with the wrong one', async () => {
    const hono = app(new RelayMetrics({ defaultMetrics: false }), 'secret-token');
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer secret-toke', 'secret-token']) {
      const response = await hono.request('/metrics', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('serves the exposition with the right token', async () => {
    const metrics = new RelayMetrics({ defaultMetrics: false });
    metrics.shed('host');
    const response = await app(metrics, 'secret-token').request('/metrics', {
      headers: { authorization: 'bearer secret-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('openbots_relay_shed_peers_total{kind="host"} 1');
  });
});
