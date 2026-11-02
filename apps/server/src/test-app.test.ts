import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-app.js';

// The harness itself: tests must not need a writable /data (the image's
// files directory), so CI runners and laptops run the suite as is.

describe('createTestApp', () => {
  let a: TestApp;
  let b: TestApp;
  let named: TestApp;
  let namedDir: string;

  beforeAll(async () => {
    namedDir = await mkdtemp(path.join(tmpdir(), 'openbots-named-'));
    [a, b, named] = await Promise.all([
      createTestApp(),
      createTestApp(),
      createTestApp({ OPENBOTS_FILES_DIR: namedDir }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([a?.close(), b?.close(), named?.close()]);
    await rm(namedDir, { recursive: true, force: true });
  });

  it('stores files in its own temporary directory and removes it on close', async () => {
    const dir = a.deps.config.filesDir;
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(b.deps.config.filesDir).not.toBe(dir);
    await a.close();
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a files directory the test names', async () => {
    expect(named.deps.config.filesDir).toBe(namedDir);
    await named.close();
    expect(existsSync(namedDir)).toBe(true);
  });
});
