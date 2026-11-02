#!/usr/bin/env node
// node-pty 1.1.0 ships its macOS prebuilds with spawn-helper not executable,
// so every spawn fails with "posix_spawnp failed" and the terminal (WS /pty)
// never opens on a Mac. Linux has no prebuilds and compiles the helper with
// the right mode, so this is a no-op there and in the image. Drop it once a
// node-pty release fixes the file mode.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let root;
try {
  root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
} catch {
  process.exit(0); // node-pty is optional
}

const prebuilds = join(root, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
  }
}
