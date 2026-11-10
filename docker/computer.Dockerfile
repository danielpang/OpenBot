# syntax=docker/dockerfile:1
# The computer image: one sandbox per account with a browser, a filesystem and
# a terminal, driven by the control agent in apps/computer-agent (plan 9.1,
# 9.3). Build from the repository root:
#
#   docker build -f docker/computer.Dockerfile -t ghcr.io/openbots/computer .
#
# Every stage runs on the target platform, Node comes from the official image
# for that platform and Chromium from Playwright's per-arch download, so
# `docker buildx build --platform linux/amd64,linux/arm64` works as is.
#
# The container expects the hardening of plan 9.5 from the provider: its own
# network, cap-drop ALL plus CHOWN, SETUID and SETGID, no-new-privileges,
# read-only root with volumes on /home/bot and /var/lib/openbots and a tmpfs
# on /tmp, and the agent token in /var/lib/openbots/token, never in the
# environment. It starts as root: the agent reads and deletes the token, lays
# out a private directory per screen, drops to the bot user, and starts every
# program through openbots-runas, so each screen runs as its own user (S-7,
# apps/computer-agent/src/privileges.ts).

# The full image carries python3, make and g++ for node-pty's native build.
ARG NODE_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
ARG UBUNTU_IMAGE=ubuntu:24.04

# --- base: Node 22 with pnpm from corepack (pinned by packageManager) ---------
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm && pnpm --version

# --- fetch: the store from the lockfile alone, cached until it changes --------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
RUN pnpm fetch --store-dir /pnpm-store

# --- build: the agent and the workspace packages it imports -------------------
FROM fetch AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm-store \
    && pnpm exec turbo run build --filter=@openbots/computer-agent
# Gather each package's dist/ under /out, keeping the workspace layout.
RUN mkdir /out && for dist in apps/*/dist packages/*/dist; do \
      mkdir -p "/out/$(dirname "$dist")" && cp -r "$dist" "/out/$dist"; \
    done
# The user-switching helper, static so no dynamic loader reads LD_* for it.
RUN mkdir /native \
    && gcc -O2 -Wall -Werror -static -o /native/runas apps/computer-agent/native/runas.c

# --- prod-deps: production dependencies, node-pty compiled for this arch ------
# node-pty is optional so checkouts without a C++ toolchain still install; here
# the toolchain is present and the build fails unless the binding loads.
FROM fetch AS prod-deps
COPY . .
RUN pnpm install --prod --frozen-lockfile --offline \
      --filter "@openbots/computer-agent..." --store-dir /pnpm-store \
    && node -e "require(require.resolve('node-pty', { paths: ['apps/computer-agent'] }))"

# --- node: the Node binary for the target platform ----------------------------
FROM ${NODE_RUNTIME_IMAGE} AS node

# --- mcp-catalog: the catalog's stdio MCP servers, from their lockfile -------
# On the managed service a connector's stdio server runs in its owner's
# computer (OPENBOTS_STDIO_RUNNER=computer), which starts these binaries, the
# same pinned install as the server image's: nothing is downloaded at run
# time (S-20). Pure JavaScript, no install scripts: the same lockfile serves
# every platform, and the runtime's node runs them.
FROM ${NODE_RUNTIME_IMAGE} AS mcp-catalog
WORKDIR /opt/openbots/mcp
COPY docker/mcp-catalog/package.json docker/mcp-catalog/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

# --- coders: the coding agents, from their lockfile (I1) ----------------------
# Claude Code, Codex and pi, pinned in docker/coders/package-lock.json and
# installed once here, root-owned in the final image: nothing is downloaded at
# run time (S-20). The lockfile lists every platform's native package; npm
# installs the one for the build's platform, so each architecture builds its
# own. Install scripts stay off for every package. The one that matters is
# Claude Code's: its postinstall puts the native binary from
# @anthropic-ai/claude-code-linux-<arch> in place of the bin/claude.exe stub,
# so it runs here, by hand, and the build fails unless each CLI then answers
# --version. Codex's bin is a JS launcher that finds its platform package
# itself; pi is a single JS bundle. The other packages with scripts
# (@google/genai's is a no-op, protobufjs's a version notice) need none.
FROM ${NODE_RUNTIME_IMAGE} AS coders
WORKDIR /opt/openbots/coders
COPY docker/coders/package.json docker/coders/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache \
    && node node_modules/@anthropic-ai/claude-code/install.cjs \
    && node_modules/@anthropic-ai/claude-code/bin/claude.exe --version \
    && node node_modules/@openai/codex/bin/codex.js --version \
    && node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version
# Each installed CLI must be exactly the pinned version: a lockfile drift or a
# package that resolves to another build fails the image here, not on a Bot's
# computer (design: Testing, "a CI check runs <cli> --version and fails when it
# differs from the pin"). The template literals are for node, not the shell.
# hadolint ignore=SC2016
RUN node -e ' \
      const want = require("./package.json").dependencies; \
      for (const name of Object.keys(want)) { \
        const have = require(`./node_modules/${name}/package.json`).version; \
        if (have !== want[name]) { console.error(`${name}: installed ${have}, pinned ${want[name]}`); process.exit(1); } \
        console.log(`${name} ${have}`); \
      }'

# --- runtime --------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS runtime
ARG DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OPENBOTS_HOME=/home/bot \
    OPENBOTS_STATE_DIR=/var/lib/openbots \
    OPENBOTS_AGENT_PORT=7070

