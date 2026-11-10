import { describe, expect, it, vi } from 'vitest';
import { RelayMetrics } from './metrics.js';
import { connectClient, linkHost, makeHost, prefixed, startRelay } from './test/helpers.js';
import { isErrorClose, PostHogTelemetry, type Telemetry } from './telemetry.js';

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
    for (const code of [1000, 1001, 1008, 1012, 4400, 4404, 4410, 4429])
      metrics.closed('client', code);
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
    expect(isErrorClose(1013)).toBe(true);
    expect(isErrorClose(1008)).toBe(false);
    expect(isErrorClose(4400)).toBe(false);
    expect(isErrorClose(1000)).toBe(false);
    expect(isErrorClose(undefined)).toBe(false);
  });
});

describe('when PostHog is down', () => {
  it('warns once, drops the batch, and recovers', async () => {
    const warn = vi.fn();
    const debug = vi.fn();
    let up = false;
    const telemetry = new PostHogTelemetry({
      apiKey: 'k',
      flushMs: 3_600_000,
      logger: { warn, debug } as never,
      fetch: (async () =>
        up ? new Response('{}') : new Response('no', { status: 401 })) as unknown as typeof fetch,
    });
    telemetry.connection('host');
    await telemetry.flush();
    telemetry.connection('host');
    await telemetry.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    up = true;
    telemetry.connection('host');
    await telemetry.flush();
    await telemetry.close();
  });

  it('close waits about a second at most for a hanging PostHog', async () => {
    const telemetry = new PostHogTelemetry({
      apiKey: 'k',
      flushMs: 3_600_000,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    telemetry.connection('client');
    const started = Date.now();
    await telemetry.close();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not stop the relay: a telemetry that throws on every call changes nothing', async () => {
    const boom = () => {
      throw new Error('telemetry broke');
    };
    const broken: Telemetry = {
      connection: boom,
      message: boom,
      push: boom,
      error: boom,
      close: async () => boom(),
    };
    const relay = await startRelay({ telemetry: broken });
    const host = makeHost();
    const hostLink = await linkHost(relay, host);
    const { client, stream } = await connectClient(relay, host, hostLink);
    client.send(Buffer.from('hello'));
    const got = await hostLink.binary();
    expect(got).toEqual(prefixed(stream, Buffer.from('hello')));
    const text = await relay.metrics.render();
    expect(text).toContain('openbots_relay_connections_total{kind="host"} 1');
    expect(text).toContain('openbots_relay_connections_total{kind="client"} 1');
    expect(text).toContain('openbots_relay_messages_total{direction="to_host"} 1');
  });

  it('does not stop the relay: PostHog refusing every send changes nothing', async () => {
    const telemetry = new PostHogTelemetry({
      apiKey: 'k',
      flushMs: 100,
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    const relay = await startRelay({ telemetry });
    const host = makeHost();
    const hostLink = await linkHost(relay, host);
    const { client } = await connectClient(relay, host, hostLink);
    client.send(Buffer.from('hi'));
    await hostLink.binary();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await fetch(`${relay.url}/healthz`);
    expect(res.status).toBe(200);
  });
});
