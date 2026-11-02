// The agent token travels into the container as a file, never in its
// environment (S-7): before each start the docker provider puts this tar,
// one file `token` owned by root with mode 0400, into the state volume at
// /var/lib/openbots through the Docker API's archive endpoint. The agent reads
// it and deletes it before it listens. The docker guard lets through exactly
// this archive and nothing else, so it parses it back here.

const BLOCK = 512;
const TOKEN_NAME = 'token';
/** base64url, as the server generates it; nothing a tar header could carry. */
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** A ustar archive holding `token` as root's mode-0400 file `token`, with a fixed mtime. */
export function tokenArchive(token: string): Buffer {
  if (!TOKEN.test(token)) throw new Error('The agent token must be 16 to 512 base64url characters');
  const header = Buffer.alloc(BLOCK);
  header.write(TOKEN_NAME, 0, 'ascii');
  header.write(octal(0o400, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(token.length, 12), 124, 'ascii');
  header.write(octal(0, 12), 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0' + '00', 257, 'ascii');
  header.write('root', 265, 'ascii');
  header.write('root', 297, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const data = Buffer.alloc(Math.ceil(token.length / BLOCK) * BLOCK);
  data.write(token, 0, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(2 * BLOCK)]);
}

/** The token in `archive` if it is exactly `tokenArchive(token)`, otherwise undefined. */
export function readTokenArchive(archive: Buffer): string | undefined {
  if (archive.length < 4 * BLOCK) return undefined;
  const size = Number.parseInt(archive.subarray(124, 135).toString('ascii'), 8);
  if (!Number.isSafeInteger(size) || size > BLOCK) return undefined;
  const token = archive.subarray(BLOCK, BLOCK + size).toString('ascii');
  if (!TOKEN.test(token)) return undefined;
  return tokenArchive(token).equals(archive) ? token : undefined;
}
