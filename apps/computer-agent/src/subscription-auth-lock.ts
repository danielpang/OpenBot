import { spawn } from 'node:child_process';

/** Also held by the image's Claude/Codex launchers. Never delete or replace this inode. */
export const SUBSCRIPTION_AUTH_LOCK = 'openbots-auth.lock';

// Python is already shipped in the computer image. Its flock is the same advisory
// lock as the launchers' util-linux flock, unlike pi's mkdir-based auth.json.lock.
const LOCK = `import fcntl, os, signal, sys
signal.signal(signal.SIGTERM, signal.SIG_IGN)
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print('locked', flush=True)
sys.stdin.buffer.read()
`;

/** Cancellation may stop a lock wait, but never interrupt a rotated token's commit. */
export async function withSubscriptionAuthLock<T>(
  path: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const child = spawn('python3', ['-c', LOCK, path], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  let acquired = false;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const abort = () => {
    if (!acquired) child.kill('SIGKILL');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Subscription credential lock is unavailable')));
      child.once('exit', () =>
        reject(signal?.aborted ? signal.reason : new Error('Subscription credential lock closed')),
      );
      child.stdout.once('data', () => {
        acquired = true;
        signal?.removeEventListener('abort', abort);
        resolve();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return await work();
  } finally {
    signal?.removeEventListener('abort', abort);
    child.stdin.end();
    if (!acquired) child.kill('SIGKILL');
    await closed;
  }
}
