import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Infra } from '../infra/index.js';

/** What a CLI command works with; main.ts makes it, tests make their own. */
export interface CliContext {
  config: Config;
  /** The app's database, under row-level security like the server's (db/scope.ts). */
  db: Db;
  /** For `device.revoked`, so a running server's relay adapter closes the device's streams. */
  infra: Pick<Infra, 'bus'>;
  /** One line of output. */
  write(line: string): void;
  /** For `openbots relay`'s presence check; the global fetch by default. */
  fetch?: typeof fetch;
}

/** A command's answer: the exit code. */
export type CliResult = Promise<number>;
