# syntax=docker/dockerfile:1
# The standalone image: the whole of OpenBots in one container with one
# volume on /data (plan 8.2, V1). The server, PostgreSQL with pgvector,
# Redis and the Bots' computer (the computer image's control agent, desktop
# and Chromium) run side by side under s6-overlay, for platforms that run
# one container and no Docker inside it (Fly Machines, Sprites, Railway,
# Render) and for a plain `docker run`. Build from the repository root:
#
#   docker build -f docker/standalone.Dockerfile -t ghcr.io/danielpang/openbots/standalone .
#
# The JavaScript build (base-build, build) runs on the build platform, so an
# arm64 image built on an amd64 runner compiles TypeScript and bundles the
# web app at native speed instead of under QEMU; its output is the same on
# every platform. The stages that make native code or install packages
# (prod-deps with node-pty, native, runtime) run on the target platform.
# s6-overlay is picked by TARGETARCH and checked against its release
# checksums, so `docker buildx build --platform linux/amd64,linux/arm64`
# works as is.
#
# POSTGRES_MAJOR picks the PostgreSQL version: it drives the package, PATH
# and the file the scripts read (postgres-major). A volume made by one major
# version does not start under another; docker/standalone/README.md, Upgrade.
# docker/standalone/README.md describes what runs inside and how to use it.

# The full image carries python3, make and g++ for node-pty's native build.
ARG NODE_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
ARG UBUNTU_IMAGE=ubuntu:24.04

# --- base: Node 22 with pnpm from corepack (pinned by packageManager) ---------
# On the target platform, for prod-deps (node-pty is compiled for it).
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && pnpm --version

# --- fetch: the store from the lockfile alone, cached until it changes --------
# pnpm fetches the optional packages of its own platform, so the target's
# store and the build platform's are fetched apart.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --store-dir /pnpm-store

# --- base-build: the same on the build platform, for the JavaScript build -----
# hadolint ignore=DL3029
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS base-build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && pnpm --version
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --store-dir /pnpm-store

# --- build: the server, the web app and the computer agent ---------------------
# Only dist/ leaves this stage, and it holds no native code.
FROM base-build AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm-store \
    && pnpm exec turbo run build \
         --filter=@openbots/server --filter=@openbots/web --filter=@openbots/computer-agent
# Gather each package's dist/ under /out, keeping the workspace layout.
RUN mkdir /out && for dist in apps/*/dist packages/*/dist; do \
      mkdir -p "/out/$(dirname "$dist")" && cp -r "$dist" "/out/$dist"; \
    done

# --- native: the user-switching helper, for the target platform ----------------
# Static, so no dynamic loader reads LD_* for it.
FROM ${NODE_IMAGE} AS native
WORKDIR /src
COPY apps/computer-agent/native/runas.c ./
RUN mkdir /native \
    && gcc -O2 -Wall -Werror -static -o /native/runas runas.c

# --- prod-deps: production dependencies of the server and the agent -----------
# As in the server image, no ee/ code; as in the computer image, node-pty is
# compiled for this arch and the build fails unless the binding loads.
FROM fetch AS prod-deps
COPY . .
RUN pnpm install --prod --frozen-lockfile --offline \
      --filter "@openbots/server..." --filter "@openbots/computer-agent..." \
      --store-dir /pnpm-store \
    && rm -rf ee \
    && node -e "require(require.resolve('node-pty', { paths: ['apps/computer-agent'] }))"

# --- node: the Node binary for the target platform ----------------------------
FROM ${NODE_RUNTIME_IMAGE} AS node

# --- mcp-catalog: the catalog's stdio MCP servers, from their lockfile -------
# Stdio connectors run under the computer agent here
# (OPENBOTS_STDIO_RUNNER=computer), which starts these binaries: nothing is
# downloaded at run time (S-20).
FROM ${NODE_RUNTIME_IMAGE} AS mcp-catalog
WORKDIR /opt/openbots/mcp
COPY docker/mcp-catalog/package.json docker/mcp-catalog/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

