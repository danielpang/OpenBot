# Releasing OpenBots

One version tag, `v<version>`, releases everything together (plan sections 3, 14.4, 16.1, 18.8
and 19):

- the server, computer and sandbox firewall images for linux/amd64 and linux/arm64, pushed to
  `ghcr.io/<owner>/openbots/{server,computer,sandbox-firewall}` as `<version>`, `<major>.<minor>`
  and `latest` (a prerelease such as `1.3.0-rc.1` gets only its own tag);
- the Mac app: a universal (Apple Silicon and Intel) DMG, the zip and `latest-mac.yml` that
  electron-updater reads, and a rendered Homebrew cask;
- a GitHub Release for the tag with notes generated from the commits since the previous release
  tag, carrying the DMG, the zip, the cask, the compose bundle `openbots-compose-<version>.tar.gz`,
  a gzipped `docker load` archive of each image per architecture
  (`openbots-<image>-<version>-linux-<arch>.tar.gz`) and `SHA256SUMS` covering every file.

| File                                      | What it does                                                        |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `.github/workflows/release.yml`           | The release: version check, then the jobs below, then the Release   |
| `.github/workflows/release-images.yml`    | Builds and pushes the images and writes their archives              |
| `.github/workflows/release-mac.yml`       | Packages the Mac app, signed and notarized when the secrets are set |
| `scripts/release-version.mjs`             | Bumps the release version, and checks a tag against it              |
| `scripts/release-bundle.sh`               | Packs the compose bundle                                            |
| `scripts/release-notes.sh`                | Writes the release notes                                            |
| `scripts/release-check-public.sh`         | Checks that anyone can pull the images                              |
| `electron-builder.yml`                    | Targets, hardened runtime, entitlements, bundled stack              |
| `electron-builder.publish.cjs`            | The repository the app updates from (`GITHUB_REPOSITORY` in CI)     |
| `build/entitlements.mac.plist`            | Hardened runtime entitlements (JIT only)                            |
| `src/release/notarize.ts`                 | `afterSign` hook: notarizes with `@electron/notarize`               |
| `src/images/release-archive.ts`           | Loads a release's image archives when the Mac app cannot pull       |
| `packaging/homebrew/openbots.rb.template` | Homebrew cask, rendered per release                                 |

## Cutting a release

1. Bump the version. The root `package.json` (the server release and its image tag) and
   `apps/desktop/package.json` (the Mac app) must both equal the tag, because the app's local
   stack runs the images of its own version:

   ```sh
   pnpm release:bump 1.2.0     # node scripts/release-version.mjs bump 1.2.0
   git commit -am "Release 1.2.0"
   ```

   Get the commit onto `main` the usual way.

2. Tag that commit and push the tag:

   ```sh
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. Watch the Release workflow in the Actions tab. `Version` fails at once, saying what to do, when
   the tag and the package.json versions differ (`pnpm release:check v1.2.0` runs the same check
   locally). Then the images (the longest job: the computer image builds for arm64 under QEMU),
   the Mac app and the compose bundle build in parallel, and `GitHub Release` publishes the
   release once all three have succeeded. It is created as a draft while the files upload and
   published when they are all there, so electron-updater never sees a release without its files.
4. The first time only, make the images public (below). The `GitHub Release` job's summary says
   whether each package is public and warns when one is not.
5. Check the release page: the notes, the DMG, the bundle, six image archives, `SHA256SUMS` and,
   for a signed build, `latest-mac.yml`. Install the DMG on a clean Mac.
6. For Homebrew, copy `openbots.rb` from the release into the tap's `Casks/` directory and open a
   pull request there.

A failed job can be rerun from the Actions tab. Rerunning `GitHub Release` updates the release
that exists instead of failing. To redo a release from a new commit, delete the release and the
tag (`git push --delete origin v1.2.0`), fix, and tag again.

The release goes to the repository the workflow runs in, and the images to
`ghcr.io/<that repository's owner in lower case>/openbots`, so a fork releases to itself. The
packaged app's updater and the cask point at the same repository.

### Making the images public (once)

