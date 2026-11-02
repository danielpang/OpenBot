import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../stack/process.js';
import {
  DEFAULT_RELEASE_REPOSITORY,
  RELEASE_IMAGES,
  ReleaseImageError,
  imageArch,
  imageArchiveName,
  loadReleaseImages,
  loadedReferences,
  parseSha256Sums,
  releaseAssetUrl,
  releaseImageLoader,
  repositoryFromAppUpdateYml,
  type ReleaseImageProgress,
} from './release-archive.js';

const VERSION = '1.2.0';
const RELEASE = `https://github.com/${DEFAULT_RELEASE_REPOSITORY}/releases/download/v${VERSION}`;
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** A release on a fake GitHub: file name to contents. */
function fakeRelease(files: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const file = url.startsWith(`${RELEASE}/`) ? url.slice(RELEASE.length + 1) : null;
    const body = file == null ? undefined : files[decodeURIComponent(file)];
    if (body === undefined) return new Response('Not Found', { status: 404 });
    return new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

function archivesFor(arch: 'amd64' | 'arm64') {
  const files: Record<string, string> = {};
  for (const image of RELEASE_IMAGES) {
    files[imageArchiveName(image, VERSION, arch)] = `${image} image for ${arch}`;
  }
  return files;
}

function sumsOf(files: Record<string, string>) {
  return Object.entries(files)
    .map(([name, body]) => `${sha256(body)}  ${name}\n`)
    .join('');
}

/** A docker CLI that records each call and, for `load`, the archive's contents at that moment. */
function fakeDocker(result: (args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { args: string[]; contents?: string; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (file, args, options) => {
    expect(file).toBe('/usr/local/bin/docker');
    const contents = args[0] === 'load' ? readFileSync(args[2]!, 'utf8') : undefined;
    calls.push({ args, contents, env: options?.env });
    const image = args[0] === 'load' ? /openbots-([a-z-]+)-\d/.exec(basename(args[2]!))?.[1] : '';
    return {
      code: 0,
      stdout:
        args[0] === 'load' ? `Loaded image: ghcr.io/danielpang/openbots/${image}:${VERSION}\n` : '',
      stderr: '',
      ...result(args),
    };
  };
  return { exec, calls };
}

describe('loadReleaseImages', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'release-archive-test-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("downloads, verifies and loads each image for this Mac's architecture, then cleans up", async () => {
    const archives = { ...archivesFor('arm64'), ...archivesFor('amd64') };
    const { fetchImpl, requested } = fakeRelease({ ...archives, SHA256SUMS: sumsOf(archives) });
    const docker = fakeDocker();
    const env = { PATH: '/usr/local/bin' };
    const progress: ReleaseImageProgress[] = [];

    const loaded = await loadReleaseImages(
      { version: VERSION, arch: 'arm64', onProgress: (p) => progress.push(p) },
      { docker: '/usr/local/bin/docker', exec: docker.exec, env, fetch: fetchImpl, tmpDir: tmp },
    );

    expect(requested).toEqual([
      `${RELEASE}/SHA256SUMS`,
      `${RELEASE}/openbots-server-1.2.0-linux-arm64.tar.gz`,
      `${RELEASE}/openbots-sandbox-firewall-1.2.0-linux-arm64.tar.gz`,
      `${RELEASE}/openbots-computer-1.2.0-linux-arm64.tar.gz`,
    ]);
    expect(
      docker.calls.map((c) => [c.args[0], c.args[1], basename(c.args[2]!), c.contents]),
    ).toEqual(
      RELEASE_IMAGES.map((image) => [
        'load',
        '--input',
        `openbots-${image}-1.2.0-linux-arm64.tar.gz`,
        `${image} image for arm64`,
      ]),
    );
    expect(docker.calls.every((c) => c.env === env)).toBe(true);
    expect(loaded).toEqual(
      RELEASE_IMAGES.map((image) => ({
        image,
        loaded: [`ghcr.io/danielpang/openbots/${image}:1.2.0`],
      })),
    );
    const server = progress.filter((p) => p.image === 'server');
    expect(server.at(-2)).toEqual({
      image: 'server',
      phase: 'downloading',
      receivedBytes: 22,
      totalBytes: 22,
    });
    expect(server.at(-1)).toMatchObject({ phase: 'loading' });
    // Nothing left behind.
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('loads nothing whose checksum does not match, and says so', async () => {
    const archives = archivesFor('arm64');
    const sums = sumsOf({ ...archives, [imageArchiveName('server', VERSION, 'arm64')]: 'other' });
    const { fetchImpl } = fakeRelease({ ...archives, SHA256SUMS: sums });
    const docker = fakeDocker();

    const result = loadReleaseImages(
      { version: VERSION, arch: 'arm64' },
      { docker: '/usr/local/bin/docker', exec: docker.exec, fetch: fetchImpl, tmpDir: tmp },
    );
    await expect(result).rejects.toThrow(ReleaseImageError);
    await expect(result).rejects.toMatchObject({
      reason: 'checksum',
      message: expect.stringMatching(/does not match the release's SHA256SUMS/),
    });
    expect(docker.calls).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('fails clearly when the release or its archive is missing', async () => {
    const docker = fakeDocker();
    const deps = { docker: '/usr/local/bin/docker', exec: docker.exec, tmpDir: tmp };

    await expect(
      loadReleaseImages(
        { version: VERSION, arch: 'arm64' },
        { ...deps, fetch: fakeRelease({}).fetchImpl },
      ),
    ).rejects.toMatchObject({
      reason: 'download',
      message: expect.stringMatching(/no OpenBots 1\.2\.0 release with image archives/),
    });

    const amd64Only = archivesFor('amd64');
    await expect(
      loadReleaseImages(
        { version: VERSION, arch: 'arm64' },
        { ...deps, fetch: fakeRelease({ ...amd64Only, SHA256SUMS: sumsOf(amd64Only) }).fetchImpl },
      ),
    ).rejects.toMatchObject({
      reason: 'checksum',
      message: expect.stringMatching(/no server image for arm64/),
    });

    // Listed in SHA256SUMS but not uploaded.
    const sums = sumsOf(archivesFor('arm64'));
    await expect(
      loadReleaseImages(
        { version: VERSION, arch: 'arm64' },
        { ...deps, fetch: fakeRelease({ SHA256SUMS: sums }).fetchImpl },
      ),
    ).rejects.toMatchObject({ reason: 'download', message: expect.stringMatching(/HTTP 404/) });

    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      loadReleaseImages({ version: VERSION, arch: 'arm64' }, { ...deps, fetch: offline }),
    ).rejects.toMatchObject({ reason: 'download', message: expect.stringMatching(/fetch failed/) });

    expect(docker.calls).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("reports docker load's error", async () => {
    const archives = archivesFor('amd64');
    const { fetchImpl } = fakeRelease({ ...archives, SHA256SUMS: sumsOf(archives) });
    const docker = fakeDocker(() => ({ code: 1, stdout: '', stderr: 'no space left on device\n' }));

    await expect(
      loadReleaseImages(
        { version: VERSION, arch: 'amd64', images: ['computer'] },
        { docker: '/usr/local/bin/docker', exec: docker.exec, fetch: fetchImpl, tmpDir: tmp },
      ),
    ).rejects.toMatchObject({
      reason: 'load',
      message:
        'docker load failed for openbots-computer-1.2.0-linux-amd64.tar.gz: no space left on device',
    });
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("tags the loaded image with the stack's prefix when it differs", async () => {
    const archives = archivesFor('arm64');
    const { fetchImpl } = fakeRelease({ ...archives, SHA256SUMS: sumsOf(archives) });
    const deps = { docker: '/usr/local/bin/docker', fetch: fetchImpl, tmpDir: tmp };

    const fork = fakeDocker();
    const loaded = await loadReleaseImages(
      { version: VERSION, arch: 'arm64', images: ['server'], imagePrefix: 'ghcr.io/ada/openbots' },
      { ...deps, exec: fork.exec },
    );
    expect(fork.calls.map((c) => c.args)).toContainEqual([
      'tag',
      'ghcr.io/danielpang/openbots/server:1.2.0',
      'ghcr.io/ada/openbots/server:1.2.0',
    ]);
    expect(loaded[0]!.tagged).toBe('ghcr.io/ada/openbots/server:1.2.0');

    const same = fakeDocker();
    await loadReleaseImages(
      {
        version: VERSION,
        arch: 'arm64',
        images: ['server'],
        imagePrefix: 'ghcr.io/danielpang/openbots',
      },
      { ...deps, exec: same.exec },
    );
    expect(same.calls.map((c) => c.args[0])).toEqual(['load']);
  });
});

describe('releaseImageLoader', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'release-loader-test-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("loads what the stack manager asks for, from the app's repository", async () => {
    const files = {
      [imageArchiveName('computer', VERSION, process.arch === 'x64' ? 'amd64' : 'arm64')]: 'c',
    };
    const fork = `https://github.com/ada/OpenBots-fork/releases/download/v${VERSION}`;
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const name = url.slice(fork.length + 1);
      const body = name === 'SHA256SUMS' ? sumsOf(files) : files[name];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;
    const docker = fakeDocker();
    const progress: string[] = [];
    const env = { PATH: '/x' };

    await releaseImageLoader({
      repository: 'ada/OpenBots-fork',
      exec: docker.exec,
      fetch: fetchImpl,
      tmpDir: tmp,
    })({
      version: VERSION,
      imagePrefix: 'ghcr.io/ada/openbots',
      images: ['computer'],
      docker: '/usr/local/bin/docker',
      env,
      onProgress: (p) => progress.push(`${p.image} ${p.phase}`),
    });

    expect(requested.every((url) => url.startsWith(fork))).toBe(true);
    expect(docker.calls.map((c) => c.args[0])).toEqual(['load', 'tag']);
    expect(docker.calls[0]!.env).toBe(env);
    expect(progress).toContain('computer loading');
  });
});

describe('release archive helpers', () => {
  it("maps Node's architecture to Docker's", () => {
    expect(imageArch('arm64')).toBe('arm64');
    expect(imageArch('x64')).toBe('amd64');
    expect(() => imageArch('ia32')).toThrow(ReleaseImageError);
  });

  it('names archives and their URLs the way the release workflow uploads them', () => {
    expect(imageArchiveName('sandbox-firewall', '1.3.0-rc.1', 'amd64')).toBe(
      'openbots-sandbox-firewall-1.3.0-rc.1-linux-amd64.tar.gz',
    );
    expect(releaseAssetUrl('ada/OpenBots-fork', '1.2.0', 'SHA256SUMS')).toBe(
      'https://github.com/ada/OpenBots-fork/releases/download/v1.2.0/SHA256SUMS',
    );
    const workflow = readFileSync(
      join(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
        '.github/workflows/release-images.yml',
      ),
      'utf8',
    );
    expect(workflow).toContain(
      'ARCHIVE_BASE: openbots-${{ matrix.image }}-${{ inputs.version }}-linux',
    );
    expect(workflow).toContain('${{ env.ARCHIVE_BASE }}-arm64.tar');
  });

  it('reads sha256sum output in text and binary mode', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    expect(parseSha256Sums(`${a}  one.tar.gz\n${b} *two file.dmg\r\nnot a line\n`)).toEqual(
      new Map([
        ['one.tar.gz', a],
        ['two file.dmg', b.toLowerCase()],
      ]),
    );
  });

  it("reads the release repository from the app's app-update.yml", () => {
    expect(
      repositoryFromAppUpdateYml(
        'owner: ada\nrepo: OpenBots-fork\nprovider: github\nupdaterCacheDirName: x\n',
      ),
    ).toBe('ada/OpenBots-fork');
    expect(repositoryFromAppUpdateYml('provider: generic\nurl: https://x\n')).toBeNull();
  });

  it('reads the image references docker load prints', () => {
    expect(
      loadedReferences(
        'Loaded image: ghcr.io/a/openbots/server:1.2.0\nLoaded image ID: sha256:abc\n',
      ),
    ).toEqual(['ghcr.io/a/openbots/server:1.2.0']);
  });

  it('defaults to the repository electron-builder publishes to', () => {
    const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const publish = createRequire(import.meta.url)(
      join(desktopDir, 'electron-builder.publish.cjs'),
    ) as {
      DEFAULT_REPOSITORY: string;
    };
    expect(DEFAULT_RELEASE_REPOSITORY).toBe(publish.DEFAULT_REPOSITORY);
    expect(existsSync(join(desktopDir, 'electron-builder.publish.cjs'))).toBe(true);
  });
});