# --- s6: s6-overlay, the container's init and supervisor -----------------------
FROM ${UBUNTU_IMAGE} AS s6
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.3.2
# From the release's .sha256 files.
ARG S6_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12
ARG S6_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408
ARG S6_AARCH64_SHA256=b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c
ARG S6_SYMLINKS_NOARCH_SHA256=a215675c375aca9efecde3065df22b19fb8dcdc1362566931c6b5e778099a0fb
ARG S6_SYMLINKS_ARCH_SHA256=6251226709efc0c88800a8c140404d93b391e1b4051ef50fa0e8aac1fdcf738c
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /s6
RUN case "$TARGETARCH" in \
      amd64) arch=x86_64; arch_sha="$S6_X86_64_SHA256" ;; \
      arm64) arch=aarch64; arch_sha="$S6_AARCH64_SHA256" ;; \
      *) echo "no s6-overlay build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && url="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}" \
    && for f in noarch "$arch" symlinks-noarch symlinks-arch; do \
         curl -fsSLo "s6-overlay-$f.tar.xz" "$url/s6-overlay-$f.tar.xz"; \
       done \
    && printf '%s  %s\n' \
         "$S6_NOARCH_SHA256" s6-overlay-noarch.tar.xz \
         "$arch_sha" "s6-overlay-$arch.tar.xz" \
         "$S6_SYMLINKS_NOARCH_SHA256" s6-overlay-symlinks-noarch.tar.xz \
         "$S6_SYMLINKS_ARCH_SHA256" s6-overlay-symlinks-arch.tar.xz \
       | sha256sum -c - \
    && mkdir /root-fs \
    && for f in s6-overlay-*.tar.xz; do tar -C /root-fs -Jxpf "$f"; done

