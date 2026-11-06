# Contributing to OpenBots

Thank you for helping. This page is the short version of how the repository works; the
[README](../README.md#development) covers setting up a development machine, and
[PRD.md](PRD.md) and [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md) say what OpenBots is and how it is
built. Self-hosting is documented in the README too.

## Before you open a pull request

Run the full local checks (`.github/workflows/ci.yml` selects affected checks in CI):

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

## CI scope and build reuse

CI runs on pull requests and pushes to `main`, not on a nightly schedule. The small
**Select affected checks** job compares changed paths against the merge-base using
`scripts/ci-scope.mjs`. Deleted and renamed paths count too.

- Mobile-only changes run **iOS unit tests and bundle**. General workspace checks exclude
  mobile lint, typechecking, tests and builds so these do not run twice.
- Desktop changes run general workspace checks without database, browser or container jobs.
- Server changes also run real-Postgres tests, browser tests and image/lifecycle smoke tests.
- Web changes run browser and image/lifecycle tests, but not the server's Postgres suite.
- Relay changes run workspace and image checks. Docker/Compose/backup changes run the
  relevant container checks.
- Shared packages, the lockfile, CI configuration and unknown code paths conservatively run
  the full suite. Documentation-only changes skip compilation and integration runners.

The general check job builds the non-mobile workspace once. When browser tests are selected,
it uploads the compiled `apps/*/dist`, `packages/*/dist` and `ee/*/dist` directories as
**browser-test-build**. Every Playwright shard downloads those same files rather than
rebuilding the workspace. This is a temporary CI artifact, retained for one day, not a GitHub
Release asset or an installer. Each shard still gets a fresh Postgres/Redis environment.

**CI result** always runs and fails if any selected job fails or is cancelled. It accepts
intentionally skipped jobs. Use this aggregate check for branch protection rather than
requiring every optional integration job individually.

Release packaging and publication do not run on PRs. Version-tag pushes run the full release
pipelines, including the iOS EAS build and TestFlight submission when credentials are set.
There is no manual, untagged iOS release workflow; local builds remain available.

## What a change includes

- Tests for every change in behaviour, next to the code (`*.test.ts`). Server tests run on an
  in-memory PGlite database, so they need no Docker, Redis or provider key.
- For a change to queries, transactions or workers, run the server tests on real Postgres too, as
  CI does (the `server-postgres` job). PGlite runs one query at a time, so a test can pass there
  and still race on a real server. Set `DATABASE_URL` to a Postgres with pgvector whose user may
  create databases; each test app then gets its own database, copied from a migrated template
  (`apps/server/src/db/test-db.ts`):

  ```sh
  docker run -d --rm --name openbots-test-pg -p 55432:5432 \
    -e POSTGRES_USER=openbots -e POSTGRES_PASSWORD=openbots -e POSTGRES_DB=openbots \
    pgvector/pgvector:pg16
  DATABASE_URL=postgres://openbots:openbots@127.0.0.1:55432/openbots \
    pnpm turbo run test --filter @openbots/server
  docker rm -f openbots-test-pg
  ```

  A `DATABASE_URL` left in your shell (from `scripts/dev.sh`, say) does the same, against that
  server. Postgres needs CPU of its own beside the test workers, so on a busy machine fewer
  workers keep tests clear of their 5 second timeout: add `-- --maxWorkers=4`.

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
image archives (`.github/workflows/release.yml`). CI derives the release version from the tag
and stamps the build checkouts automatically. No package-version bump commit is required. See
[apps/desktop/RELEASING.md](../apps/desktop/RELEASING.md) for the steps.
