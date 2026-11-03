#!/usr/bin/env bash
# Writes the GitHub Release notes for a release tag to stdout
# (.github/workflows/release.yml, apps/desktop/RELEASING.md): how to install
# each download, whether the Mac app is signed, and the commits since the
# previous release tag.
#
#   TAG=v1.2.0 REPOSITORY=owner/repo IMAGE_PREFIX=ghcr.io/owner/openbots \
#     SIGNED=true PRERELEASE=false PRIVATE_IMAGES="" bash scripts/release-notes.sh
#
# PRIVATE_IMAGES lists the images an anonymous pull cannot reach yet
# (scripts/release-check-public.sh); the notes then point at the image
# archives instead. Run it in a clone with the tags fetched.
set -euo pipefail

: "${TAG:?TAG is required, such as v1.2.0}"
: "${REPOSITORY:?REPOSITORY is required, such as danielpang/OpenBots}"
: "${IMAGE_PREFIX:?IMAGE_PREFIX is required, such as ghcr.io/danielpang/openbots}"
SIGNED="${SIGNED:-false}"
PRERELEASE="${PRERELEASE:-false}"
PRIVATE_IMAGES="${PRIVATE_IMAGES:-}"
MAX_COMMITS="${MAX_COMMITS:-200}"

version="${TAG#v}"
minor="$(printf '%s' "$version" | cut -d . -f 1-2)"
download="https://github.com/$REPOSITORY/releases/download/$TAG"
fence='```'

cat <<EOF
OpenBots $version: the Mac app, the container images and the Docker Compose bundle, released
together from one tag.

## Mac app

Download \`OpenBots-$version-universal.dmg\` (Apple Silicon and Intel), open it and drag OpenBots to
Applications. "Run OpenBots on this Mac" needs Docker Desktop or OrbStack.

EOF

if [ "$SIGNED" = true ]; then
  cat <<EOF
The app is signed with a Developer ID and notarized by Apple. Installed copies of a signed earlier
release update themselves to this one.

EOF
else
  cat <<EOF
**Unsigned build: right-click Open on first launch.** This build is not signed with a Developer
ID or notarized, so macOS blocks a double click the first time. In Applications, right-click
OpenBots and choose Open. On macOS 15 or later, if there is no Open button, go to System Settings,
Privacy & Security, and click Open Anyway.

Automatic updates (electron-updater) only work for signed builds, so this release carries no
\`latest-mac.yml\` and installed copies do not move to it by themselves. Download new releases from
this page.

EOF
fi

cat <<EOF
## Docker Compose

For a server or any machine with Docker Compose 2.24 or later:

${fence}sh
curl -fsSLO $download/openbots-compose-$version.tar.gz
tar -xzf openbots-compose-$version.tar.gz
cd openbots-$version
bash install.sh
${fence}

On a VM, \`bash install.sh --pair\` also prints a QR code that pairs the OpenBots phone app.

The bundle holds the compose files, \`.env.example\`, \`install.sh\`, the egress proxy settings and
the backup and restore scripts. Its \`.env.example\` runs this release's images
(\`OPENBOTS_VERSION=$version\`).

## Container images

For linux/amd64 and linux/arm64:

EOF

for image in server computer sandbox-firewall relay standalone; do
  if [ "$PRERELEASE" = true ]; then
    echo "- \`$IMAGE_PREFIX/$image:$version\`"
  else
    echo "- \`$IMAGE_PREFIX/$image:$version\` (also \`:$minor\` and \`:latest\`)"
  fi
done
echo
cat <<EOF
\`relay\` is the private relay, for running your own beside the compose stack (its \`relay\` profile).
\`standalone\` is the whole of OpenBots in one container, for a platform that runs one container
and no Docker inside it; \`deploy/\` in the repository has templates for Fly.io, Sprites and EC2.

EOF

if [ "$PRERELEASE" = true ]; then
  cat <<EOF
This is a prerelease: \`:$minor\` and \`:latest\` still point at the last release, and the Mac app
does not offer it as an update.

EOF
fi

if [ -n "$PRIVATE_IMAGES" ]; then
  cat <<EOF
**These images are not public yet** ($PRIVATE_IMAGES), so pulling them needs a GitHub login with
access to the packages. Until they are public, load them from the image archives below. (For the
maintainer: open each package's settings on GitHub, choose Change visibility, then Public.)

EOF
fi

cat <<EOF
## Image archives

\`openbots-<image>-$version-linux-<arch>.tar.gz\` holds one image for one architecture (\`amd64\`, or
\`arm64\` for Apple Silicon and ARM servers), for machines that cannot pull from GHCR:

${fence}sh
docker load -i openbots-server-$version-linux-arm64.tar.gz
${fence}

## Verify the downloads

${fence}sh
sha256sum --ignore-missing -c SHA256SUMS          # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS      # macOS
${fence}

EOF

previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' "$TAG^" 2>/dev/null || true)"
if [ -n "$previous" ]; then
  echo "## Changes since $previous"
  range="$previous..$TAG"
else
  echo "## Changes"
  range="$TAG"
fi
echo
total="$(git rev-list --no-merges --count "$range")"
git log --no-merges --format='- %s (%h)' -n "$MAX_COMMITS" "$range"
if [ "$total" -gt "$MAX_COMMITS" ]; then
  echo
  echo "And $((total - MAX_COMMITS)) earlier commits: https://github.com/$REPOSITORY/commits/$TAG"
fi
