import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { ReleaseImageLoader } from '../stack/manager.js';
import { nodeExec, type Exec } from '../stack/process.js';

// The local stack's fallback when a registry pull fails (GHCR packages start
// private, or the network blocks ghcr.io): every GitHub Release carries each
// OpenBots image as a gzipped `docker load` archive per architecture,
// openbots-<image>-<version>-linux-<arch>.tar.gz, and a SHA256SUMS file
// (.github/workflows/release.yml). This downloads the archives for the app's
// own version and this Mac's architecture, checks each against SHA256SUMS and
// loads it into Docker. One archive is on disk at a time; the computer image's
// is large.

/** The images the local stack runs, in the order they are loaded (the computer, the largest, last). */
export const RELEASE_IMAGES = ['server', 'sandbox-firewall', 'computer'] as const;
export type ReleaseImage = (typeof RELEASE_IMAGES)[number];

/** Docker's name for an architecture the release builds. */
export type ImageArch = 'amd64' | 'arm64';

/** The repository the release workflow publishes to when the app does not say otherwise. */
export const DEFAULT_RELEASE_REPOSITORY = 'danielpang/OpenBots';

export type ReleaseImageFailure = 'arch' | 'download' | 'checksum' | 'load';

export class ReleaseImageError extends Error {
  constructor(
    message: string,
    readonly reason: ReleaseImageFailure,
  ) {
    super(message);
    this.name = 'ReleaseImageError';
  }
}

/** Docker's architecture for Node's `process.arch`; Apple Silicon is arm64, Intel amd64. */
export function imageArch(nodeArch: string = process.arch): ImageArch {
  if (nodeArch === 'arm64') return 'arm64';
  if (nodeArch === 'x64') return 'amd64';
  throw new ReleaseImageError(`No OpenBots image archives are built for ${nodeArch}.`, 'arch');
}

export function imageArchiveName(image: ReleaseImage, version: string, arch: ImageArch): string {
  return `openbots-${image}-${version}-linux-${arch}.tar.gz`;
}

/** Where a file of the v<version> GitHub Release downloads from. */
export function releaseAssetUrl(repository: string, version: string, file: string): string {
  return `https://github.com/${repository}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

/** File name to lower-case hex digest, from `sha256sum` output (text or `*` binary mode). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/**
 * The `owner/repo` of the packaged app's resources/app-update.yml, which
 * electron-builder writes from its publish settings (a fork's build names the
 * fork), or null.
 */
export function repositoryFromAppUpdateYml(text: string): string | null {
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*['"]?([A-Za-z0-9._-]+)['"]?\\s*$`, 'm').exec(text)?.[1];
  const owner = field('owner');
  const repo = field('repo');
  return owner && repo ? `${owner}/${repo}` : null;
}

/** Image references from `docker load` output ("Loaded image: ghcr.io/x/openbots/server:1.2.0"). */
export function loadedReferences(stdout: string): string[] {
  return [...stdout.matchAll(/^Loaded image: (\S+)\s*$/gm)].map((match) => match[1]!);
}

export interface ReleaseImageProgress {
  image: ReleaseImage;
  phase: 'downloading' | 'loading';
  receivedBytes: number;
  /** From Content-Length; null when the server does not say. */
  totalBytes: number | null;
}

export interface LoadReleaseImagesOptions {
  /** The app's version (`app.getVersion()`): the release whose images the stack runs. */
  version: string;
  /** `owner/repo` of the release; defaults to DEFAULT_RELEASE_REPOSITORY. */
  repository?: string;
  /** Defaults to every image in RELEASE_IMAGES. */
  images?: readonly ReleaseImage[];
  /** Defaults to this Mac's architecture. */
  arch?: ImageArch;
  /**
   * The stack's OPENBOTS_IMAGE_PREFIX. The archives are tagged with the
   * releasing repository's prefix; when this differs, each loaded image is
   * also tagged `<prefix>/<image>:<version>` so compose finds it.
   */
  imagePrefix?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ReleaseImageProgress) => void;
}

export interface LoadReleaseImagesDeps {
  /** The docker CLI the stack manager found. */
  docker: string;
  exec: Exec;
  /** The environment to run docker with (the stack's `dockerEnv`). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Where archives are downloaded to before loading; defaults to the OS temp directory. */
  tmpDir?: string;
}

export interface LoadedReleaseImage {
  image: ReleaseImage;
  /** What `docker load` reported. */
  loaded: string[];
  /** `<imagePrefix>/<image>:<version>` when it was tagged as that too. */
  tagged?: string;
}

