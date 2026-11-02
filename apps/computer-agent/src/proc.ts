import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { childEnv } from './config.js';
import { AgentError } from './errors.js';
import { BOT, UNPRIVILEGED, type Identity, type Users } from './users.js';

// The two ways the agent starts programs: short commands whose output it
// needs (xdotool, import, feh) and long-running daemons (Xvfb, the window
// manager, x11vnc, Chromium). Both are injectable so tests can stand in. A
// short command can run as another user (users.ts) and take its secret on
// stdin, never in argv or the environment.

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Who runs it; the bot user when unset. */
  user?: Identity;
  /** Written to its stdin. */
  input?: Uint8Array | string;
}

export type Run = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export type SpawnDaemon = (command: string, args: string[], opts: SpawnOptions) => ChildProcess;

export const createRun =
  (users: Users): Run =>
  (command, args, opts = {}) =>
    new Promise((resolve, reject) => {
      // Never as the agent itself where it can switch users: a child left
      // with the agent's real uid 0 could take root back.
      const program = users.command(opts.user ?? BOT, command, args);
      const child = spawn(program.command, program.args, {
        env: childEnv(opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 30_000,
      });
      child.stdin.on('error', () => {
        // It exited without reading its input; `close` reports why.
      });
      child.stdin.end(opts.input ?? '');
      const out: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.once('error', (err) =>
        reject(new AgentError(500, 'COMMAND_FAILED', `${command}: ${err.message}`)),
      );
      child.once('close', (code, signal) => {
        if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr });
        const why = signal ? `killed by ${signal}` : `exit ${code}`;
        reject(
          new AgentError(500, 'COMMAND_FAILED', `${command} failed (${why}): ${stderr.trim()}`),
        );
      });
    });

/** Short commands as the agent itself (dev, tests); main.ts builds its own. */
export const run: Run = createRun(UNPRIVILEGED);

export const spawnDaemon: SpawnDaemon = (command, args, opts) => spawn(command, args, opts);

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns true or `timeoutMs` passes. */
export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline)
      throw new AgentError(500, 'START_TIMEOUT', `Timed out waiting for ${what}`);
    await delay(intervalMs);
  }
}
