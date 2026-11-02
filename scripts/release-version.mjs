#!/usr/bin/env node
// The release version (apps/desktop/RELEASING.md). One tag, vX.Y.Z, releases
// the images, the Mac app and the compose bundle together, so the version in
// the root package.json (the server release and its image tag) and in
// apps/desktop/package.json (the Mac app, whose local stack runs the images
// of its own version) must both equal the tag.
//
//   node scripts/release-version.mjs bump 1.2.0    # sets both package.json versions
//   node scripts/release-version.mjs check v1.2.0  # fails unless both match the tag
//   node scripts/release-version.mjs current       # the version in the package.json files
//
// `check` and `current` print key=value lines for $GITHUB_OUTPUT: version,
// tag, minor (X.Y, the floating image tag) and prerelease (true or false).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The package.json files that carry the release version, relative to the repository. */
export const VERSION_FILES = ['package.json', 'apps/desktop/package.json'];

// Semantic Versioning 2.0.0, without build metadata (Docker tags cannot hold a +).
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `{ version, tag, minor, prerelease }` for a version such as 1.2.0 or 1.3.0-rc.1, or null. */
export function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match) return null;
  return {
    version: value,
    tag: `v${value}`,
    minor: `${match[1]}.${match[2]}`,
    prerelease: match[4] !== undefined,
  };
}

/**
 * Checks a release tag against the versions in the package.json files
 * (`{ [file]: version }`). Returns the parsed version or throws with what to do.
 */
export function checkRelease(tag, versions) {
  const parsed = tag.startsWith('v') ? parseVersion(tag.slice(1)) : null;
  if (!parsed) {
    throw new Error(`${tag} is not a release tag: use v<major>.<minor>.<patch>, such as v1.2.0`);
  }
  const wrong = Object.entries(versions).filter(([, version]) => version !== parsed.version);
  if (wrong.length > 0) {
    const list = wrong.map(([file, version]) => `${file} has ${version}`).join(', ');
    throw new Error(
      `Tag ${tag} does not match the release version: ${list}. ` +
        `Run \`node scripts/release-version.mjs bump ${parsed.version}\`, commit, delete the tag ` +
        `(git push --delete origin ${tag}) and tag the new commit.`,
    );
  }
  return parsed;
}

/** The package.json text with its top-level version set, everything else untouched. */
export function setVersion(text, version) {
  const line = /^( {2}"version": ")[^"]*(",?)$/m;
  if (!line.test(text)) throw new Error('no top-level "version" field');
  return text.replace(line, `$1${version}$2`);
}

function readVersions(repoDir) {
  return Object.fromEntries(
    VERSION_FILES.map((file) => [
      file,
      JSON.parse(readFileSync(join(repoDir, file), 'utf8')).version,
    ]),
  );
}

function outputs(parsed) {
  return [
    `version=${parsed.version}`,
    `tag=${parsed.tag}`,
    `minor=${parsed.minor}`,
    `prerelease=${parsed.prerelease}`,
  ].join('\n');
}

export function main(argv, repoDir = REPO_DIR) {
  const [command, value] = argv;
  if (command === 'bump') {
    if (!value || !parseVersion(value)) {
      throw new Error('usage: release-version.mjs bump <version>, such as 1.2.0 (no leading v)');
    }
    for (const file of VERSION_FILES) {
      const path = join(repoDir, file);
      writeFileSync(path, setVersion(readFileSync(path, 'utf8'), value));
    }
    return `Set ${VERSION_FILES.join(' and ')} to ${value}. Commit, then tag v${value}.`;
  }
  if (command === 'check') {
    if (!value) throw new Error('usage: release-version.mjs check <tag>, such as v1.2.0');
    return outputs(checkRelease(value, readVersions(repoDir)));
  }
  if (command === 'current') {
    const versions = readVersions(repoDir);
    const [first] = Object.values(versions);
    return outputs(checkRelease(`v${first}`, versions));
  }
  throw new Error('usage: release-version.mjs bump <version> | check <tag> | current');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message}` : message);
    process.exit(1);
  }
}
