#!/usr/bin/env bash
# Checks that anyone can pull a release's images from GHCR without logging in
# (apps/desktop/RELEASING.md). GHCR makes every new package private, and its
# API cannot change that, so the owner sets each package to public once by
# hand; until then installs cannot pull the images.
#
#   bash scripts/release-check-public.sh <image prefix> <tag> [image ...]
#   bash scripts/release-check-public.sh ghcr.io/danielpang/openbots 1.2.0
#
# Asks the registry anonymously, as `docker pull` does without a login: an
# anonymous token, then the manifest. Prints one line per image, "public" or
# "private", and exits 1 when any image is private. The images default to
# server, computer and sandbox-firewall.
set -euo pipefail

[ "$#" -ge 2 ] || {
  echo "usage: release-check-public.sh <image prefix> <tag> [image ...]" >&2
  exit 2
}
prefix="$1"
tag="$2"
shift 2
[ "$#" -gt 0 ] || set -- server computer sandbox-firewall

registry="${prefix%%/*}"
namespace="${prefix#*/}"
accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

status=0
for image in "$@"; do
  repository="$namespace/$image"
  token="$(curl -fsS "https://$registry/token?service=$registry&scope=repository:$repository:pull" 2>/dev/null |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || token=""
  code=000
  if [ -n "$token" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --head \
      -H "Authorization: Bearer $token" -H "Accept: $accept" \
      "https://$registry/v2/$repository/manifests/$tag" 2>/dev/null)" || code=000
  fi
  if [ "$code" = 200 ]; then
    echo "$image public"
  else
    echo "$image private"
    status=1
  fi
done
exit "$status"
