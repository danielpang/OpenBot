import { chmodSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

// The files directory, out of reach of stdio MCP servers (S-1). They run as
// another user (`nobody`), which may pass through OPENBOTS_FILES_DIR on its way
// to a filesystem connector's folder under `connectors/` and nothing more:
// uploads sit in two-character shard directories, and under `orgs/` (plan
// 21.3), only the server may enter.
// main.ts sets a 077 umask, so new shards and files are private; this closes
// up the ones made before.

export function protectFilesDir(filesDir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(filesDir, { withFileTypes: true });
  } catch {
    return; // not made yet: the first upload makes it, under the umask
  }
  chmodSync(filesDir, 0o711);
  for (const entry of entries) {
    if (entry.isDirectory() && (/^[0-9a-f]{2}$/.test(entry.name) || entry.name === 'orgs')) {
      chmodSync(path.join(filesDir, entry.name), 0o700);
    }
  }
}
