import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Release tags are authoritative; CI stamps manifests before building without
// requiring a version-bump commit. Untagged development builds keep local versions.

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
  it('covers the root package, Mac app and mobile app', () => {
    expect(VERSION_FILES).toEqual([
      'package.json',
      'apps/desktop/package.json',
      'apps/mobile/package.json',
    ]);
  });

  it('parses releases and prereleases, with the floating major.minor tag', () => {
    expect(parseVersion('1.2.0')).toEqual({
      version: '1.2.0',
      tag: 'v1.2.0',
      minor: '1.2',
      prerelease: false,
    });
    expect(parseVersion('1.3.0-rc.1')).toMatchObject({ minor: '1.3', prerelease: true });
    for (const bad of [
      '1.2',
      'v1.2.0',
      '01.2.0',
      '1.2.0+build',
      '1.2.0-',
      '1.2.0-rc.01',
      '1.2.0\n',
      '',
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it('accepts a tag that matches both package.json versions', () => {
    expect(checkRelease('v1.2.0', both('1.2.0'))).toMatchObject({ version: '1.2.0' });
  });

  it('fails a mismatch, naming the file and how to fix it', () => {
    const versions = { ...both('1.2.0'), 'apps/desktop/package.json': '1.1.0' };
    expect(() => checkRelease('v1.2.0', versions)).toThrow(
      /does not match the release version: apps\/desktop\/package\.json has 1\.1\.0\. Run `node scripts\/release-version\.mjs stamp v1\.2\.0`/,
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

    it('derives metadata from the tag without reading or writing any manifests', () => {
      dir = mkdtempSync(join(tmpdir(), 'release-version-'));
      expect(main(['from-tag', 'v0.0.1'], dir)).toBe(
        'version=0.0.1\ntag=v0.0.1\nminor=0.0\nprerelease=false',
      );
      expect(main(['from-tag', 'v1.2.0-rc.1'], dir)).toContain('prerelease=true');
    });

    it('stamps all build manifests regardless of their committed versions, idempotently', () => {
      fakeRepo('0.0.0');
      const mobilePath = join(dir, 'apps/mobile/package.json');
      writeFileSync(mobilePath, readFileSync(mobilePath, 'utf8').replace('0.0.0', '0.9.0'));
      const expected = main(['from-tag', 'v1.2.0-rc.1'], dir);
      expect(main(['stamp', 'v1.2.0-rc.1'], dir)).toBe(expected);
      for (const file of VERSION_FILES) {
        const text = readFileSync(join(dir, file), 'utf8');
        expect(JSON.parse(text)).toEqual({ name: file, version: '1.2.0-rc.1' });
      }
      expect(main(['check', 'v1.2.0-rc.1'], dir)).toBe(expected);
      expect(main(['stamp', 'v1.2.0-rc.1'], dir)).toBe(expected);
    });

    it('rejects invalid tags before changing files', () => {
      fakeRepo('0.0.0');
      for (const tag of [
        '0.1.0',
        'desktop-v0.1.0',
        'v01.0.0',
        'v0.1.0+build',
        'v0.1.0\n',
        'v0.1.0\nversion=9.9.9',
      ]) {
        for (const command of ['from-tag', 'stamp'])
          expect(() => main([command, tag], dir)).toThrow(/not a release tag/);
      }
      for (const command of ['from-tag', 'stamp'])
        expect(() => main([command], dir)).toThrow(/usage/);
      for (const file of VERSION_FILES)
        expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).version).toBe('0.0.0');
    });

    it('validates every manifest before writing any stamps', () => {
      fakeRepo('0.0.0');
      writeFileSync(join(dir, 'apps/mobile/package.json'), '{}\n');
      expect(() => main(['stamp', 'v0.1.0'], dir)).toThrow(/version/);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.0.0');
      expect(JSON.parse(readFileSync(join(dir, 'apps/desktop/package.json'), 'utf8')).version).toBe(
        '0.0.0',
      );
    });

    it('still supports optional manual bumps and untagged development versions', () => {
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
