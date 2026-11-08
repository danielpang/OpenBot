import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUBSCRIPTION_AUTH_LOCK, withSubscriptionAuthLock } from './subscription-auth-lock.js';

/** Clear credentials under the same locks as refresh, without unlinking a live lock inode. */
export async function signOutSubscription(
  agent: 'claude' | 'codex' | 'pi',
  authDir: string,
  modules = '/opt/openbots/coders/node_modules',
) {
  const { FileAuthStorageBackend } = (await import(
    `${modules}/@earendil-works/pi-coding-agent/dist/core/auth-storage.js`
  )) as {
    FileAuthStorageBackend: new (path: string) => {
      withLockAsync(fn: () => Promise<{ result: undefined; next: string }>): Promise<undefined>;
    };
  };
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const auth = agent === 'claude' ? '.credentials.json' : 'auth.json';
  await withSubscriptionAuthLock(join(authDir, SUBSCRIPTION_AUTH_LOCK), undefined, () =>
    new FileAuthStorageBackend(join(authDir, auth)).withLockAsync(async () => {
      for (const entry of await readdir(authDir)) {
        if (![SUBSCRIPTION_AUTH_LOCK, auth, `${auth}.lock`].includes(basename(entry)))
          await rm(join(authDir, entry), { recursive: true, force: true });
      }
      return { result: undefined, next: '{}' };
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agent = process.argv[2];
  const authDir =
    process.env[
      agent === 'claude'
        ? 'CLAUDE_CONFIG_DIR'
        : agent === 'codex'
          ? 'CODEX_HOME'
          : 'PI_CODING_AGENT_DIR'
    ];
  if (!['claude', 'codex', 'pi'].includes(agent ?? '') || !authDir) process.exitCode = 1;
  else
    void signOutSubscription(agent as 'claude' | 'codex' | 'pi', authDir).catch(() => {
      process.exitCode = 1;
    });
}
