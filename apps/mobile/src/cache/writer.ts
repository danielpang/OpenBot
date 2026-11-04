import type { SnapshotCache } from './index';

/** Coalesces streaming deltas into durable snapshots without writing a whole
 * transcript for every token. close() flushes the final pending snapshot. */
export class SnapshotWriter<T> {
  private latest: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = Promise.resolve();
  private closed = false;
  constructor(
    private readonly cache: SnapshotCache,
    private readonly hostId: string,
    private readonly key: string,
    private readonly delayMs = 250,
  ) {}

  schedule(value: T): void {
    if (this.closed) return;
    this.latest = { value };
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const latest = this.latest;
    this.latest = null;
    if (latest)
      this.writes = this.writes
        .then(() => this.cache.set(this.hostId, this.key, latest.value))
        .catch(() => {});
    return this.writes;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }
}
