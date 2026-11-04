import type { MobileTransport } from './index';

export interface LifecycleOptions {
  connect(signal: AbortSignal): Promise<MobileTransport>;
  /** Restore subscriptions and perform REST resync here on every foreground connection. */
  onConnected(transport: MobileTransport): void | Promise<void>;
  onDisconnected?(): void;
  onError?(error: unknown): void;
  backoffMs?: number;
  maxBackoffMs?: number;
}

/** Owns a connection generation so a late handshake cannot revive a background socket. */
export class TransportLifecycle {
  private active = false;
  private disposed = false;
  private generation = 0;
  private attempts = 0;
  private transport: MobileTransport | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LifecycleOptions) {}

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.attempts = 0;
      void this.connect();
    } else this.disconnect();
  }

  reconnect(): void {
    if (!this.active || this.disposed) return;
    this.disconnect();
    const delay = Math.min(
      this.options.maxBackoffMs ?? 30_000,
      (this.options.backoffMs ?? 500) * 2 ** this.attempts++,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private disconnect(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.transport?.close();
    this.transport = null;
    this.options.onDisconnected?.();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const transport = await this.options.connect(controller.signal);
      if (generation !== this.generation || !this.active || this.disposed) {
        transport.close();
        return;
      }
      this.transport = transport;
      await this.options.onConnected(transport);
      if (generation === this.generation) this.attempts = 0;
    } catch (error) {
      if (generation !== this.generation || !this.active || this.disposed) return;
      this.options.onError?.(error);
      this.reconnect();
    }
  }

  close(): void {
    this.active = false;
    this.disposed = true;
    this.disconnect();
  }
}
