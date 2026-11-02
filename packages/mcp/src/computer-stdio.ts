import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ClientHost, type McpHostOptions } from './host.js';

// The computer stdio host: a stdio MCP server that runs in its owner's
// computer rather than on the server (the managed service, where one server
// hosts every organization). The process is started by the computer's
// control agent and its stdin and stdout travel over the agent's
// authenticated channel; `launch` is that channel, supplied by the server
// (packages/computer's `mcpStdio`), so this package needs no computer code.
// It speaks MCP exactly like `StdioTransport`: newline-delimited JSON-RPC.
//
// While requests are in flight it reports activity every `keepaliveMs`, so
// the server can keep the computer from stopping for idleness mid-call.

/** How a remote stdio process ended. */
export interface RemoteStdioExit {
  exitCode: number | null;
  signal: string | null;
  /** Set when it never ran properly or the channel to it dropped. */
  error?: string;
}

export interface RemoteStdioHandlers {
  stdout(data: string): void;
  stderr(data: string): void;
  /** Called once, when the process ends or the channel to it drops. */
  exit(info: RemoteStdioExit): void;
}

/** A process running elsewhere, as `launch` hands it back. */
export interface RemoteStdio {
  /** Writes to its stdin. */
  write(data: string): void;
  /** Ends it; resolves once the channel is closed. */
  close(): Promise<void>;
}

export interface ComputerStdioSpec {
  /**
   * Starts the server in the computer (starting the computer first when it
   * is off) and resolves once the process runs.
   */
  launch(handlers: RemoteStdioHandlers): Promise<RemoteStdio>;
  /** The computer is in use: on every message, and while requests are in flight. */
  onActivity?(): void;
  /** How often `onActivity` fires while requests are in flight; 30 s by default. */
  keepaliveMs?: number;
}

export const DEFAULT_KEEPALIVE_MS = 30_000;

type Id = string | number;

export class ComputerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The last lines the server wrote to stderr, for `last_error`. */
  stderrTail = '';
  private remote: RemoteStdio | undefined;
  private started = false;
  private closed = false;
  private readonly buffer = new ReadBuffer();
  /** Requests sent and not yet answered. */
  private readonly inFlight = new Set<Id>();
  private keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly spec: ComputerStdioSpec) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('computer stdio transport already started');
    this.started = true;
    this.remote = await this.spec.launch({
      stdout: (data) => this.receive(data),
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-2000);
      },
      exit: (info) => {
        if (this.closed) return;
        if (info.error) this.onerror?.(new Error(info.error));
        this.finish();
      },
    });
    if (this.closed) {
      // Closed while it was starting.
      await this.remote.close();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const remote = this.remote;
    if (!remote || this.closed) throw new Error('The stdio server is not running');
    if ('method' in message && 'id' in message) {
      this.inFlight.add(message.id);
      this.watch();
    }
    this.spec.onActivity?.();
    remote.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const remote = this.remote;
    this.finish();
    await remote?.close();
  }

  private receive(data: string) {
    this.buffer.append(Buffer.from(data, 'utf8'));
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (err) {
        this.onerror?.(err as Error);
        continue;
      }
      if (!message) break;
      if (('result' in message || 'error' in message) && 'id' in message) {
        this.inFlight.delete(message.id as Id);
        this.watch();
      }
      this.spec.onActivity?.();
      this.onmessage?.(message);
    }
  }

  /** Keeps reporting activity while requests are in flight, and stops once none are. */
  private watch() {
    if (this.inFlight.size && !this.keepalive && !this.closed) {
      this.keepalive = setInterval(
        () => this.spec.onActivity?.(),
        this.spec.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
      );
      this.keepalive.unref?.();
    } else if (!this.inFlight.size && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.inFlight.clear();
    this.watch();
    this.buffer.clear();
    this.remote = undefined;
    this.onclose?.();
  }
}

export class ComputerStdioHost extends ClientHost {
  readonly transport = 'stdio' as const;
  private current: ComputerStdioTransport | undefined;

  constructor(
    private readonly spec: ComputerStdioSpec,
    options?: McpHostOptions,
  ) {
    super(options);
  }

  /** What the server last wrote to stderr; useful when start fails. */
  get stderr(): string {
    return this.current?.stderrTail ?? '';
  }

  protected createTransport(): Transport {
    this.current = new ComputerStdioTransport(this.spec);
    return this.current;
  }
}
