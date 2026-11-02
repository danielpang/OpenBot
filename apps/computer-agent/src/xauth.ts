import { randomBytes } from 'node:crypto';

// Each screen's X server takes only clients that hold its cookie (S-7). The
// cookie is in an Xauthority file that the screen's user owns and the
// screen's Bot's commands may read (group), and nobody else.

const FAMILY_WILD = 0xffff;
const MIT_MAGIC_COOKIE = 'MIT-MAGIC-COOKIE-1';

/** A random MIT-MAGIC-COOKIE-1. */
export const xCookie = () => randomBytes(16);

function field(value: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(value.length);
  return Buffer.concat([length, value]);
}

/**
 * An Xauthority file (libXau's format) with one entry: `cookie` for display
 * `display` on any host. Xvfb reads it with `-auth`; clients find it by
 * XAUTHORITY.
 */
export function xauthority(display: number, cookie: Buffer): Buffer {
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.from(String(display))),
    field(Buffer.from(MIT_MAGIC_COOKIE)),
    field(cookie),
  ]);
}
