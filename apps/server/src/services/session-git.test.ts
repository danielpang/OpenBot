import { describe, expect, it } from 'vitest';
import { looksSecret, porcelainPaths, worktreeRelative } from './session-git.js';

describe('the safety-net commit', () => {
  it('leaves out new files whose names read like secrets', () => {
    for (const path of [
      '.env',
      'app/.env.local',
      'deploy.pem',
      'server.KEY',
      'cert.p12',
      'cert.pfx',
      'home/id_rsa',
      'id_ed25519.pub',
      'aws-credentials.json',
      'db.secret.yaml',
      'github_token.txt',
    ]) {
      expect(looksSecret(path), path).toBe(true);
    }
    for (const path of ['notes.md', 'src/env.ts', 'keys/README.md', 'secretary.ts']) {
      expect(looksSecret(path), path).toBe(false);
    }
  });

  it('reads what git reports changed, and what the agent touched inside the worktree', () => {
    expect(porcelainPaths(' M src/a.ts\0?? new file.md\0R  b.ts\0old b.ts\0 D gone.ts\0')).toEqual([
      'src/a.ts',
      'new file.md',
      'b.ts',
      'old b.ts',
      'gone.ts',
    ]);
    const wt = '/home/bot/repos/acme/relay/.worktrees/bot-x';
    expect(worktreeRelative(wt, `${wt}/src/a.ts`)).toBe('src/a.ts');
    expect(worktreeRelative(wt, 'src/./a.ts')).toBe('src/a.ts');
    expect(worktreeRelative(wt, '../other/a.ts')).toBeNull();
    expect(worktreeRelative(wt, '/etc/passwd')).toBeNull();
    expect(worktreeRelative(wt, `${wt}-other/a.ts`)).toBeNull();
  });
});
