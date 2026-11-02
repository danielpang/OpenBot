#!/usr/bin/env bash
# Packs the compose bundle a release attaches (apps/desktop/RELEASING.md): the
# files a Docker Compose install needs and nothing it would build from source.
#
#   bash scripts/release-bundle.sh <version> <image prefix> <output dir>
#
# Writes <output dir>/openbots-compose-<version>.tar.gz with one top-level
# directory, openbots-<version>, holding compose.yaml, .env.example (its
# OPENBOTS_VERSION and OPENBOTS_IMAGE_PREFIX set to this release), install.sh,
# docker/docker-compose.yml, docker/docker-compose.tunnels.yml,
# docker/egress-proxy/ and scripts/backup.sh and restore.sh.
# docker/docker-compose.dev.yml is left out: it builds from a checkout.
set -euo pipefail

[ "$#" -eq 3 ] || {
  echo "usage: release-bundle.sh <version> <image prefix> <output dir>" >&2
  exit 2
}
version="$1"
prefix="$2"
out="$3"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="openbots-$version"
stage="$work/$name"

mkdir -p "$stage/docker/egress-proxy" "$stage/scripts"
cp "$repo/compose.yaml" "$repo/install.sh" "$stage/"
cp "$repo/docker/docker-compose.yml" "$repo/docker/docker-compose.tunnels.yml" "$stage/docker/"
cp "$repo/docker/egress-proxy/"* "$stage/docker/egress-proxy/"
cp "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$stage/scripts/"
chmod 755 "$stage/install.sh" "$stage/scripts/backup.sh" "$stage/scripts/restore.sh"

# The release's images, so `docker compose up` runs exactly this version.
awk -v version="$version" -v prefix="$prefix" '
  /^OPENBOTS_VERSION=/ { print "OPENBOTS_VERSION=" version; found_version = 1; next }
  /^OPENBOTS_IMAGE_PREFIX=/ { print "OPENBOTS_IMAGE_PREFIX=" prefix; found_prefix = 1; next }
  { print }
  END { if (!found_version || !found_prefix) exit 1 }
' "$repo/.env.example" >"$stage/.env.example"

mkdir -p "$out"
archive="$(cd "$out" && pwd)/openbots-compose-$version.tar.gz"
# Stable owner and order, so the archive depends only on its contents.
tar -C "$work" --owner=0 --group=0 --numeric-owner --sort=name -czf "$archive" "$name" 2>/dev/null ||
  tar -C "$work" -czf "$archive" "$name"
echo "$archive"
