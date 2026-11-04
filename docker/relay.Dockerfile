# syntax=docker/dockerfile:1
# The OpenBots private relay: host links, client streams and the APNs gateway
# (apps/relay, docs/RELAY_PROTOCOL.md). Build from the repository root:
#
#   docker build -f docker/relay.Dockerfile -t ghcr.io/danielpang/openbots/relay .
#
# It speaks plain HTTP and WebSocket on 3200; put it behind a TLS terminator
# and set RELAY_TRUST_PROXY=true so it reads client addresses from the proxy.
# Every stage runs on the target platform and nothing arch-specific is
# downloaded by hand, so `docker buildx build --platform linux/amd64,linux/arm64`
# works as is.

ARG NODE_IMAGE=node:22-bookworm-slim

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
RUN pnpm fetch --store-dir /pnpm-store

# --- build: the relay and any workspace packages it imports --------------------
FROM fetch AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm-store \
    && pnpm exec turbo run build --filter=@openbots/relay
# Gather each package's dist/ under /out, keeping the workspace layout.
RUN mkdir /out && for dist in apps/*/dist packages/*/dist; do \
      [ -d "$dist" ] || continue; \
      mkdir -p "/out/$(dirname "$dist")" && cp -r "$dist" "/out/$dist"; \
    done

# --- prod-deps: production dependencies of the relay ---------------------------
# As in the server image, no ee/ code ships in it.
FROM fetch AS prod-deps
COPY . .
RUN pnpm install --prod --frozen-lockfile --offline --filter "@openbots/relay..." --store-dir /pnpm-store \
    && rm -rf ee

# --- runtime -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    RELAY_PORT=3200
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /out /app
WORKDIR /app/apps/relay
# 1000 is the `node` user of the official Node images. The relay writes
# nothing to disk. An APNs key, when there is one, comes in RELAY_APNS_KEY
# (read once at start, then deleted from the environment) or as a file in
# RELAY_APNS_KEY_FILE, which must then be readable by user 1000.
USER 1000:1000
EXPOSE 3200
# The slim image has no curl; Node's own fetch asks the relay.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.RELAY_PORT || 3200) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
