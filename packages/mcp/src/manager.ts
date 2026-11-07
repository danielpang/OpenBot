import { DEFAULT_PROCESS_LIMITS } from '@openbots/shared';
import type { McpHost, McpHostOptions, ToolCallResult } from './host.js';
import type { McpSnapshot, McpTool } from './types.js';

// The MCP client manager (plan 8): one session per connector, started on first
// use, stopped after `idleMs` without use, pinged by a health loop, and
// restarted when the connector's config or secrets change (a new `version`).
// It knows nothing about the database; the server supplies `resolve` (build a
// host for a connector id) and the callbacks that persist what it learns.
//
// A session that asks for it (`restartOnCrash`: a stdio server in the owner's
// computer) is started again when its server exits on its own, after a
// backoff that doubles with each exit in a row. A restart is resolved with
// `restart: true`, and may throw `RestartSkipped` to stay down quietly: the
// computer it ran in was stopped, say. Otherwise sessions start lazily, on
// the next call.

export interface ConnectorSession {
  id: string;
  /** Changes whenever config or secrets change; a session on an older version is replaced. */
  version: string;
  create(options: McpHostOptions): McpHost;
  /** Start it again, with backoff, when its server exits on its own. */
  restartOnCrash?: boolean;
}

/** Thrown while resolving or starting a restart that should not happen; nothing is recorded. */
export class RestartSkipped extends Error {
  constructor(message = 'Not restarted') {
    super(message);
    this.name = 'RestartSkipped';
  }
}

export interface RestartBackoff {
  /** The wait before the first restart; it doubles with each exit in a row. */
  initialMs: number;
  maxMs: number;
  /** Exits in a row after which it stays down until the next call. */
  maxAttempts: number;
  /** A session that ran this long before exiting starts the count again. */
  stableMs: number;
}

export const DEFAULT_RESTART_BACKOFF: RestartBackoff = {
  initialMs: 1_000,
  maxMs: 60_000,
  maxAttempts: 5,
  stableMs: 5 * 60_000,
};

export interface McpManagerOptions {
  /** Builds the session for a connector; throws when it may not start (blocked, missing login). */
  resolve(connectorId: string, context?: { restart: boolean }): Promise<ConnectorSession>;
  /** After every successful start. */
  onStarted?(connectorId: string, snapshot: McpSnapshot): Promise<void> | void;
  /** After `tools/list_changed`, with the new list. */
  onToolsChanged?(connectorId: string, tools: McpTool[]): Promise<void> | void;
  /** When a start, ping or session fails. */
  onError?(connectorId: string, error: Error): Promise<void> | void;
  /** A session unused this long is stopped; the server passes OPENBOTS_MCP_IDLE_STOP_MINUTES. */
  idleMs?: number;
  healthIntervalMs?: number;
  requestTimeoutMs?: number;
  /** For sessions with `restartOnCrash`; `DEFAULT_RESTART_BACKOFF` fills what is left out. */
  restartBackoff?: Partial<RestartBackoff>;
  now?: () => number;
}

interface Session {
  version: string;
  host: McpHost;
  startedAt: number;
  lastUsed: number;
  /** Calls in flight; an idle check never stops a session that is busy. */
  busy: number;
}

/** `idleMs` when none is given: the process limit's default, 10 minutes. */
export const DEFAULT_IDLE_MS: number = DEFAULT_PROCESS_LIMITS.mcpIdleStopMinutes * 60_000;
/**
 * How often the health loop pings each session and stops idle ones, so an
 * idle session stops up to this much after `idleMs`. Internal: it trades a
 * ping a minute per running server against noticing a dead one late.
 */
export const DEFAULT_HEALTH_MS = 60_000;

