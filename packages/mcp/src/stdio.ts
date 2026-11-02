import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ClientHost, type McpHostOptions } from './host.js';
import {
  KILL_REFUSED,
  giveTo,
  killCommand,
  launchAs,
  processStartTime,
  unprivilegedUser,
  type Launch,
} from './privileges.js';

// The stdio host (plan 8): the MCP server is a child process of the OpenBots
// process. Its environment is built from scratch, never inherited, so it holds
// PATH, a private HOME (npm's cache inside it, so npx never needs a writable
// global cache) and that connector's own secrets and nothing else: no
// DATABASE_URL, no OPENBOTS_MASTER_KEY, no provider keys (plan 17). When OpenBots
// can switch users (root, or CAP_SETUID and CAP_SETGID, as in the compose
// service) the child runs as an unprivileged user with no capabilities
// (`launchAs`), and `makeNonDumpable` keeps that user out of the server's /proc
// (S-1). The SDK's StdioClientTransport merges the parent's HOME, USER and
// SHELL and cannot set a uid, hence this small transport.

export interface StdioSpawn {
  command: string;
  args: string[];
  /** The complete child environment apart from PATH, HOME and npm's cache. */
  env: Record<string, string>;
  cwd?: string;
  /** Names the per-connector HOME directory; defaults to "default". */
  homeKey?: string;
  /** Overrides the user the child runs as (tests); by default `nobody` when this process can switch users. */
  user?: { uid: number; gid: number } | null;
}

/** Variables the child gets from the server environment; everything else comes from the connector. */
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The exact environment a stdio child receives. */
export function childEnvironment(spec: StdioSpawn, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH || BASE_PATH,
    HOME: home,
    npm_config_cache: join(home, '.npm'),
    ...spec.env,
  };
}

function prepareHome(key: string, user: { uid: number; gid: number } | null): string {
  // The parent is traversable so a dropped user can reach its own 0700 HOME inside it.
  const parent = join(tmpdir(), 'openbots-mcp');
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  try {
    chmodSync(parent, 0o711);
  } catch {
    // Owned by another user; it was created traversable.
  }
  const home = join(parent, key.replace(/[^A-Za-z0-9_-]/g, '_'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (user) giveTo(home, user);
  return home;
}

export class StdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The last lines the child wrote to stderr, for `last_error`. */
  stderrTail = '';
  private child: ChildProcess | undefined;
  /** The user the child runs as, when it is not this process's own. */
  private user: { uid: number; gid: number } | null = null;
  /** The child's start time at spawn, so the kill helper can tell its pid was not reused. */
  private startTime: string | undefined;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly spec: StdioSpawn) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    if (this.child) throw new Error('stdio transport already started');
    const user = this.spec.user === undefined ? unprivilegedUser() : this.spec.user;
    let launch: Launch;
    try {
      launch = user
        ? launchAs(user, this.spec.command, this.spec.args)
        : { command: this.spec.command, args: this.spec.args };
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const home = prepareHome(this.spec.homeKey ?? 'default', user);
    this.user = user;
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        env: childEnvironment(this.spec, home),
        cwd: this.spec.cwd ?? home,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: false,
        ...(launch.uid === undefined ? {} : { uid: launch.uid, gid: launch.gid }),
      });
      this.child = child;
      child.on('error', (err) => {
        reject(err);
        this.onerror?.(err);
      });
      child.on('spawn', () => {
        // Unreaped until 'exit', so this pid is still the child's.
        if (child.pid !== undefined) this.startTime = processStartTime(child.pid);
        resolve();
      });
      child.on('close', () => {
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin?.on('error', (err) => this.onerror?.(err));
      child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (!message) break;
          this.onmessage?.(message);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) return reject(new Error('stdio server is not running'));
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const wait = (ms: number) =>
      Promise.race([closed, new Promise<void>((r) => setTimeout(r, ms).unref())]);
    child.stdin?.end();
    await wait(2000);
    await terminate(
      () => child.exitCode === null && child.signalCode === null,
      (signal) => this.signal(child, signal),
      wait,
    );
    this.buffer.clear();
  }

  /**
   * Signals the child, resolving once the signal was sent or refused. One
   * running as another user is out of this process's reach without CAP_KILL,
   * so a helper running as that user sends it (`killCommand`), and only if the
   * pid still has the start time recorded at spawn: the child may be reaped
   * between the caller's check and the helper's `kill`, and its pid given to
   * another process of that user, such as another stdio server.
   */
  private signal(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    let helper: Launch | null;
    try {
      helper =
        this.user && child.pid !== undefined
          ? killCommand(this.user, child.pid, signal, this.startTime)
          : null;
    } catch (err) {
      this.onerror?.(err as Error);
      return Promise.resolve();
    }
    if (!helper) {
      // Node signals only a child it has not reaped.
      child.kill(signal);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const kill = spawn(helper.command, helper.args, {
        env: { PATH: '/usr/bin:/bin' },
        stdio: 'ignore',
      });
      kill.on('error', (err) => {
        this.onerror?.(err);
        resolve();
      });
      kill.on('close', (code) => {
        // KILL_REFUSED: the pid is gone or belongs to another process now.
        if (code && code !== KILL_REFUSED) {
          this.onerror?.(
            new Error(`could not send ${signal} to stdio server ${child.pid} (exit ${code})`),
          );
        }
        resolve();
      });
    });
  }
}

/**
 * Stops a child that did not exit when its stdin closed: SIGTERM, a grace
 * period, then SIGKILL. `running` is checked right before each signal, and
 * SIGKILL waits until the SIGTERM was sent (its helper finished) and the grace
 * period passed, so two helpers never race for the same pid.
 */
export async function terminate(
  running: () => boolean,
  send: (signal: NodeJS.Signals) => Promise<void>,
  wait: (ms: number) => Promise<void>,
  graceMs = 2000,
): Promise<void> {
  if (!running()) return;
  await send('SIGTERM');
  await wait(graceMs);
  if (!running()) return;
  await send('SIGKILL');
}

export class StdioHost extends ClientHost {
  readonly transport = 'stdio' as const;
  private current: StdioTransport | undefined;

  constructor(
    private readonly spec: StdioSpawn,
    options?: McpHostOptions,
  ) {
    super(options);
  }

  /** The child's pid while running (tests). */
  get pid(): number | undefined {
    return this.current?.pid;
  }

  /** What the child last wrote to stderr; useful when start fails. */
  get stderr(): string {
    return this.current?.stderrTail ?? '';
  }

  protected createTransport(): Transport {
    this.current = new StdioTransport(this.spec);
    return this.current;
  }
}
