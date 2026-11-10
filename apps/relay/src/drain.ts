import { positiveIntFromEnv } from './budget.js';

// Draining a machine (docs/plans/MOBILE_AND_VM_PLAN.md 5.8, "Each machine on its
// own"). On SIGTERM, or at boot with `RELAY_DRAIN=true`, the machine stops
// taking work and hands its hosts to the others before it goes:
//
// 1. It reports not ready (`draining` is true, which `/ready` reads), so
//    Fly's proxy stops sending it new connections.
// 2. It stops accepting new upgrades and taking new leases (`stopAccepting`).
// 3. It gives up the leases it holds (`releaseLeases`), so another machine
//    can take each host as soon as its server reconnects.
// 4. Right after, it closes its host links with 1012 (`closeLinks`), each
//    once the pushes in flight on it are answered, so servers relink to
//    another machine at once instead of leaving their hosts looking offline
//    for the grace period. A client stream goes on until its link closes.
// 5. After the grace period, or sooner once nothing is left (`idle`), it
//    waits (within the grace) for pushes still in flight to be answered
//    (`settle`), then closes its remaining links and streams with 1012
//    (`closeAll`). Servers and phones reconnect through normal routing to a
//    machine that owns, or will take, their host.
//
// The controller only sequences these. The callbacks belong to the relay, and
// a callback that throws is reported and does not stop the drain.

/** WebSocket close code 1012, service restart: reconnect, another machine will serve you. */
export const SERVICE_RESTART = 1012;

export interface DrainOptions {
  /** How long existing links and streams may keep going. Default 20 seconds. */
  graceMs: number;
  /** How often `idle` is asked during the grace period. Default 1 second. */
  idlePollMs: number;
}

export const DEFAULT_DRAIN: DrainOptions = {
  graceMs: 20_000,
  idlePollMs: 1_000,
};

export interface DrainHooks {
  /** Refuse new upgrades and take no new leases from now on. */
  stopAccepting(): void | Promise<void>;
  /** Give up every lease this machine holds. */
  releaseLeases(): void | Promise<void>;
  /** Close every host link with `code` (1012) once its pushes in flight are answered. */
  closeLinks?(code: typeof SERVICE_RESTART, reason: string): void | Promise<void>;
  /** Settles once the pushes in flight are answered. Awaited only within the grace. */
  settle?(): Promise<void>;
  /** Close every link and stream still open with `code` (1012). */
  closeAll(code: typeof SERVICE_RESTART, reason: string): void | Promise<void>;
  /** True once no link or stream is left, to finish before the grace period ends. */
  idle?(): boolean;
  /** A hook threw or rejected. The drain carries on. */
  onError?(step: DrainStep, error: unknown): void;
}

export type DrainStep = 'stopAccepting' | 'releaseLeases' | 'closeLinks' | 'settle' | 'closeAll';

export type DrainPhase = 'serving' | 'draining' | 'closing' | 'drained';

export type DrainTrigger = 'signal' | 'env' | 'manual';

/** What a signal handler needs from `process`; a test passes an emitter. */
export interface SignalSource {
  on(signal: 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGTERM', listener: () => void): unknown;
}

export class DrainController {
  readonly options: DrainOptions;
  private current: DrainPhase = 'serving';
  private started: Promise<void> | undefined;
  private why: DrainTrigger | undefined;

  constructor(
    private readonly hooks: DrainHooks,
    options: Partial<DrainOptions> = {},
  ) {
    this.options = { ...DEFAULT_DRAIN, ...options };
  }

  /** True from the moment the drain starts: the machine is not ready. */
  get draining(): boolean {
    return this.current !== 'serving';
  }

  get phase(): DrainPhase {
    return this.current;
  }

  /** What started the drain, once it has. */
  get trigger(): DrainTrigger | undefined {
    return this.why;
  }

  /**
   * Starts the drain, or answers the one already running. The promise
   * settles once every link and stream has been closed.
   */
  start(trigger: DrainTrigger = 'manual'): Promise<void> {
    if (!this.started) {
      this.why = trigger;
      this.current = 'draining';
      this.started = this.run();
    }
    return this.started;
  }

  /** Starts the drain on SIGTERM. Answers a function that removes the handler. */
  listen(signals: SignalSource = process): () => void {
    const onSignal = () => void this.start('signal');
    signals.on('SIGTERM', onSignal);
    return () => signals.off('SIGTERM', onSignal);
  }

  private async run(): Promise<void> {
    await this.step('stopAccepting', () => this.hooks.stopAccepting());
    await this.step('releaseLeases', () => this.hooks.releaseLeases());
    const deadline = Date.now() + this.options.graceMs;
    await this.step('closeLinks', () =>
      this.hooks.closeLinks?.(SERVICE_RESTART, 'relay restarting, reconnect'),
    );
    await this.grace();
    const settle = this.hooks.settle;
    if (settle) {
      await this.step('settle', () => within(settle(), Math.max(0, deadline - Date.now())));
    }
    this.current = 'closing';
    await this.step('closeAll', () =>
      this.hooks.closeAll(SERVICE_RESTART, 'relay restarting, reconnect'),
    );
    this.current = 'drained';
  }

  private grace(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      };
      const deadline = setTimeout(finish, this.options.graceMs);
      const poll = setInterval(() => {
        if (this.isIdle()) finish();
      }, this.options.idlePollMs);
      if (this.isIdle()) finish();
    });
  }

  private isIdle(): boolean {
    try {
      return this.hooks.idle?.() ?? false;
    } catch {
      return false;
    }
  }

  private async step(step: DrainStep, run: () => void | Promise<void>) {
    try {
      await run();
    } catch (error) {
      this.hooks.onError?.(step, error);
    }
  }
}

/** Whether `RELAY_DRAIN` asks the machine to start draining. */
export function drainRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RELAY_DRAIN ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  throw new Error(`RELAY_DRAIN must be true or false, not ${JSON.stringify(env.RELAY_DRAIN)}`);
}

/** `RELAY_DRAIN_GRACE_MS`. */
export function drainOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DrainOptions {
  return {
    ...DEFAULT_DRAIN,
    graceMs: positiveIntFromEnv(env, 'RELAY_DRAIN_GRACE_MS', DEFAULT_DRAIN.graceMs),
  };
}

/** Waits for `promise`, or `ms`, whichever is first. */
function within(promise: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
