import { spawn } from 'node:child_process';
import path from 'node:path';
import { childEnv } from './config.js';
import type { ExecEvent, ExecRequest } from './protocol.js';
import { commandIdentity, UNPRIVILEGED, type Users } from './users.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 2000;
const DRAIN_MS = 250;

// Runs one command under `bash -c` in its own process group, so a timeout or
// a dropped client kills everything it started. Events go to `emit` in order;
// the promise settles after `exit`. It runs as the bot user; a command for
// a screen's Bot also gets that screen's group and X environment, so it can
// reach that display and no other (users.ts, S-7).
export function runCommand(
  req: ExecRequest,
  opts: {
    home: string;
    emit: (event: ExecEvent) => void;
    signal?: AbortSignal;
    users?: Users;
    /** DISPLAY and XAUTHORITY for screen `n`. */
    xEnv?: (n: number) => NodeJS.ProcessEnv;
  },
): Promise<void> {
  const { emit, home, signal } = opts;
  const started = Date.now();
  const screenEnv = req.screen === undefined ? undefined : opts.xEnv?.(req.screen);
  const program = (opts.users ?? UNPRIVILEGED).command(commandIdentity(req.screen), '/bin/bash', [
    '-c',
    req.command,
  ]);
  const child = spawn(program.command, program.args, {
    cwd: path.resolve(home, req.cwd ?? '.'),
    // The screen's variables last: a request cannot point a command at another display.
    env: childEnv({ HOME: home }, req.env, screenEnv),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
    } catch {
      // Already gone.
    }
  };
  const stop = () => {
    killGroup('SIGTERM');
    killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, req.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });

  return new Promise((resolve) => {
    let finished = false;
    const finish = (event: ExecEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      emit(event);
      resolve();
    };

    child.once('spawn', () => {
      if (child.pid !== undefined) emit({ type: 'start', pid: child.pid });
    });
    child.stdout.setEncoding('utf8').on('data', (data: string) => emit({ type: 'stdout', data }));
    child.stderr.setEncoding('utf8').on('data', (data: string) => emit({ type: 'stderr', data }));
    child.once('error', (err) => finish({ type: 'error', message: err.message }));
    const exited = (exitCode: number | null, sig: NodeJS.Signals | null) =>
      finish({ type: 'exit', exitCode, signal: sig, timedOut, durationMs: Date.now() - started });
    // `close` waits for stdout and stderr to drain. A background job that
    // still holds them would keep it from firing, so after `exit` give the
    // pipes a moment and then stop reading; the job itself keeps running.
    child.once('close', exited);
    child.once('exit', (exitCode, sig) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        exited(exitCode, sig);
      }, DRAIN_MS).unref();
    });

    child.stdin.on('error', () => {
      // The command exited without reading its stdin.
    });
    child.stdin.end(req.stdin ?? '');
  });
}