# --- runtime --------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS runtime
ARG DEBIAN_FRONTEND=noninteractive
ARG POSTGRES_MAJOR=16
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PATH=/usr/lib/postgresql/${POSTGRES_MAJOR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OPENBOTS_STANDALONE=1 \
    OPENBOTS_SETUP_PAIRING_ONLY=1 \
    # s6-overlay: stop the container when a startup step fails (a refused
    # setting, a database that does not start), wait as long as the first
    # boot's migrations take, and give the services time to stop cleanly:
    # 40 seconds for the services (PostgreSQL's fast shutdown writes a
    # checkpoint), then 5 for what is left, which fits in the 60 seconds of
    # `docker stop -t 60` (or --stop-timeout 60) and Fly's kill_timeout.
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_SERVICES_GRACETIME=40000 \
    S6_KILL_GRACETIME=5000

# The computer image's desktop and tools (docker/computer.Dockerfile): Xvfb,
# openbox and feh for the wallpaper, x11vnc for the preview, xdotool for
# input, ImageMagick for screenshots, tzdata for OPENBOTS_TIMEZONE, the
# terminal's everyday tools, and iptables for the optional metadata block
# (standalone-init, with NET_ADMIN).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc xdotool feh imagemagick tzdata iptables \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      ca-certificates curl git less nano procps python3 unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The users, with fixed ids so a volume keeps working across image builds:
# the Bot user owns the persistent home (uid 1000, as in the computer image,
# which apps/computer-agent/src/users.ts and runas.c expect); screen n runs as
# screen-n (2000+n) and the cookie store is the cookies user's (1900); the
# server runs as openbots (990), so no Bot shares its uid; postgres (991) and
# redis (992) exist before their packages, which then keep them.
RUN userdel --remove ubuntu \
    && useradd --uid 1000 --user-group --no-create-home --home-dir /home/bot --shell /bin/bash bot \
    && groupadd --gid 1900 cookies \
    && useradd --uid 1900 --gid 1900 --no-create-home --home-dir /data/agent/cookies \
         --shell /usr/sbin/nologin cookies \
    && for n in $(seq 0 89); do \
         groupadd --gid $((2000 + n)) "screen-$n" \
         && useradd --uid $((2000 + n)) --gid $((2000 + n)) --no-create-home \
              --home-dir "/data/agent/screens/screen-$n" --shell /usr/sbin/nologin "screen-$n"; \
       done \
    && groupadd --system --gid 990 openbots \
    && useradd --system --uid 990 --gid 990 --no-create-home --home-dir /var/lib/openbots-server \
         --shell /usr/sbin/nologin openbots \
    && install -d -m 0700 -o openbots -g openbots /var/lib/openbots-server \
    && groupadd --system --gid 991 postgres \
    && useradd --system --uid 991 --gid 991 --no-create-home --home-dir /var/lib/postgresql \
         --shell /bin/bash postgres \
    && groupadd --system --gid 992 redis \
    && useradd --system --uid 992 --gid 992 --no-create-home --home-dir /var/lib/redis \
         --shell /usr/sbin/nologin redis

# PostgreSQL from the PGDG repository, one major version, with pgvector, and
# Redis. No cluster is made here: standalone-init makes one on the volume.
# hadolint ignore=DL3008,SC1091
RUN install -d /usr/share/postgresql-common/pgdg /etc/postgresql-common \
    && curl -fsSLo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
         https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
         >/etc/apt/sources.list.d/pgdg.list \
    && echo 'create_main_cluster = false' >/etc/postgresql-common/createcluster.conf \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         "postgresql-${POSTGRES_MAJOR}" "postgresql-${POSTGRES_MAJOR}-pgvector" redis-server \
    && rm -rf /var/lib/apt/lists/* \
    && test -x "/usr/lib/postgresql/${POSTGRES_MAJOR}/bin/postgres"

COPY --from=s6 /root-fs/ /
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Owned by root: the server and the Bots can run the catalog servers but not
# change them.
COPY --from=mcp-catalog /opt/openbots/mcp /opt/openbots/mcp
WORKDIR /app
COPY --from=prod-deps /app /app
# apps/server serves apps/web/dist (WEB_DIST in apps/server/src/app.ts).
COPY --from=build /out /app

# Chromium from Playwright, matching the agent's playwright-core, with the
# system libraries it needs (as in the computer image).
RUN node apps/computer-agent/node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

COPY --from=native --chmod=0755 /native/runas /usr/local/libexec/openbots/runas
COPY --chmod=0755 docker/entrypoint.sh /usr/local/lib/openbots/entrypoint.sh
COPY --chmod=0755 docker/standalone/lib/ /usr/local/lib/openbots/standalone/
COPY --chmod=0755 docker/standalone/bin/openbots /usr/local/bin/openbots
COPY --chmod=0755 scripts/backup.sh scripts/restore.sh /app/scripts/
COPY docker/standalone/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY docker/standalone/user-bundles.d/ /etc/s6-overlay/user-bundles.d/
# The Bots' home lives on the volume. postgres-major tells the scripts
# (lib/env.sh) which PostgreSQL this image runs.
RUN chmod 0755 /etc/s6-overlay/s6-rc.d/*/run \
    && printf '%s\n' "$POSTGRES_MAJOR" >/usr/local/lib/openbots/standalone/postgres-major \
    && chmod 0644 /usr/local/lib/openbots/standalone/postgres-major \
    && rm -rf /home/bot && ln -s /data/home /home/bot \
    && install -d -m 0711 /data

VOLUME /data
EXPOSE 3000
# The first boot makes the database and runs every migration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:3000/readyz"]
# s6-overlay's init starts volume-lock, standalone-init, postgres, redis,
# computer-agent, openbots and disk-watch (docker/standalone/s6-rc.d),
# restarts any that dies and stops them in order on SIGTERM. Give it 60
# seconds to do so: `docker stop -t 60`, `docker run --stop-timeout 60`.
# It must run as root.
STOPSIGNAL SIGTERM
# hadolint ignore=DL3002
USER 0:0
ENTRYPOINT ["/init"]
