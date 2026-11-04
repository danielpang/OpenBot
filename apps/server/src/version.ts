import { readFileSync } from 'node:fs';

// The server's release version, as `GET /capabilities` reports it so a phone
// can say "update your server". One tag releases everything
// (scripts/release-version.mjs): `bump` writes the version into the root
// package.json and the release check fails unless the tag equals it, so that
// file is the stamp. The server image keeps the repository's root
// package.json at /app/package.json, three levels above this module in
// src/ and in dist/ alike.

/** The relay and tunnel protocol version this server speaks (docs/RELAY_PROTOCOL.md). */
export const RELAY_PROTOCOL_VERSION = 1;

/** What is reported when no package.json can be read. */
export const UNKNOWN_VERSION = '0.0.0';

const ROOT_PACKAGE = new URL('../../../package.json', import.meta.url);

/** The `version` of a package.json, or null when it cannot be read or has none. */
export function readPackageVersion(url: URL | string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

let cached: string | undefined;

/** The release version from the root package.json; read once. */
export function serverVersion(): string {
  cached ??= readPackageVersion(ROOT_PACKAGE) ?? UNKNOWN_VERSION;
  return cached;
}
