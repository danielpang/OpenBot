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
//
// Each push names its APNs environment (`production`, the App Store and
// TestFlight builds, or `sandbox`, a development build), and the gateway keeps
// one HTTP/2 session and one provider token per environment. A push never
// throws: whatever fails, from signing the token to the network, answers
// `error`.

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
  /** The environment of a push that names none. Default production. */
  environment?: ApnsEnvironment;
  /** Overrides the origin of every environment, for a test's fake APNs. */
  origin?: string;
  /** Overrides the origin of one environment, for a test's fake APNs. */
  origins?: Partial<Record<ApnsEnvironment, string>>;
  /** How long one request may take before it answers `error`. */
  timeoutMs?: number;
}

export type ApnsEnvironment = 'production' | 'sandbox';

/** One validated `push` frame, less its id. */
export interface PushRequest {
  token: string;
  /** Which APNs gateway the token belongs to. Default production. */
  environment?: ApnsEnvironment;
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
  private readonly timeoutMs: number;
  private readonly sessions: Partial<Record<ApnsEnvironment, http2.ClientHttp2Session>> = {};
  private readonly tokens: Partial<Record<ApnsEnvironment, { jwt: string; madeAt: number }>> = {};
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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.countLog = setInterval(() => this.logCounts(), COUNT_LOG_INTERVAL_MS);
    this.countLog.unref();
  }

  /** The origin pushes for `environment` go to. */
  origin(environment: ApnsEnvironment): string {
    return (
      this.options.origins?.[environment] ??
      this.options.origin ??
      (environment === 'sandbox' ? APNS_SANDBOX : APNS_PRODUCTION)
    );
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
    const sessions = Object.values(this.sessions);
    for (const environment of Object.keys(this.sessions) as ApnsEnvironment[]) {
      delete this.sessions[environment];
    }
    await Promise.all(
      sessions.map((session) =>
        session.closed ? undefined : new Promise<void>((resolve) => session.close(() => resolve())),
      ),
    );
  }

  /** Never throws: everything, the token's signature included, happens inside the promise. */
  private post(push: PushRequest): Promise<PushOutcome> {
    return new Promise<PushOutcome>((resolve, reject) => {
      try {
        this.request(push, resolve, reject);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private request(
    push: PushRequest,
    resolve: (outcome: PushOutcome) => void,
    reject: (error: Error) => void,
  ): void {
    const environment = push.environment ?? this.options.environment ?? 'production';
    const aps: Record<string, unknown> = {
      alert: { title: 'OpenBots', body: 'You have a notification' },
      'mutable-content': 1,
    };
    if (push.threadId !== undefined) aps['thread-id'] = push.threadId;
    const body = JSON.stringify({ aps, enc: push.ciphertext });
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${push.token}`,
      authorization: `bearer ${this.jwt(environment)}`,
      'apns-push-type': 'alert',
      'apns-priority': String(push.priority),
      'apns-expiration': String(push.expiresAt),
      'apns-topic': this.options.topic,
      'content-type': 'application/json',
    };
    if (push.collapseId !== undefined) headers['apns-collapse-id'] = push.collapseId;

    const request = this.connect(environment).request(headers);
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
    request.on('end', () => resolve(this.outcome(environment, status, text)));
    request.on('error', reject);
    request.end(body);
  }

  /** Maps an APNs answer to `push.result` (3.3). */
  private outcome(environment: ApnsEnvironment, status: number, text: string): PushOutcome {
    if (status === 200) return { ok: true };
    const reason = apnsReason(text);
    // Apple answers 403 for a token it no longer accepts; the next request
    // signs a fresh one.
    if (status === 403 && /ProviderToken/.test(reason ?? '')) delete this.tokens[environment];
    this.logger?.info({ status, apnsReason: reason, environment }, 'apns refused a push');
    if (status === 410) return { ok: false, reason: 'unregistered', status };
    // The token itself is wrong for this app or environment: the host forgets it.
    if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) {
      return { ok: false, reason: 'invalid', status };
    }
    return { ok: false, reason: 'error', status };
  }

  /** One HTTP/2 session per environment, made again after Apple or the network closes it. */
  private connect(environment: ApnsEnvironment): http2.ClientHttp2Session {
    const current = this.sessions[environment];
    if (current && !current.closed && !current.destroyed) return current;
    const session = http2.connect(this.origin(environment));
    session.on('error', (error) => {
      this.logger?.warn({ err: String(error), environment }, 'apns session failed');
    });
    const forget = () => {
      if (this.sessions[environment] === session) delete this.sessions[environment];
    };
    session.on('close', forget);
    session.on('goaway', forget);
    // An idle session should not keep the process alive.
    session.unref();
    this.sessions[environment] = session;
    return session;
  }

  /** The provider token of one environment, signed again once it is 50 minutes old. */
  private jwt(environment: ApnsEnvironment): string {
    const now = Date.now();
    const token = this.tokens[environment];
    if (token && now - token.madeAt < TOKEN_LIFETIME_MS) return token.jwt;
    const header = base64UrlJson({ alg: 'ES256', kid: this.options.keyId });
    const claims = base64UrlJson({ iss: this.options.teamId, iat: Math.floor(now / 1000) });
    const input = `${header}.${claims}`;
    // ES256 in a JWT is the raw r || s pair, not DER.
    const signature = sign('sha256', Buffer.from(input), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const jwt = `${input}.${signature}`;
    this.tokens[environment] = { jwt, madeAt: now };
    return jwt;
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