# The desktop (Xvfb, openbox, feh for the wallpaper), the VNC server the
# preview reads through the agent's websockify bridge, xdotool for pixel
# input, ImageMagick's `import` for screenshots, tini to reap what Bots start,
# tzdata so the shells follow TZ (OPENBOTS_TIMEZONE), and a small set of
# everyday tools for the terminal.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc xdotool feh imagemagick tini tzdata \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      ca-certificates curl git less nano procps python3 unzip xz-utils util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Owned by root: the bot user can run the catalog servers but not change them.
COPY --from=mcp-catalog /opt/openbots/mcp /opt/openbots/mcp
# Root's too: the coder user runs the coding agents and cannot change them.
COPY --from=coders /opt/openbots/coders /opt/openbots/coders

# Native launchers hold openbots-auth.lock for credential-owning sessions, so
# the bridge cannot rotate/write the same token concurrently. Read-only version
# and status commands skip it. Keep the lock inode across disconnects.
# The coding agents on PATH for the coder user and the terminal (I1), and git's
# credential helper (I5, apps/computer-agent/src/git-credential-helper.ts),
# which every git call in the computer asks: it answers only for a running
# coding session, over that session's unix socket with the secret the agent
# put in the session's environment. The rest of git's system
# config: worktrees start on main. Each clone sets core.sharedRepository
# itself (the server's checkout), so the coder user and the bot user share it.
# hadolint ignore=SC2016
RUN agents=/opt/openbots/coders/node_modules \
    && printf '#!/bin/sh\ncli=%s\ncase "$1:$2" in --version:*|auth:status) exec "$cli" "$@";; esac\ndir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}\nmkdir -p "$dir"\nexec flock -x "$dir/openbots-auth.lock" "$cli" "$@"\n' "$agents/@anthropic-ai/claude-code/bin/claude.exe" \
         > /usr/local/bin/claude \
    && printf '#!/bin/sh\ncli=%s\ncase "$1:$2" in --version:*|login:status) exec node "$cli" "$@";; esac\ndir=${CODEX_HOME:-$HOME/.codex}\nmkdir -p "$dir"\nexec flock -x "$dir/openbots-auth.lock" node "$cli" "$@"\n' "$agents/@openai/codex/bin/codex.js" \
         > /usr/local/bin/codex \
    && printf '#!/bin/sh\nexec node %s "$@"\n' "$agents/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
         > /usr/local/bin/pi \
    && printf '#!/bin/sh\nexec node %s "$@"\n' /app/apps/computer-agent/dist/git-credential-helper.js \
         > /usr/local/bin/openbots-git-credential \
    && chmod 0755 /usr/local/bin/claude /usr/local/bin/codex /usr/local/bin/pi \
         /usr/local/bin/openbots-git-credential \
    && git config --system credential.helper /usr/local/bin/openbots-git-credential \
    && git config --system credential.useHttpPath true \
    && git config --system init.defaultBranch main
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /out /app

# Chromium from Playwright, matching the bundled playwright-core, with the
# system libraries it needs. The headless shell is not needed: every screen
# runs a headed Chromium on its own display.
RUN node apps/computer-agent/node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# The Bot user owns the persistent home; Ubuntu's own uid 1000 makes way.
# Screen n runs as screen-n (uid and gid 2000+n, apps/computer-agent/src/
# users.ts), the shared cookie store is the cookies user's (1900), and the
# coding agents run as coder (1800), whose home, writable and its own, is on
# the state volume (the agent lays it out), and whose group, coders, the bot
# user shares for the repositories (I2). The server's own git operations run
# as coder-runner (1801, group coders), so no coding session shares their uid
# and can read their environment; the names are for ps and ls, the
# agent uses the numbers. The state volume's mount point is root's, so a new
# volume starts out that way.
RUN userdel --remove ubuntu \
    && useradd --uid 1000 --user-group --create-home --home-dir /home/bot --shell /bin/bash bot \
    && groupadd --gid 1900 cookies \
    && useradd --uid 1900 --gid 1900 --no-create-home --home-dir /var/lib/openbots/cookies \
         --shell /usr/sbin/nologin cookies \
    && groupadd --gid 1800 coders \
    && useradd --uid 1800 --gid 1800 --no-create-home --home-dir /var/lib/openbots/coders/home \
         --shell /bin/bash coder \
    && useradd --uid 1801 --gid 1800 --no-create-home --home-dir /var/lib/openbots/coders/runner-home \
         --shell /usr/sbin/nologin coder-runner \
    && usermod -aG coders bot \
    && for n in $(seq 0 89); do \
         groupadd --gid $((2000 + n)) "screen-$n" \
         && useradd --uid $((2000 + n)) --gid $((2000 + n)) --no-create-home \
              --home-dir "/var/lib/openbots/screens/screen-$n" --shell /usr/sbin/nologin "screen-$n"; \
       done \
    && install -d -m 0711 -o root -g root /var/lib/openbots
COPY --from=build --chmod=0755 /native/runas /usr/local/libexec/openbots/runas

# Root, but only until the agent has read its token and laid the screens out;
# then its effective uid is the bot user's (privileges.ts).
# hadolint ignore=DL3002
USER 0:0
WORKDIR /home/bot
EXPOSE 7070
# The token is gone by the time the agent listens, so any answer, a 401
# included, means it is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/bin/bash", "-c", "curl -sS -o /dev/null \"http://127.0.0.1:$OPENBOTS_AGENT_PORT/healthz\""]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/apps/computer-agent/dist/main.js"]
