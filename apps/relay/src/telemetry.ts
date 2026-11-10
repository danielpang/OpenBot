import type { Logger } from 'pino';

// Anonymous usage data for the shared relay, sent to PostHog (docs/TERMS.md
// section 4). It is off unless `RELAY_POSTHOG_KEY` is set, so a self-hosted
// relay sends nothing.
//
// What it carries is counts and error kinds, never who or what:
//   - `relay_usage`, once a minute and only when something happened: new host
//     links, new client streams, messages forwarded each way, pushes sent.
//     (Traffic is end to end encrypted, so the relay cannot tell a chat
//     message from a setting change; both are messages here.)
//   - `$exception` (PostHog error tracking): disconnects the relay forced for
//     an abnormal reason, and 500s. One event per kind per minute, with a count.
// Nothing carries a host id, an address, a token, a close reason a peer chose,
// or the text of an error. Events set `$process_person_profile: false` and
// `$geoip_disable`, and share one random id per process, which the process
// does not keep across restarts.

export type TelemetrySocketKind = 'host' | 'client';

export type TelemetryErrorKind =
  | { type: 'disconnect'; socket: TelemetrySocketKind; code: number }
  | { type: 'http_500'; where: 'upgrade' | 'route' }
  | { type: 'frame_failed' };

/** What the relay tells its telemetry. Every call is cheap and never throws. */
export interface Telemetry {
  connection(kind: TelemetrySocketKind): void;
  message(direction: 'to_host' | 'to_client'): void;
  push(ok: boolean): void;
  error(kind: TelemetryErrorKind): void;
  /** Sends what is pending now, and stops the timer. */
  close(): Promise<void>;
}

export const NO_TELEMETRY: Telemetry = {
  connection() {},
  message() {},
  push() {},
  error() {},
  async close() {},
};

/** Close codes that mean something went wrong, not a normal end, a deploy or an absent host. */
const ERROR_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009, 1011, 1013, 4400]);

export function isErrorClose(code: number | undefined): code is number {
  return code !== undefined && ERROR_CLOSE_CODES.has(code);
}

export interface PostHogOptions {
  apiKey: string;
  /** Default `https://us.i.posthog.com`. */
  host?: string;
  /** How often pending counts are sent. Default 60 seconds. */
  flushMs?: number;
  /** Tagged on every event, e.g. the release. */
  version?: string;
  logger?: Logger;
  /** For tests. */
  fetch?: typeof fetch;
}

interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export class PostHogTelemetry implements Telemetry {
  private readonly endpoint: string;
  private readonly distinctId = `relay-${crypto.randomUUID()}`;
  private readonly send: typeof fetch;
  private readonly timer: NodeJS.Timeout;
  private connections: Record<TelemetrySocketKind, number> = { host: 0, client: 0 };
  private messages = { to_host: 0, to_client: 0 };
  private pushes = { ok: 0, failed: 0 };
  private errors = new Map<string, { kind: TelemetryErrorKind; count: number }>();

  constructor(private readonly options: PostHogOptions) {
    this.endpoint = `${(options.host ?? 'https://us.i.posthog.com').replace(/\/+$/, '')}/batch/`;
    this.send = options.fetch ?? fetch;
    this.timer = setInterval(() => void this.flush(), options.flushMs ?? 60_000);
    this.timer.unref();
  }

  connection(kind: TelemetrySocketKind): void {
    this.connections[kind]++;
  }

  message(direction: 'to_host' | 'to_client'): void {
    this.messages[direction]++;
  }

  push(ok: boolean): void {
    this.pushes[ok ? 'ok' : 'failed']++;
  }

  error(kind: TelemetryErrorKind): void {
    const key = JSON.stringify(kind);
    const seen = this.errors.get(key);
    if (seen) seen.count++;
    else this.errors.set(key, { kind, count: 1 });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** Sends and clears what is pending. A failed send drops it: telemetry never queues or retries. */
  async flush(): Promise<void> {
    const events = this.drain();
    if (events.length === 0) return;
    try {
      const res = await this.send(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.options.apiKey, batch: events }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) this.options.logger?.debug({ status: res.status }, 'telemetry not accepted');
    } catch {
      this.options.logger?.debug('telemetry not sent');
    }
  }

  private drain(): PostHogEvent[] {
    const timestamp = new Date().toISOString();
    const base = {
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'openbots-relay',
      ...(this.options.version ? { relay_version: this.options.version } : {}),
    };
    const make = (event: string, properties: Record<string, unknown>): PostHogEvent => ({
      event,
      distinct_id: this.distinctId,
      properties: { ...base, ...properties },
      timestamp,
    });
    const events: PostHogEvent[] = [];
    const { connections, messages, pushes } = this;
    if (
      connections.host +
        connections.client +
        messages.to_host +
        messages.to_client +
        pushes.ok +
        pushes.failed >
      0
    ) {
      events.push(
        make('relay_usage', {
          new_host_links: connections.host,
          new_client_streams: connections.client,
          new_connections: connections.host + connections.client,
          messages_to_host: messages.to_host,
          messages_to_client: messages.to_client,
          messages: messages.to_host + messages.to_client,
          pushes_sent: pushes.ok,
          pushes_failed: pushes.failed,
        }),
      );
    }
    for (const { kind, count } of this.errors.values()) {
      events.push(make('$exception', exceptionProperties(kind, count)));
    }
    this.connections = { host: 0, client: 0 };
    this.messages = { to_host: 0, to_client: 0 };
    this.pushes = { ok: 0, failed: 0 };
    this.errors = new Map();
    return events;
  }
}

/** PostHog's error tracking shape, with fixed text so nothing a peer sent reaches it. */
function exceptionProperties(kind: TelemetryErrorKind, count: number): Record<string, unknown> {
  const [type, value, extra]: [string, string, Record<string, unknown>] =
    kind.type === 'disconnect'
      ? [
          'RelayDisconnect',
          `${kind.socket} socket closed by the relay with ${kind.code}`,
          { socket: kind.socket, close_code: kind.code },
        ]
      : kind.type === 'http_500'
        ? ['RelayHttp500', `500 on ${kind.where}`, { where: kind.where, status: 500 }]
        : ['RelayFrameFailed', 'a host frame failed', {}];
  return {
    $exception_list: [{ type, value, mechanism: { handled: true, synthetic: true } }],
    $exception_level: 'error',
    $exception_fingerprint: `${type}:${value}`,
    occurrences: count,
    ...extra,
  };
}
