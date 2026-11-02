// The parts of the electron-builder configuration that come from the
// environment, since YAML cannot read it with a fallback; electron-builder.yml
// extends this file.
//
// The GitHub Release electron-builder publishes to, which is also where the
// packaged app's electron-updater looks (app-update.yml is written from it):
// in CI the repository is GITHUB_REPOSITORY, so a fork's release workflow
// publishes to the fork; elsewhere it is the default.
//
// The hosted OpenBots server, OPENBOTS_CLOUD_URL, goes into the packaged
// package.json as `openbots.cloudUrl` (src/main/app-config.ts reads it). Unset,
// the app shows "Sign in to an OpenBots account" disabled. The packaged
// package.json also gets electron-updater's installed version in place of
// pnpm's `catalog:`, which electron-builder cannot read.

const DEFAULT_REPOSITORY = 'danielpang/OpenBots';

/** `{ owner, repo, slug }` from GITHUB_REPOSITORY (`owner/repo`), or the default. */
function releaseRepository(env = process.env) {
  const value = (env.GITHUB_REPOSITORY || '').trim();
  const slug = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value) ? value : DEFAULT_REPOSITORY;
  const [owner, repo] = slug.split('/');
  return { owner, repo, slug };
}

function publishConfig(env = process.env) {
  const { owner, repo } = releaseRepository(env);
  return {
    publish: [
      {
        provider: 'github',
        owner,
        repo,
        // One v<version> tag releases the app with the images it runs.
        tagNamePrefix: 'v',
        // CI never publishes from electron-builder (release.yml attaches the
        // files to the release itself); a manual --publish always makes a
        // draft, which electron-updater ignores until someone publishes it.
        releaseType: 'draft',
      },
    ],
  };
}

/** The cloud URL's origin; throws on anything but https, so a bad value fails the build. */
function cloudUrl(env = process.env) {
  const value = (env.OPENBOTS_CLOUD_URL || '').trim();
  if (value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OPENBOTS_CLOUD_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`OPENBOTS_CLOUD_URL must be an https URL without credentials: ${value}`);
  }
  return url.origin;
}

/**
 * electron-builder refuses to package unless package.json names an
 * electron-updater version it can parse, and pnpm's `catalog:` is not one, so
 * the packaged package.json gets the installed version instead.
 */
function updaterDependency() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS file electron-builder loads
  return { 'electron-updater': require('electron-updater/package.json').version };
}

function appConfig(env = process.env) {
  const url = cloudUrl(env);
  return {
    extraMetadata: {
      dependencies: updaterDependency(),
      ...(url ? { openbots: { cloudUrl: url } } : {}),
    },
  };
}

function builderConfig(env = process.env) {
  return { ...publishConfig(env), ...appConfig(env) };
}

// electron-builder calls an exported function for the configuration; the
// helpers ride on it so the release workflow and the tests can use them.
module.exports = () => builderConfig();
module.exports.DEFAULT_REPOSITORY = DEFAULT_REPOSITORY;
module.exports.releaseRepository = releaseRepository;
module.exports.publishConfig = publishConfig;
module.exports.cloudUrl = cloudUrl;
module.exports.updaterDependency = updaterDependency;
module.exports.appConfig = appConfig;
module.exports.builderConfig = builderConfig;
