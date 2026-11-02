import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from './errors.js';

// `/fs/*` paths are relative to the home directory and may not leave it,
// neither by `..` nor through a symlink that points outside.

export interface HomePath {
  /** Absolute path on disk. */
  abs: string;
  /** Relative to home, `/`-separated; '' is home itself. */
  rel: string;
}

const escapes = (rel: string) =>
  rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);

const outside = () =>
  new AgentError(403, 'PATH_OUTSIDE_HOME', 'The path leaves the home directory');

export async function resolveInHome(home: string, requested: string): Promise<HomePath> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    throw new AgentError(400, 'BAD_PATH', 'The path is not valid URL encoding');
  }
  if (decoded.includes('\0')) throw new AgentError(400, 'BAD_PATH', 'The path contains NUL');
  const abs = path.resolve(home, '.' + path.posix.sep + decoded.replace(/^\/+/, ''));
  const rel = path.relative(home, abs);
  if (escapes(rel)) throw outside();

  // Symlinks: the nearest existing ancestor must really be inside home.
  const realHome = await realpath(home);
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const realRel = path.relative(realHome, real);
      if (escapes(realRel)) throw outside();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      probe = path.dirname(probe);
    }
  }
  return { abs, rel: rel.split(path.sep).join('/') };
}
