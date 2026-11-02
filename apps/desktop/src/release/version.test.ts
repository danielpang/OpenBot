import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/release-version.mjs: the tag of a release must equal the version the
// Mac app and the images are built with.

interface Parsed {
  version: string;
  tag: string;
  minor: string;
  prerelease: boolean;
}

interface VersionModule {
  VERSION_FILES: string[];
  parseVersion(value: string): Parsed | null;
  checkRelease(tag: string, versions: Record<string, string>): Parsed;
  setVersion(text: string, version: string): string;
  main(argv: string[], repoDir?: string): string;
}

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = pathToFileURL(join(repoDir, 'scripts/release-version.mjs')).href;
const { VERSION_FILES, checkRelease, main, parseVersion, setVersion } = (await import(
  script
)) as VersionModule;

const both = (version: string) => Object.fromEntries(VERSION_FILES.map((file) => [file, version]));

describe('release version', () => {
  it('covers the root package and the Mac app', () => {
    expect(VERSION_FILES).toEqual(['package.json', 'apps/desktop/package.json']);
  });

  it('parses releases and prereleases, with the floating major.minor tag', () => {
    expect(parseVersion('1.2.0')).toEqual({
      version: '1.2.0',
      tag: 'v1.2.0',
      minor: '1.2',
      prerelease: false,
    });
    expect(parseVersion('1.3.0-rc.1')).toMatchObject({ minor: '1.3', prerelease: true });
    for (const bad of ['1.2', 'v1.2.0', '01.2.0', '1.2.0+build', '1.2.0-', '']) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it('accepts a tag that matches both package.json versions', () => {
    expect(checkRelease('v1.2.0', both('1.2.0'))).toMatchObject({ version: '1.2.0' });
  });

  it('fails a mismatch, naming the file and how to fix it', () => {
    const versions = { ...both('1.2.0'), 'apps/desktop/package.json': '1.1.0' };
    expect(() => checkRelease('v1.2.0', versions)).toThrow(
      /does not match the release version: apps\/desktop\/package\.json has 1\.1\.0\. Run `node scripts\/release-version\.mjs bump 1\.2\.0`/,
    );
    expect(() => checkRelease('1.2.0', both('1.2.0'))).toThrow(/not a release tag/);
    expect(() => checkRelease('desktop-v1.2.0', both('1.2.0'))).toThrow(/not a release tag/);
  });

  it('sets only the top-level version, keeping the rest of the file', () => {
    const text =
      '{\n  "name": "x",\n  "version": "0.0.0",\n  "dependencies": {\n    "y": "1.0.0"\n  }\n}\n';
    expect(setVersion(text, '1.2.0')).toBe(text.replace('0.0.0', '1.2.0'));
    expect(() => setVersion('{\n  "name": "x"\n}\n', '1.2.0')).toThrow(/version/);
  });

  describe('the command', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function fakeRepo(version: string) {
      dir = mkdtempSync(join(tmpdir(), 'release-version-'));
      for (const file of VERSION_FILES) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), `{\n  "name": "${file}",\n  "version": "${version}"\n}\n`);
      }
    }

    it('bumps both files, then checks and prints the outputs', () => {
      fakeRepo('0.0.0');
      expect(() => main(['check', 'v0.1.0'], dir)).toThrow(/does not match/);
      main(['bump', '0.1.0'], dir);
      for (const file of VERSION_FILES) {
        expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).version).toBe('0.1.0');
      }
      expect(main(['check', 'v0.1.0'], dir)).toBe(
        'version=0.1.0\ntag=v0.1.0\nminor=0.1\nprerelease=false',
      );
      expect(main(['current'], dir)).toBe(main(['check', 'v0.1.0'], dir));
      expect(() => main(['bump', 'v0.2.0'], dir)).toThrow(/usage/);
    });
  });
});
