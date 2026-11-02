# syntax=docker/dockerfile:1
# The OpenBots server image: API, web UI, workers and scheduler (plan 16.1).
# Build from the repository root:
#
#   docker build -f docker/server.Dockerfile -t ghcr.io/openbots/server .
#
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

# --- mcp-catalog: the catalog's stdio MCP servers, from their lockfile -------
# packages/mcp runs these binaries instead of `npx`, so nothing is downloaded
# at run time (S-20). Pure JavaScript, no install scripts: the same lockfile
# serves every platform.
FROM ${NODE_IMAGE} AS mcp-catalog
WORKDIR /opt/openbots/mcp
COPY docker/mcp-catalog/package.json docker/mcp-catalog/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

# --- fetch: the store from the lockfile alone, cached until it changes --------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --store-dir /pnpm-store

# --- build: every workspace dependency, then the server and the web app -------
FROM fetch AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm-store \
    && pnpm exec turbo run build --filter=@openbots/server --filter=@openbots/web
# Gather each package's dist/ under /out, keeping the workspace layout.
RUN mkdir /out && for dist in apps/*/dist packages/*/dist; do \
      mkdir -p "/out/$(dirname "$dist")" && cp -r "$dist" "/out/$dist"; \
    done
# docker-compose.dev.yml runs this stage, so it gets the catalog servers too.
COPY --from=mcp-catalog /opt/openbots/mcp /opt/openbots/mcp

# --- prod-deps: production dependencies of the server and its packages -------
# The self-hosted image holds no ee/ code (the managed image is
# ee/server/Dockerfile), so the directory goes once the install is done.
FROM fetch AS prod-deps
COPY . .
RUN pnpm install --prod --frozen-lockfile --offline --filter "@openbots/server..." --store-dir /pnpm-store \
    && rm -rf ee

# --- runtime -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    OPENBOTS_ROLE=all \
    PORT=3000 \
    OPENBOTS_FILES_DIR=/data/files
WORKDIR /app
COPY --from=prod-deps /app /app
# apps/server serves apps/web/dist (WEB_DIST in apps/server/src/app.ts).
COPY --from=build /out /app
# Owned by root: the `node` and `nobody` users can run it but not change it.
COPY --from=mcp-catalog /opt/openbots/mcp /opt/openbots/mcp
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/openbots
# 1000 is the `node` user of the official Node images.
RUN mkdir -p /data/files && chown 1000:1000 /data/files
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["openbots"]
CMD ["start"]
