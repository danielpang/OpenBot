import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

// The narrow slice of child_process the stack manager uses, so tests can drive
// it with mocks instead of a real Docker.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Runs a command to completion. Never rejects on a non-zero exit: check `code`. */
export type Exec = (file: string, args: string[], options?: ProcessOptions) => Promise<ExecResult>;

export interface ChildLike {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Starts a long-running command (log tailing). */
export type Spawn = (file: string, args: string[], options?: ProcessOptions) => ChildLike;

export const nodeExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: options?.env, cwd: options?.cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // ENOENT and friends have a string code; an exit status is a number.
        const code = error == null ? 0 : typeof error.code === 'number' ? error.code : 127;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
      },
    );
  });

export const nodeSpawn: Spawn = (file, args, options) =>
  spawn(file, args, { env: options?.env, cwd: options?.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Feeds `onLine` one line at a time from a chunked stream, holding a partial
 * last line until the next chunk or `flush`.
 */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (pending !== '') onLine(pending);
      pending = '';
    },
  };
}
