import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import type { Logger } from 'pino';

// The APNs gateway (docs/RELAY_PROTOCOL.md 3.3). A host sends an encrypted
// notice and a device token; the relay wraps the ciphertext in a generic
// alert and posts it to Apple over HTTP/2 with provider token authentication:
// an ES256 JWT signed with the project's `.p8` key, reused for 50 minutes
// (Apple refuses one older than an hour and throttles fresh ones). The relay
// keeps no tokens and logs counts only: a device token never reaches a log
// line, and neither does the ciphertext.

export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';

const TOKEN_LIFETIME_MS = 50 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const COUNT_LOG_INTERVAL_MS = 60_000;

export interface ApnsOptions {
  /** The `.p8` key's PEM text. */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id, sent as `apns-topic`. */
  topic: string;
  environment?: 'production' | 'sandbox';
  /** Overrides the origin `environment` picks, for a test's fake APNs. */
  origin?: string;
  /** How long one request may take before it answers `error`. */
  timeoutMs?: number;
}

/** One validated `push` frame, less its id. */
export interface PushRequest {
  token: string;
  ciphertext: string;
  priority: 5 | 10;
  expiresAt: number;
  collapseId?: string;
  threadId?: string;
}

export type PushOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'unregistered' | 'unavailable' | 'invalid' | 'error';
      status: number | null;
    };

export interface PushGateway {
  send(push: PushRequest): Promise<PushOutcome>;
  close(): Promise<void>;
}

/** The gateway of a relay with no APNs credentials: every push is `unavailable`. */
export const NO_PUSH: PushGateway = {
  send: () => Promise.resolve({ ok: false, reason: 'unavailable', status: null }),
  close: () => Promise.resolve(),
};

type Counted = 'ok' | 'unregistered' | 'invalid' | 'error';

export class ApnsGateway implements PushGateway {
  private readonly key: KeyObject;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private session: http2.ClientHttp2Session | undefined;
  private token: { jwt: string; madeAt: number } | undefined;
  private readonly counts: Record<Counted, number> = {
    ok: 0,
    unregistered: 0,
    invalid: 0,
    error: 0,
  };
  private readonly countLog: NodeJS.Timeout;

  constructor(
    private readonly options: ApnsOptions,
    private readonly logger?: Logger,
  ) {
    this.key = createPrivateKey(options.keyPem);
    this.origin =
      options.origin ?? (options.environment === 'sandbox' ? APNS_SANDBOX : APNS_PRODUCTION);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.countLog = setInterval(() => this.logCounts(), COUNT_LOG_INTERVAL_MS);
    this.countLog.unref();
  }

  async send(push: PushRequest): Promise<PushOutcome> {
    const outcome = await this.post(push).catch((error: unknown) => {
      this.logger?.warn({ err: String(error) }, 'apns request failed');
      return { ok: false, reason: 'error', status: null } as const;
    });
    this.counts[outcome.ok ? 'ok' : (outcome.reason as Counted)] += 1;
    return outcome;
  }

  async close(): Promise<void> {
    clearInterval(this.countLog);
    this.logCounts();
    const session = this.session;
    this.session = undefined;
    if (session && !session.closed) {
      await new Promise<void>((resolve) => session.close(() => resolve()));
    }
  }

  private post(push: PushRequest): Promise<PushOutcome> {
    const aps: Record<string, unknown> = {
      alert: { title: 'OpenBots', body: 'You have a notification' },
      'mutable-content': 1,
    };
    if (push.threadId !== undefined) aps['thread-id'] = push.threadId;
    const body = JSON.stringify({ aps, enc: push.ciphertext });
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${push.token}`,
      authorization: `bearer ${this.jwt()}`,
      'apns-push-type': 'alert',
      'apns-priority': String(push.priority),
      'apns-expiration': String(push.expiresAt),
      'apns-topic': this.options.topic,
      'content-type': 'application/json',
    };
    if (push.collapseId !== undefined) headers['apns-collapse-id'] = push.collapseId;

    return new Promise<PushOutcome>((resolve, reject) => {
      const request = this.connect().request(headers);
      let status = 0;
      let text = '';
      request.setEncoding('utf8');
      request.setTimeout(this.timeoutMs, () => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('apns request timed out'));
      });
      request.on('response', (response) => {
        status = Number(response[':status']);
      });
      request.on('data', (chunk: string) => {
        text += chunk;
      });
      request.on('end', () => resolve(this.outcome(status, text)));
      request.on('error', reject);
      request.end(body);
    });
  }

  /** Maps an APNs answer to `push.result` (3.3). */
  private outcome(status: number, text: string): PushOutcome {
    if (status === 200) return { ok: true };
    const reason = apnsReason(text);
    // Apple answers 403 for a token it no longer accepts; the next request
    // signs a fresh one.
    if (status === 403 && /ProviderToken/.test(reason ?? '')) this.token = undefined;
    this.logger?.info({ status, apnsReason: reason }, 'apns refused a push');
    if (status === 410) return { ok: false, reason: 'unregistered', status };
    if (status === 400) return { ok: false, reason: 'invalid', status };
    return { ok: false, reason: 'error', status };
  }

  /** One HTTP/2 session, made again after Apple or the network closes it. */
  private connect(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(this.origin);
    session.on('error', (error) => {
      this.logger?.warn({ err: String(error) }, 'apns session failed');
    });
    session.on('close', () => {
      if (this.session === session) this.session = undefined;
    });
    session.on('goaway', () => {
      if (this.session === session) this.session = undefined;
    });
    // An idle session should not keep the process alive.
    session.unref();
    this.session = session;
    return session;
  }

  /** The provider token, signed again once it is 50 minutes old. */
  private jwt(): string {
    const now = Date.now();
    if (this.token && now - this.token.madeAt < TOKEN_LIFETIME_MS) return this.token.jwt;
    const header = base64UrlJson({ alg: 'ES256', kid: this.options.keyId });
    const claims = base64UrlJson({ iss: this.options.teamId, iat: Math.floor(now / 1000) });
    const input = `${header}.${claims}`;
    // ES256 in a JWT is the raw r || s pair, not DER.
    const signature = sign('sha256', Buffer.from(input), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    this.token = { jwt: `${input}.${signature}`, madeAt: now };
    return this.token.jwt;
  }

  private logCounts() {
    const total = Object.values(this.counts).reduce((sum, n) => sum + n, 0);
    if (total === 0) return;
    this.logger?.info({ pushes: { ...this.counts } }, 'apns pushes');
    for (const key of Object.keys(this.counts) as Counted[]) this.counts[key] = 0;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function apnsReason(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
      return typeof parsed.reason === 'string' ? parsed.reason : undefined;
    }
  } catch {
    // Apple's errors are JSON; anything else has no reason to report.
  }
  return undefined;
}