GHCR makes every new package private, and GitHub's REST API has no endpoint to change a package's
visibility, so after the first release the owner does it by hand for each of `openbots/server`,
`openbots/computer` and `openbots/sandbox-firewall`:

1. Open `https://github.com/<owner>?tab=packages` (for an organization, its Packages tab) and
   choose the package.
2. Package settings, Danger Zone, Change visibility, Public, and confirm with the package name.

Until then installs cannot pull the images: compose builds the server and the sandbox firewall
from a checkout (and fails from the compose bundle), computers cannot start, and the Mac app's
local stack cannot pull. The release notes say so and point at the image archives meanwhile.
Check afterwards with:

```sh
bash scripts/release-check-public.sh ghcr.io/<owner>/openbots 1.2.0
```

The packages stay public for later releases.

## The dry run

A pull request that changes the release files (`.github/workflows/release*.yml`, `docker/**`,
`apps/desktop/electron-builder*`, `apps/desktop/packaging/**` or `scripts/release-*`) runs the
same workflow as a dry run, and so does a manual run (Actions, Release, Run workflow). It uses the
version in the package.json files, builds every artifact without pushing, logging in to a registry
or reading a secret, and uploads them as workflow artifacts for three days: `release-image-*`
(the image archives), `release-mac` (the unsigned DMG, zip, `latest-mac.yml` and cask) and
`release-bundle`. Each job's summary lists the files and their sizes, which shows how close the
computer image's archive is to GitHub's 2 GiB limit for a release asset.

To keep it cheap, the dry run builds the server and the sandbox firewall for both architectures
but the computer image for linux/amd64 only: its arm64 build compiles node-pty and installs
Chromium under QEMU. That build first runs for a real tag.

## Signing the Mac app

Signing is optional. With all five secrets below set, the tag build signs with the Developer ID
certificate, notarizes and staples in the `afterSign` hook, and verifies with `codesign`, `spctl`
and `stapler`; it fails rather than ship a signed app that is not notarized
(`OPENBOTS_REQUIRE_NOTARIZATION=1`).

With none of them set, the release still goes out with an unsigned (ad-hoc signed) app, and the
notes say "Unsigned build: right-click Open on first launch". Squirrel.Mac only installs updates
signed by the same Developer ID, so electron-updater cannot update an unsigned build, and the
release leaves out `latest-mac.yml`: copies installed from an earlier signed release then do not
download an update they cannot install. Some but not all of the secrets set fails the Mac job, as
a broken setup rather than a choice. The dry run never signs and never sees the secrets.

| Secret                    | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `MAC_CERTS_P12_BASE64`    | Developer ID Application certificate and private key, `.p12`, base64 |
| `MAC_CERTS_PASSWORD`      | The password the `.p12` was exported with                            |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect API key (`AuthKey_XXXX.p8`), base64                |
| `APPLE_API_KEY_ID`        | That key's ID                                                        |
| `APPLE_API_ISSUER`        | The issuer ID shown above the keys list                              |

To make them: in Keychain Access, export the "Developer ID Application: ..." certificate with its
key as a `.p12`, then `base64 -i cert.p12 | pbcopy`. In App Store Connect, Users and Access,
Integrations, create a key with the Developer role and download the `.p8` (only once), then
`base64 -i AuthKey_XXXX.p8 | pbcopy`. Add each under Settings, Secrets and variables, Actions.
App Store Connect API keys do not expire, but they can be revoked, and a Developer ID certificate
is valid for five years: when either changes, update the secrets.

`GITHUB_TOKEN` is the token Actions issues for each run. Each job asks for only what it uses:
`packages: write` to push the images and `contents: write` to create the release.

### The OpenBots account server

"Sign in to an OpenBots account" on the welcome screen opens the hosted OpenBots server. Its URL
is set at build time: `OPENBOTS_CLOUD_URL` (an https origin, such as `https://app.openbots.example`)
goes through `electron-builder.publish.cjs` into the packaged `package.json` as
`openbots.cloudUrl`, which the app reads (`src/main/app-config.ts`). The release workflow takes it
from the repository variable `OPENBOTS_CLOUD_URL` (Settings, Secrets and variables, Actions,
Variables). Unset, the choice shows disabled with "OpenBots accounts are not available yet"; a
value that is not https fails the build. A packaged app ignores the variable on the Mac it runs
on. In development (`pnpm --filter @openbots/desktop dev`) the app reads `OPENBOTS_CLOUD_URL` from
the environment.

