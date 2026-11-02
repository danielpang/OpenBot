# The sandbox-firewall service: applies docker/sandbox-firewall.sh in the Docker
# host's network namespace (docker/docker-compose.yml). Published with each
# release (.github/workflows/release.yml) as
# ${OPENBOTS_IMAGE_PREFIX}/sandbox-firewall; built from docker/:
#
#   docker build -f docker/sandbox-firewall.Dockerfile docker
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# The base is pinned by digest; pinning apk versions as well would break the
# build each time Alpine replaces a package in its repository.
# hadolint ignore=DL3018
RUN apk add --no-cache iptables iptables-legacy
COPY --chmod=755 sandbox-firewall.sh /usr/local/bin/sandbox-firewall
ENTRYPOINT ["/usr/local/bin/sandbox-firewall"]
