import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client.js';

// Dependency probes for `GET /readyz`. Each resolves to true or false within
// its timeout and never throws.

const TIMEOUT_MS = 2000;

/**
 * Where the standalone image's disk watcher writes `low` when the data
 * volume is nearly full (`ok` otherwise). Absent elsewhere.
 */
export const DISK_STATUS_FILE = '/run/openbots-status/disk';
/** How long one read of the disk status file is trusted. */
export const DISK_STATUS_TTL_MS = 30_000;

let diskFile = DISK_STATUS_FILE;
let diskCache: { at: number; state: 'ok' | 'low' } | null = null;

/** Points `diskState` at another file, and forgets what it read: for tests. */
export function setDiskStatusFile(file: string): void {
  diskFile = file;
  diskCache = null;
}

/**
 * `low` while the disk status file says so, else `ok` (no file included).
 * Read at most once every DISK_STATUS_TTL_MS. A full disk is reported, never
 * a reason to be not ready: the server stays in rotation and says why it
 * struggles.
 */
export async function diskState(now = Date.now()): Promise<'ok' | 'low'> {
  if (diskCache && now - diskCache.at < DISK_STATUS_TTL_MS) return diskCache.state;
  let state: 'ok' | 'low' = 'ok';
  try {
    state = (await readFile(diskFile, 'utf8')).trim() === 'low' ? 'low' : 'ok';
  } catch {
    // No file: no watcher, nothing to report.
  }
  diskCache = { at: now, state };
  return state;
}

export async function databaseReady(db: Db, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  try {
    await withTimeout(db.execute(sql`select 1`), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends a Redis `PING` over a bare socket and waits for `+PONG`. Enough for a
 * readiness check without pulling in a Redis client before the queue leaf does.
 */
export function redisReady(url: string, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port || 6379) });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('error', () => done(false));
    socket.on('connect', () => {
      const password = decodeURIComponent(parsed.password);
      const user = decodeURIComponent(parsed.username);
      if (password) socket.write(command(user ? ['AUTH', user, password] : ['AUTH', password]));
      socket.write(command(['PING']));
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.startsWith('-')) done(false);
      else if (buffer.includes('+PONG')) done(true);
    });
  });
}

function command(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
