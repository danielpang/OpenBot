import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { AgentError, notFound } from './errors.js';
import { resolveInHome } from './paths.js';
import type { FsEntry, FsEntryType, FsListing } from './protocol.js';

// Files and listings under the home directory (K7).

const typeOf = (s: Stats): FsEntryType =>
  s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';

const join = (rel: string, name: string) => (rel === '' ? name : `${rel}/${name}`);

function entry(name: string, rel: string, s: Stats): FsEntry {
  return {
    name,
    path: rel,
    type: typeOf(s),
    size: s.isDirectory() ? 0 : s.size,
    modifiedAt: s.mtime.toISOString(),
  };
}

async function statOrNotFound(abs: string, rel: string): Promise<Stats> {
  try {
    return await stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(`No such path: /${rel}`);
    throw err;
  }
}

/** `GET /fs/*`: a JSON listing for a directory, the bytes for a file. */
export async function readPath(home: string, requested: string): Promise<Response> {
  const { abs, rel } = await resolveInHome(home, requested);
  const s = await statOrNotFound(abs, rel);
  if (s.isDirectory()) {
    const names = await readdir(abs);
    const entries: FsEntry[] = [];
    for (const name of names) {
      try {
        entries.push(entry(name, join(rel, name), await lstat(path.join(abs, name))));
      } catch {
        // Removed while listing.
      }
    }
    entries.sort((a, b) =>
      a.type === 'dir' && b.type !== 'dir'
        ? -1
        : b.type === 'dir' && a.type !== 'dir'
          ? 1
          : a.name.localeCompare(b.name),
    );
    const listing: FsListing = { path: rel, entries };
    return Response.json(listing);
  }
  if (!s.isFile()) throw new AgentError(409, 'NOT_A_FILE', `Not a regular file: /${rel}`);
  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(s.size),
      'last-modified': s.mtime.toUTCString(),
    },
  });
}

/**
 * `PUT /fs/*`: writes the body to the file (atomically, creating parent
 * directories) or, with `?dir`, creates the directory.
 */
export async function writePath(
  home: string,
  requested: string,
  body: ReadableStream<Uint8Array> | null,
  opts: { dir?: boolean } = {},
): Promise<FsEntry> {
  const { abs, rel } = await resolveInHome(home, requested);
  if (rel === '')
    throw new AgentError(409, 'IS_HOME', 'The home directory itself cannot be written');
  if (opts.dir) {
    await mkdir(abs, { recursive: true });
  } else {
    const existing = await stat(abs).catch(() => undefined);
    if (existing?.isDirectory()) {
      throw new AgentError(409, 'IS_A_DIRECTORY', `A directory exists at /${rel}`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(
      path.dirname(abs),
      `.${path.basename(abs)}.${process.pid}.${Date.now()}.part`,
    );
    try {
      const source = body ? Readable.fromWeb(body as NodeReadableStream) : Readable.from([]);
      await pipeline(source, createWriteStream(tmp));
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  return entry(path.basename(abs), rel, await stat(abs));
}

/** `DELETE /fs/*`: a file, an empty directory, or with `?recursive` any directory. */
export async function deletePath(
  home: string,
  requested: string,
  opts: { recursive?: boolean } = {},
): Promise<void> {
  const { abs, rel } = await resolveInHome(home, requested);
  if (rel === '')
    throw new AgentError(409, 'IS_HOME', 'The home directory itself cannot be deleted');
  let s: Stats;
  try {
    s = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(`No such path: /${rel}`);
    throw err;
  }
  if (!s.isDirectory()) return unlink(abs);
  if (opts.recursive) return rm(abs, { recursive: true, force: true });
  try {
    await rmdir(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      throw new AgentError(409, 'DIRECTORY_NOT_EMPTY', `/${rel} is not empty; pass ?recursive`);
    }
    throw err;
  }
}