export class McpManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<
    string,
    Promise<{ session: Session; snapshot: McpSnapshot }>
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Restarts waiting for their backoff, by connector. */
  private readonly restarts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Exits in a row, by connector. */
  private readonly crashes = new Map<string, number>();
  private readonly now: () => number;
  private readonly backoff: RestartBackoff;
  /** How long a session may go unused before the health loop stops it. */
  readonly idleMs: number;

  constructor(private readonly options: McpManagerOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.backoff = { ...DEFAULT_RESTART_BACKOFF, ...options.restartBackoff };
  }

  /** Starts the health loop (idle stop plus ping). */
  startHealthLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.checkHealth(),
      this.options.healthIntervalMs ?? DEFAULT_HEALTH_MS,
    );
    this.timer.unref?.();
  }

  /** Whether a session is running for the connector. */
  running(connectorId: string): boolean {
    return this.sessions.has(connectorId);
  }

  /** The running host, started if needed. */
  async host(connectorId: string): Promise<McpHost> {
    return (await this.session(connectorId)).host;
  }

  async callTool(
    connectorId: string,
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolCallResult> {
    const session = await this.session(connectorId);
    session.busy++;
    try {
      return await session.host.callTool(name, args, options);
    } finally {
      session.busy--;
      session.lastUsed = this.now();
    }
  }

  /** Restarts the connector's session and returns what it lists (the Test button). */
  async test(connectorId: string, options?: { automatic?: boolean }): Promise<McpSnapshot> {
    await this.stop(connectorId);
    // Automatic checks use the crash-restart contract: a computer that has
    // stopped since preflight must stay stopped, even at the launch boundary.
    const { snapshot } = await this.startSession(connectorId, options?.automatic ?? false);
    return snapshot;
  }

  /** Whether a restart after a crash is waiting for its backoff. */
  restarting(connectorId: string): boolean {
    return this.restarts.has(connectorId);
  }

  async stop(connectorId: string): Promise<void> {
    this.cancelRestart(connectorId);
    await this.starting.get(connectorId)?.catch(() => {});
    const session = this.sessions.get(connectorId);
    if (!session) return;
    this.sessions.delete(connectorId);
    await session.host.close().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of [...this.restarts.keys()]) this.cancelRestart(id);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  /** One pass of the health loop; exported for tests. */
  async checkHealth(): Promise<void> {
    const now = this.now();
    const { idleMs } = this;
    await Promise.all(
      [...this.sessions.entries()].map(async ([id, session]) => {
        if (session.busy === 0 && now - session.lastUsed >= idleMs) {
          await this.stop(id);
          return;
        }
        try {
          await session.host.ping();
        } catch (err) {
          if (this.sessions.get(id) === session) await this.stop(id);
          await this.options.onError?.(id, err as Error);
        }
      }),
    );
  }

  private async session(connectorId: string): Promise<Session> {
    const pending = this.starting.get(connectorId);
    if (pending) return (await pending).session;
    const existing = this.sessions.get(connectorId);
    if (existing) {
      const spec = await this.options.resolve(connectorId);
      if (spec.version === existing.version && this.sessions.get(connectorId) === existing) {
        existing.lastUsed = this.now();
        return existing;
      }
      await this.stop(connectorId);
    }
    return (await this.startSession(connectorId)).session;
  }

  private startSession(connectorId: string, restart = false) {
    const pending = this.starting.get(connectorId);
    if (pending) return pending;
    const promise = (async () => {
      const spec = await this.options.resolve(connectorId, { restart });
      const ref: { session?: Session } = {};
      const host = spec.create({
        requestTimeoutMs: this.options.requestTimeoutMs,
        onToolsChanged: (tools) => void this.options.onToolsChanged?.(connectorId, tools),
        onClose: () => {
          const session = ref.session;
          if (session && this.sessions.get(connectorId) === session) {
            this.sessions.delete(connectorId);
            if (spec.restartOnCrash) this.scheduleRestart(connectorId, session.startedAt);
          }
        },
      });
      let snapshot: McpSnapshot;
      try {
        snapshot = await host.start();
      } catch (err) {
        await host.close().catch(() => {});
        if (!(err instanceof RestartSkipped))
          await this.options.onError?.(connectorId, err as Error);
        throw err;
      }
      const now = this.now();
      const session: Session = {
        version: spec.version,
        host,
        startedAt: now,
        lastUsed: now,
        busy: 0,
      };
      ref.session = session;
      this.sessions.set(connectorId, session);
      await this.options.onStarted?.(connectorId, snapshot);
      return { session, snapshot };
    })();
    this.starting.set(connectorId, promise);
    void promise.then(
      () => this.starting.delete(connectorId),
      () => this.starting.delete(connectorId),
    );
    return promise;
  }

  /** After a session's server exited on its own: start it again once the backoff passes. */
  private scheduleRestart(connectorId: string, startedAt: number) {
    if (this.restarts.has(connectorId)) return;
    const { initialMs, maxMs, maxAttempts, stableMs } = this.backoff;
    const crashes =
      this.now() - startedAt >= stableMs ? 1 : (this.crashes.get(connectorId) ?? 0) + 1;
    this.crashes.set(connectorId, crashes);
    if (crashes > maxAttempts) {
      this.crashes.delete(connectorId);
      void this.options.onError?.(
        connectorId,
        new Error(
          `The server exited ${maxAttempts} times in a row. It starts again on the next call.`,
        ),
      );
      return;
    }
    const timer = setTimeout(
      () => {
        this.restarts.delete(connectorId);
        if (this.sessions.has(connectorId) || this.starting.has(connectorId)) return;
        const attempt = this.now();
        this.startSession(connectorId, true).catch((err: unknown) => {
          if (err instanceof RestartSkipped) this.crashes.delete(connectorId);
          // A failed start counts as another exit; `onError` has recorded it.
          else this.scheduleRestart(connectorId, attempt);
        });
      },
      Math.min(initialMs * 2 ** (crashes - 1), maxMs),
    );
    timer.unref?.();
    this.restarts.set(connectorId, timer);
  }

  private cancelRestart(connectorId: string) {
    const timer = this.restarts.get(connectorId);
    if (timer) clearTimeout(timer);
    this.restarts.delete(connectorId);
    this.crashes.delete(connectorId);
  }
}