## The image archives

Each archive is one image for one architecture, in the format `docker save` writes, gzipped:
`docker load -i openbots-computer-1.2.0-linux-arm64.tar.gz` gives
`ghcr.io/<owner>/openbots/computer:1.2.0`. They are made by the same build as the pushed images,
from its cache, and the workflow fails if one reaches GitHub's 2 GiB limit for a release asset.

When the registry refuses the Mac app's images (a private package, or one not published yet), a
packaged app falls back to its release: the stack manager (`src/stack/manager.ts`) asks
`src/images/release-archive.ts` to download the archives of the images missing on this Mac, for the
app's version and the Mac's architecture, from the repository in the app's `app-update.yml`. Each
is checked against `SHA256SUMS`, loaded and tagged with the stack's `OPENBOTS_IMAGE_PREFIX`, and the
start goes on as after a pull; "Download OpenBots" shows the image and its percentage meanwhile.
When that fails too, the start shows the registry's error, with the download's reason under "Show
details". A development build, or one with `OPENBOTS_IMAGE_PREFIX` or `OPENBOTS_VERSION` overrides,
never falls back, and neither does a stack whose `.env` pins another version.

## Manual signed build

On a Mac with the Developer ID Application certificate in the login keychain:

```sh
pnpm install
pnpm exec turbo run build --filter=@openbots/desktop
cd apps/desktop
# One of the two credential sets the afterSign hook reads:
export APPLE_API_KEY=~/keys/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<uuid>
#   or: export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=ABCDE12345
export OPENBOTS_REQUIRE_NOTARIZATION=1
pnpm dist:mac
codesign --verify --deep --strict --verbose=2 release/mac-universal/OpenBots.app
spctl --assess --type execute --verbose=2 release/mac-universal/OpenBots.app
xcrun stapler validate release/mac-universal/OpenBots.app
```

electron-builder finds the certificate in the keychain; set `CSC_NAME` to pick one when there are
several. With `GH_TOKEN` set, `--publish always` uploads to a draft release for the tag
`v<version>`; the CI release does not use this.

If notarization fails, `xcrun notarytool log <submission-id> --key ... --key-id ... --issuer ...`
shows Apple's reasons. The usual one is a binary without the hardened runtime or a secure timestamp.

## Unsigned local build

Without a certificate, build ad-hoc signed with the hardened runtime off (ad-hoc signing cannot
satisfy library validation), as the workflow does without the secrets:

```sh
cd apps/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --universal --publish never \
  -c.mac.identity=- -c.mac.hardenedRuntime=false
xattr -dr com.apple.quarantine release/mac-universal/OpenBots.app
```

For a quicker local check, `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist:dev` builds the same unsigned
app for this Mac's architecture only, as a folder in `release/` with no DMG or zip.

On a Mac with a Developer ID certificate in the keychain, `identity=-` is not always ad-hoc:
electron-builder first looks for a Developer ID identity whose name contains the qualifier, so a
name with a hyphen in it (such as "Developer ID Application: Ada Lovelace-Byron") matches `-` and
the build is signed with it, asking for keychain access. There, pass `-c.mac.identity=null` to
skip signing instead. CI runners have no such identity, so the workflow's unsigned build is ad-hoc
signed.

The notarize hook skips itself when no Apple credentials are set. Gatekeeper blocks these builds
on other Macs until they are opened with right-click Open, and electron-updater cannot update them.

## Status

Nothing here has run end to end yet: the workflows need GitHub Actions, and signing,
notarization and the updater need the Apple secrets. `actionlint` checks the workflows, and the
tests in `src/release` check the configuration statically, including electron-builder's own schema
for `electron-builder.yml`, the jobs' permissions and pinned actions, and the version check.
