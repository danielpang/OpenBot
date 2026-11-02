// Background jobs and event fan-out. The server ships two implementations of
// each: BullMQ and Redis pub/sub when REDIS_URL is set, in-memory otherwise
// (tests, and `pnpm dev` without Redis). Both behave the same way.

/** Run priorities (plan 5.1). Lower runs first. */
export const PRIORITY = {
  /** The owner is waiting: a message, a mention, a widget action, a resume. */
  interactive: 1,
  /** Group replies, Bot to Bot, webhooks. */
  normal: 2,
  /** Routines. */
  background: 3,
} as const;

export interface EnqueueOptions {
  /** 1 is highest; defaults to `PRIORITY.normal`. */
  priority?: number;
  /**
   * Jobs sharing a group key run one at a time (a Bot's run lock). Queued jobs
   * in a group start by priority, then age.
   */
  groupKey?: string;
  /** Hold the job back this long before it can start. */
  delayMs?: number;
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  priority: number;
  groupKey?: string;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface ProcessOptions {
  /** Jobs run at once by this process, across groups. Defaults to 1. */
  concurrency?: number;
  /** Called when a handler throws; the job is not retried. */
  onError?: (error: unknown, job: Job) => void;
}

export interface JobQueue<T = unknown> {
  /** Adds a job and returns its id. */
  enqueue(name: string, data: T, options?: EnqueueOptions): Promise<string>;
  /** Starts handling jobs in this process. Call at most once per queue. */
  process(handler: JobHandler<T>, options?: ProcessOptions): Promise<void>;
  /** Removes a job that has not started. Returns false if it is running, done, or unknown. */
  cancel(jobId: string): Promise<boolean>;
  /** Stops taking jobs and waits for running ones to finish. */
  close(): Promise<void>;
}

export type Unsubscribe = () => Promise<void>;

export interface EventBus {
  /** Delivers `event` to every subscriber of `channel`, in every process. */
  publish<E>(channel: string, event: E): Promise<void>;
  subscribe<E>(channel: string, handler: (event: E) => void): Promise<Unsubscribe>;
  close(): Promise<void>;
}
