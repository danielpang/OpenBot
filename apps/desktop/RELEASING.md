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
| `.github/workflows/release.yml`           | The release: tag version, then the jobs below, then the Release     |
| `.github/workflows/release-images.yml`    | Builds and pushes the images and writes their archives              |
| `.github/workflows/release-mac.yml`       | Packages the Mac app, signed and notarized when the secrets are set |
| `scripts/release-version.mjs`             | Validates tags and stamps versions into build checkouts             |
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

1. Merge the changes you want to ship into `main`. No package-version bump or release commit is required.
2. Fetch GitHub's `main`, review the commit, then tag it and push the tag:

   ```sh
   git fetch origin
   git log -1 --oneline origin/main
   git tag -a v1.2.0 origin/main -m "Release 1.2.0"
   git push origin v1.2.0
   ```

   This tags the fetched remote commit, not your local branch or uncommitted changes. Use a new,
   higher version for each release. Tags must be `v<major>.<minor>.<patch>`, optionally with a
   prerelease suffix such as `v1.3.0-rc.1`; build metadata (`+...`) is not supported.

3. Watch the Release workflow in the Actions tab. `Version` validates the tag and derives the
   release metadata without comparing committed package versions. Each Mac/image build job
   stamps the root, desktop and mobile package versions in its disposable checkout before
   building. Docker builds use that local checkout as their context, so the running server and
   the Mac app's bundled image references agree with the tag. Nothing is committed back, and
   the installed apps do not need Git at runtime.

   The images, Mac app and compose bundle build in parallel. `GitHub Release` publishes once
   all three have succeeded. It is a draft while files upload, so electron-updater never sees a
   release without its files. The separate **Release iOS app** workflow stamps the same tag
   version before Expo/EAS builds; when credentials are configured it submits to TestFlight.

4. The first time only, make the images public (below). The `GitHub Release` job's summary says
   whether each package is public and warns when one is not.
5. Check the release page: the notes, the DMG, the bundle, the image archives, `SHA256SUMS` and
   `latest-mac.yml`. Install the DMG on a clean Mac.
6. For Homebrew, copy `openbots.rb` from the release into the tap's `Casks/` directory and open a
   pull request there.

For a manual build in a disposable checkout, run `node scripts/release-version.mjs stamp v1.2.0`
first. `from-tag v1.2.0` prints metadata without modifying files. `pnpm release:bump <version>`
remains an optional development helper, and `pnpm release:check v1.2.0` can verify stamped files;
neither is a prerequisite for pushing a release tag.

The native About panel displays the packaged version stamped from the release tag, without a
second duplicate build number. Unstamped local builds embed the nearest reachable release tag
at build time and label it development; without Git or a release tag they show "Development
build". Installed apps do not need Git. This About-only fallback does not change the local
package version, updater identity or the server image version; use the stamp command above
when making a versioned package.

Update discovery follows Bento's desktop lifecycle: the first background check is 30 seconds
after launch, then every six hours. Updates appear in an OpenBots-themed bottom-right in-app
notice (Update or Restart and update), never an OS notification. Dismissing hides that version
for the app session across documents; a newer version brings it back. The app and tray menus
show checking, downloading, ready and preparing states. Manual Check for Updates reports
up-to-date, skipped and failed checks in native dialogs. Lookup requests time out after 30
seconds and downloads after ten minutes; repeated clicks share one operation.

Restart requires consent with Later as the default. Native Squirrel verifies/stages the update
before the app disconnects and quits; ordinary quit never installs an update. OpenBots's Docker
stack is independent of the app and stays running, as do remote agents. The existing local
stack-upgrade flow handles newer images after relaunch. Source/development builds do not check
for updates; unsigned versioned packages offer a universal DMG from the configured release
repository instead. A matching ZIP also identifies older releases whose update metadata omitted
the DMG; the app verifies the derived installer exists before opening it in the browser.

A failed job can be rerun from the Actions tab. Rerunning `GitHub Release` finishes the release
that exists instead of failing: a draft gets its files and is published, and a published release
gets its files again with `latest-mac.yml` last.

To release a tag again from the start (say a secret was missing when it was pushed), run the
workflow by hand: Actions, Release, Run workflow, with the tag (`v1.2.0`) in **tag**. Every job
builds the tag's commit, whichever branch the run starts from, and publishes as the tag's push
would. Only the newest tag can be released again, since a release moves the `latest` image tags
and the Mac app's update. To release a new commit instead, delete the release and the tag
(`git push --delete origin v1.2.0`), fix, and tag again.

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

## Release triggers and PR checks

Release builds run automatically only when a version tag is pushed. A manual run must name an
existing release tag and is a retry, not an untagged dry run. Pull requests and untagged branch
pushes do not run the release workflow, universal Mac packaging or release-image archives.

Normal PR validation remains in `.github/workflows/ci.yml`, including unit tests, lint,
typechecking, application builds, Docker smoke tests and browser tests. These are development
checks, not release publication. Local unsigned Mac packaging is described below.

## Signing the Mac app

A release must be signed. The tag build signs with the Developer ID certificate, notarizes and
staples in the `afterSign` hook, and verifies with `codesign`, `spctl` and `stapler`; it fails
rather than ship a signed app that is not notarized (`OPENBOTS_REQUIRE_NOTARIZATION=1`).

Without all five secrets below, the Mac job fails and nothing is published. Squirrel.Mac only
installs updates signed by the same Developer ID, so electron-updater cannot update an unsigned
app: an unsigned release would leave everyone who installs it on that version until they replace
it by hand. Set the secrets, then release the tag again (Cutting a release, above).
Local unsigned builds are ad-hoc signed and cannot update themselves automatically. If they
have a stamped version, they can discover updates and offer the universal DMG for manual
replacement; unstamped `0.0.0` development builds leave update checks disabled.

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
for `electron-builder.yml`, the jobs' permissions and pinned actions, and tag-derived version stamping.
