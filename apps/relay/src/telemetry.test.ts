import { describe, expect, it, vi } from 'vitest';
import { RelayMetrics } from './metrics.js';
import { isErrorClose, PostHogTelemetry } from './telemetry.js';

interface Sent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown> & { $exception_list?: { type: string }[] };
}

function setup() {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
  );
  const telemetry = new PostHogTelemetry({
    apiKey: 'phc_test',
    flushMs: 3_600_000,
    fetch: fetchMock as unknown as typeof fetch,
  });
  const sent = () =>
    fetchMock.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(init.body as string) as { batch: Sent[] };
      return body.batch;
    });
  return { telemetry, fetchMock, sent };
}

describe('PostHogTelemetry', () => {
  it('sends nothing when nothing happened', async () => {
    const { telemetry, fetchMock } = setup();
    await telemetry.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    await telemetry.close();
  });

  it('sums usage into one anonymous event and resets', async () => {
    const { telemetry, sent } = setup();
    const metrics = new RelayMetrics({ defaultMetrics: false, telemetry });
    metrics.connected('host');
    metrics.connected('client');
    metrics.connected('client');
    metrics.forwarded('to_host', 10);
    metrics.forwarded('to_client', 20);
    metrics.forwarded('to_client', 20);
    metrics.pushSent();
    metrics.pushFailed();
    await telemetry.flush();
    const [usage] = sent();
    expect(usage?.event).toBe('relay_usage');
    expect(usage?.properties).toMatchObject({
      new_connections: 3,
      new_host_links: 1,
      new_client_streams: 2,
      messages: 3,
      messages_to_host: 1,
      messages_to_client: 2,
      pushes_sent: 1,
      pushes_failed: 1,
      $process_person_profile: false,
    });
    await telemetry.flush();
    expect(sent()).toHaveLength(1);
    await telemetry.close();
  });

  it('reports abnormal disconnects and 500s as grouped exceptions, and ignores normal closes', async () => {
    const { telemetry, sent } = setup();
    const metrics = new RelayMetrics({ defaultMetrics: false, telemetry });
    metrics.closed('host', 1011);
    metrics.closed('host', 1011);
    metrics.closed('client', 1013);
    for (const code of [1000, 1001, 1012, 4404, 4410, 4429]) metrics.closed('client', code);
    metrics.failed({ type: 'http_500', where: 'upgrade' });
    await telemetry.flush();
    const events = sent();
    expect(events.every((e) => e.event === '$exception')).toBe(true);
    expect(events).toHaveLength(3);
    const host = events.find((e) => e.properties.close_code === 1011);
    expect(host?.properties.occurrences).toBe(2);
    expect(host?.properties.$exception_list?.[0]?.type).toBe('RelayDisconnect');
    expect(JSON.stringify(events)).not.toMatch(/hostId|remote/);
    await telemetry.close();
  });

  it('never throws when PostHog is down', async () => {
    const telemetry = new PostHogTelemetry({
      apiKey: 'k',
      flushMs: 3_600_000,
      fetch: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    });
    telemetry.connection('host');
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await telemetry.close();
  });

  it('classifies close codes', () => {
    expect(isErrorClose(1011)).toBe(true);
    expect(isErrorClose(1000)).toBe(false);
    expect(isErrorClose(undefined)).toBe(false);
  });
});
