# Contributing to OpenBots

Thank you for helping. This page is the short version of how the repository works; the
[README](../README.md#development) covers setting up a development machine, and
[PRD.md](PRD.md) and [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md) say what OpenBots is and how it is
built. Self-hosting is documented in the README too.

## Before you open a pull request

Run what CI runs (`.github/workflows/ci.yml`):

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

If you change an API route, regenerate the OpenAPI document and the client and commit the result:

```sh
pnpm --filter @openbots/server openapi
pnpm exec prettier --write packages/api-client/openapi.json
pnpm --filter @openbots/api-client generate
```

## What a change includes

- Tests for every change in behaviour, next to the code (`*.test.ts`). Server tests run on an
  in-memory PGlite database, so they need no Docker, Redis or provider key.
- The docs it affects: the README for anything an operator sees, `.env.example` for a new setting,
  and the rows of [TRACEABILITY.md](TRACEABILITY.md) for the PRD requirements it touches.
- Code that matches its neighbours. Read the module you change and follow its style.

## Writing

User-facing text (the web app, the Mac app, the docs) uses plain sentences. Do not use em or en
dashes, or a hyphen as a pause: write two sentences, or use a comma, a colon or parentheses.

## Commits

Small commits, each one logical change. The subject is an imperative sentence in sentence case,
with the PRD IDs it touches in parentheses, for example
`Open Bot to Bot notifications in that chat under the Bot (N1, N2)`. The body says why.

## Releases

Releases are tag driven. One `v<version>` tag publishes the server, computer and sandbox firewall
images, builds the Mac app and makes a GitHub Release with the DMG, the compose bundle and the
image archives (`.github/workflows/release.yml`). Bump the version first with
`pnpm release:bump <version>`: the tag must match it. See
[apps/desktop/RELEASING.md](../apps/desktop/RELEASING.md) for the steps.