/**
 * Downloads, verifies and loads the release's image archives. Throws a
 * ReleaseImageError, with a message for the user, on the first failure;
 * images loaded before it stay loaded.
 */
export async function loadReleaseImages(
  options: LoadReleaseImagesOptions,
  deps: LoadReleaseImagesDeps,
): Promise<LoadedReleaseImage[]> {
  const { version, signal, onProgress } = options;
  const repository = options.repository ?? DEFAULT_RELEASE_REPOSITORY;
  const images = options.images ?? RELEASE_IMAGES;
  const arch = options.arch ?? imageArch();
  const fetchImpl = deps.fetch ?? fetch;
  const url = (file: string) => releaseAssetUrl(repository, version, file);

  const sums = parseSha256Sums(await fetchText(fetchImpl, url('SHA256SUMS'), version, signal));
  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), 'openbots-images-'));
  try {
    const results: LoadedReleaseImage[] = [];
    for (const image of images) {
      const file = imageArchiveName(image, version, arch);
      const expected = sums.get(file);
      if (!expected) {
        throw new ReleaseImageError(
          `The OpenBots ${version} release has no ${image} image for ${arch} (${file} is not in SHA256SUMS).`,
          'checksum',
        );
      }
      const path = join(dir, file);
      const report = (receivedBytes: number, totalBytes: number | null) =>
        onProgress?.({ image, phase: 'downloading', receivedBytes, totalBytes });
      const actual = await download(fetchImpl, url(file), path, report, signal);
      if (actual !== expected) {
        throw new ReleaseImageError(
          `The downloaded ${file} does not match the release's SHA256SUMS; it was not loaded.`,
          'checksum',
        );
      }

      onProgress?.({ image, phase: 'loading', receivedBytes: 0, totalBytes: null });
      const result = await deps.exec(deps.docker, ['load', '--input', path], { env: deps.env });
      await rm(path, { force: true });
      if (result.code !== 0) {
        throw new ReleaseImageError(
          `docker load failed for ${file}: ${result.stderr.trim() || `exit code ${result.code}`}`,
          'load',
        );
      }
      const loaded = loadedReferences(result.stdout);
      const entry: LoadedReleaseImage = { image, loaded };
      if (options.imagePrefix) {
        const wanted = `${options.imagePrefix}/${image}:${version}`;
        const source = loaded.find((ref) => ref.endsWith(`/${image}:${version}`)) ?? loaded[0];
        if (source && source !== wanted) {
          const tagged = await deps.exec(deps.docker, ['tag', source, wanted], { env: deps.env });
          if (tagged.code !== 0) {
            throw new ReleaseImageError(
              `docker tag ${source} ${wanted} failed: ${tagged.stderr.trim()}`,
              'load',
            );
          }
          entry.tagged = wanted;
        }
      }
      results.push(entry);
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  version: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    throw new ReleaseImageError(
      `Could not reach GitHub to download the OpenBots ${version} images: ${errorMessage(error)}`,
      'download',
    );
  }
  if (!response.ok) {
    throw new ReleaseImageError(
      response.status === 404
        ? `There is no OpenBots ${version} release with image archives (${url}).`
        : `Downloading ${url} failed: HTTP ${response.status}.`,
      'download',
    );
  }
  return response.text();
}

/** Streams `url` to `path`, returning its SHA-256 as lower-case hex. */
async function download(
  fetchImpl: typeof fetch,
  url: string,
  path: string,
  onProgress: (receivedBytes: number, totalBytes: number | null) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok || response.body == null) {
      throw new Error(`HTTP ${response.status}`);
    }
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        onProgress(received, total);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      meter,
      createWriteStream(path),
      { signal },
    );
    return hash.digest('hex');
  } catch (error) {
    await rm(path, { force: true });
    throw new ReleaseImageError(`Downloading ${url} failed: ${errorMessage(error)}`, 'download');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The stack manager's fallback (StackManagerOptions.releaseImages) for a
 * packaged app: loads from the GitHub Release of `repository`.
 */
export function releaseImageLoader(options: {
  repository: string;
  exec?: Exec;
  fetch?: typeof fetch;
  tmpDir?: string;
}): ReleaseImageLoader {
  return async ({ version, imagePrefix, images, docker, env, onProgress }) => {
    await loadReleaseImages(
      { version, repository: options.repository, images, imagePrefix, onProgress },
      {
        docker,
        env,
        exec: options.exec ?? nodeExec,
        fetch: options.fetch,
        tmpDir: options.tmpDir,
      },
    );
  };
}
